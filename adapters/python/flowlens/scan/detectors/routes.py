"""HTTP entry points: FastAPI / Starlette routers and Flask / Quart blueprints, with mounted prefixes."""

from __future__ import annotations

import ast
import re

from ..astutil import const_str, const_strs, kwarg, last_name
from ..context import Detector, ScanContext
from ..project import FunctionInfo, ModuleInfo

HTTP_VERBS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
ROUTE_DECORATORS = HTTP_VERBS | {"route", "api_route", "websocket"}
# constructor name -> keyword that carries the router's own prefix
ROUTER_CTORS = {
    "APIRouter": "prefix", "FastAPI": None, "Starlette": None,
    "Blueprint": "url_prefix", "APIBlueprint": "url_prefix", "Flask": None, "Quart": None,
}
# mount call -> keyword that carries the mount prefix
MOUNT_CALLS = {"include_router": "prefix", "register_blueprint": "url_prefix"}


def join_path(*parts: str) -> str:
    path = re.sub(r"/{2,}", "/", "".join(p for p in parts if p))
    if not path.startswith("/"):
        path = "/" + path
    return path


class RoutesDetector(Detector):
    name = "routes"

    def __init__(self) -> None:
        self.routers: dict[str, str] = {}
        self.mounts: dict[str, tuple[str, str]] = {}
        self.pending: list[tuple[str | None, list[str], str, FunctionInfo, int]] = []

    def index(self, ctx: ScanContext, mod: ModuleInfo) -> None:
        project = ctx.project
        for node in ast.walk(mod.tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Call):
                ctor = last_name(node.value.func)
                if ctor not in ROUTER_CTORS:
                    continue
                prefix_kw = ROUTER_CTORS[ctor]
                prefix = const_str(kwarg(node.value, prefix_kw)) if prefix_kw else ""
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        self.routers[f"{mod.name}.{target.id}"] = prefix or ""
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in MOUNT_CALLS:
                if not node.args:
                    continue
                parent = project.qualify_in(node.func.value, mod, mod.all_imports)
                child = project.qualify_in(node.args[0], mod, mod.all_imports)
                if parent and child:
                    prefix = const_str(kwarg(node, MOUNT_CALLS[node.func.attr])) or ""
                    self.mounts.setdefault(project.canonical(child), (project.canonical(parent), prefix))

        for fn in mod.functions:
            for dec in fn.node.decorator_list:
                if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
                    continue
                verb = dec.func.attr
                if verb not in ROUTE_DECORATORS:
                    continue
                path = const_str(dec.args[0] if dec.args else kwarg(dec, "path", "rule"))
                if path is None:
                    continue
                router = project.qualify_in(dec.func.value, mod, mod.imports)
                router = project.canonical(router) if router else None
                if router not in self.routers and not (path == "" or path.startswith("/")):
                    continue
                if verb in HTTP_VERBS:
                    methods = [verb.upper()]
                elif verb == "websocket":
                    methods = ["WS"]
                else:
                    methods = [m.upper() for m in const_strs(kwarg(dec, "methods"))] or ["GET"]
                self.pending.append((router, methods, path, fn, dec.lineno))

    def _prefix(self, router: str | None, seen: tuple[str, ...] = ()) -> str:
        if router is None:
            return ""
        own = self.routers.get(router, "")
        if router in self.mounts and router not in seen:
            parent, mount_prefix = self.mounts[router]
            return self._prefix(parent, (*seen, router)) + mount_prefix + own
        return own

    def after_index(self, ctx: ScanContext) -> None:
        for router, methods, path, fn, line in self.pending:
            full = join_path(self._prefix(router), path)
            for method in methods:
                node_id = f"route:{ctx.service}:{method} {full}"
                ctx.graph.add_node(
                    node_id, "route", f"{method} {full}", service=ctx.service,
                    method=method, path=full, file=fn.path, line=line, handler=fn.id,
                )
                ctx.graph.add_edge(node_id, fn.id, "handles", fn.path, line)
