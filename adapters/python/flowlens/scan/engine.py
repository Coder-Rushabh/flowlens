"""Run one service scan: index, resolve calls, apply detectors, emit a partial graph."""

from __future__ import annotations

import ast
import importlib
import importlib.util
import os
import time
from typing import Any

from .astutil import attr_chain, const_str, last_name
from .context import Detector, ScanContext
from .detectors import BUILTIN
from .model import Graph
from .project import FunctionInfo, ModuleInfo, Project, Scope

# test_*.py / *_test.py outside test folders are only skipped when they contain tests (see Project.load):
# names like `test_attempts.py` are often real application modules.
DEFAULT_EXCLUDE = [
    "**/tests/**", "**/test/**", "**/conftest.py", "**/alembic/versions/**", "**/migrations/**",
]


def _main_entries(ctx: ScanContext, mod: ModuleInfo) -> None:
    """``if __name__ == "__main__":`` blocks become entry points (workers, CLIs, scripts)."""
    for stmt in mod.tree.body:
        if not isinstance(stmt, ast.If):
            continue
        test = stmt.test
        if not (isinstance(test, ast.Compare) and isinstance(test.left, ast.Name) and test.left.id == "__name__"
                and any(const_str(c) == "__main__" for c in test.comparators)):
            continue
        entry = None
        for node in (n for s in stmt.body for n in ast.walk(s)):
            if not isinstance(node, ast.Call):
                continue
            target = ctx.project.resolve(ctx.project.qualify_in(node.func, mod, mod.all_imports))
            if not isinstance(target, FunctionInfo):
                continue
            if entry is None:
                entry = ctx.entry(f"main:{mod.name}", f"python -m {mod.name}", "main", None, stmt.lineno)
                ctx.graph.nodes[entry]["file"] = mod.path
            ctx.graph.add_edge(entry, target.id, "handles", mod.path, node.lineno)


def _scheduled_jobs(ctx: ScanContext, scope: Scope) -> None:
    """APScheduler-style ``scheduler.add_job(func, ...)`` registrations."""
    for call in scope.calls:
        if last_name(call.func) not in ("add_job", "schedule_job") or not call.args:
            continue
        chain = attr_chain(call.args[0])
        target = scope.resolve(call.args[0]) if chain else None
        if isinstance(target, FunctionInfo):
            entry = ctx.entry(f"job:{target.qualname}", f"job {target.display}", "schedule", scope.fn, call.lineno)
            ctx.graph.add_edge(entry, target.id, "handles", scope.fn.path, call.lineno)


def load_plugin(spec: str, repo_root: str) -> type[Detector]:
    """``path/to/file.py:ClassName`` (relative to the repo root) or ``package.module:ClassName``."""
    target, _, attr = spec.rpartition(":")
    if not target or not attr:
        raise ValueError("expected 'file.py:ClassName' or 'module:ClassName'")
    if target.endswith(".py"):
        path = os.path.join(repo_root, target)
        spec_ = importlib.util.spec_from_file_location(f"flowlens_plugin_{abs(hash(path))}", path)
        if spec_ is None or spec_.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec_)
        spec_.loader.exec_module(module)
    else:
        module = importlib.import_module(target)
    cls = getattr(module, attr)
    if not (isinstance(cls, type) and issubclass(cls, Detector)):
        raise TypeError(f"{attr} is not a flowlens.scan.context.Detector subclass")
    return cls


def scan(config: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    service = config["service"]
    exclude = list(config.get("exclude") or []) + ([] if config.get("noDefaultExclude") else DEFAULT_EXCLUDE)
    project = Project(service, config["root"], config.get("repoRoot") or config["root"], config.get("include") or [], exclude)
    project.load()

    graph = Graph()
    options = config.get("detectors") or {}
    ctx = ScanContext(project, graph, options)
    disabled = {name for name, opts in options.items() if isinstance(opts, dict) and opts.get("enabled") is False}
    detectors = [cls() for name, cls in BUILTIN.items() if name not in disabled]
    for spec in options.get("plugins") or []:
        try:
            detectors.append(load_plugin(spec, config.get("repoRoot") or config["root"])())
        except Exception as exc:  # a broken plugin must not stop the scan
            graph.warnings.append(f"plugin {spec}: {exc.__class__.__name__}: {exc}")

    for mod in project.modules.values():
        for d in detectors:
            d.index(ctx, mod)
    for d in detectors:
        d.after_index(ctx)

    for fn in project.functions:
        ctx.function_node(fn)
    for fn in project.functions:
        scope = Scope(project, fn)
        for call in scope.calls:
            callee = scope.resolve_callee(call)
            if callee is not None:
                graph.add_edge(fn.id, callee.id, "calls", fn.path, call.lineno)
        _scheduled_jobs(ctx, scope)
        for d in detectors:
            d.analyze(ctx, scope)
    for mod in project.modules.values():
        _main_entries(ctx, mod)
    for d in detectors:
        d.finish(ctx)

    graph.warnings.extend(project.warnings)
    out = graph.to_json()
    out["service"] = {
        "name": service,
        "language": "python",
        "root": config.get("rootRel") or config["root"],
        "stats": {
            "modules": len(project.modules),
            "functions": len(project.functions),
            "nodes": len(graph.nodes),
            "edges": len(graph.edges),
            "ms": round((time.perf_counter() - started) * 1000),
        },
    }
    return out
