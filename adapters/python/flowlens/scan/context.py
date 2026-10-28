"""Shared state handed to every detector during a scan."""

from __future__ import annotations

import ast
from typing import Any

from .astutil import const_str, docstring_node, short
from .model import Graph
from .project import FunctionInfo, Project, Scope


class ScanContext:
    def __init__(self, project: Project, graph: Graph, options: dict[str, Any]):
        self.project = project
        self.graph = graph
        self.service = project.service
        self.options = options

    def option(self, detector: str, key: str, default: Any = None) -> Any:
        return (self.options.get(detector) or {}).get(key, default)

    # ----------------------------------------------------------- node helpers
    def function_node(self, fn: FunctionInfo) -> str:
        node = fn.node
        doc = docstring_node(node.body)
        doc_line = None
        if doc is not None:
            text = (const_str(doc) or "").strip()
            doc_line = text.splitlines()[0][:160] if text else None
        params = [a.arg for a in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]]
        if fn.cls is not None and params and params[0] in ("self", "cls"):
            params = params[1:]
        self.graph.add_node(
            fn.id,
            "function",
            fn.display,
            service=self.service,
            module=fn.module.name,
            qualname=fn.qualname,
            cls=fn.cls.name if fn.cls else None,
            file=fn.path,
            line=node.lineno,
            endLine=getattr(node, "end_lineno", None),
            isAsync=isinstance(node, ast.AsyncFunctionDef) or None,
            params=params,
            returns=short(node.returns, 60) if node.returns is not None else None,
            decorators=[short(d, 80) for d in node.decorator_list][:4],
            doc=doc_line,
        )
        return fn.id

    def table(self, name: str) -> str:
        name = name.strip().strip('"`[]').lower()
        schema, _, table = name.rpartition(".")
        node_id = f"table:{name}"
        self.graph.add_node(node_id, "table", name, schema=schema or None, table=table)
        return node_id

    def topic(self, key: str, transport: str | None = None) -> str:
        node_id = f"topic:{key}"
        self.graph.add_node(node_id, "topic", key, transport=transport, pattern=("*" in key or "#" in key) or None)
        return node_id

    def bucket(self, name: str) -> str:
        node_id = f"bucket:{name}"
        self.graph.add_node(node_id, "bucket", name)
        return node_id

    def entry(self, key: str, name: str, trigger: str, fn: FunctionInfo | None, line: int | None) -> str:
        node_id = f"entry:{self.service}:{key}"
        self.graph.add_node(
            node_id, "entry", name, service=self.service, trigger=trigger,
            file=fn.path if fn else None, line=line,
        )
        return node_id


class Detector:
    """A framework plugin. Detectors translate framework idioms into sources, sinks and data edges.

    Lifecycle per service: ``index`` every module, ``after_index`` once, ``analyze`` every
    function body, then ``finish`` once.
    """

    name = "detector"

    def index(self, ctx: ScanContext, mod) -> None:  # noqa: B027 - optional hook
        pass

    def after_index(self, ctx: ScanContext) -> None:  # noqa: B027
        pass

    def analyze(self, ctx: ScanContext, scope: Scope) -> None:  # noqa: B027
        pass

    def finish(self, ctx: ScanContext) -> None:  # noqa: B027
        pass
