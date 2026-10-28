"""Outbound HTTP calls (httpx, requests, aiohttp). Matched to other services' routes when merging."""

from __future__ import annotations

import ast
import re

from ..astutil import attr_chain, const_str, env_lookup, kwarg, short, template
from ..context import Detector, ScanContext
from ..project import Scope

VERBS = {"get", "post", "put", "patch", "delete", "head", "options", "request", "stream"}
HTTP_LIBS = ("httpx", "requests", "aiohttp", "urllib3")
CLIENT_HINT = re.compile(r"(client|session|http)", re.I)


class HttpClientDetector(Detector):
    name = "http"

    def _lib(self, scope: Scope, expr: ast.AST | None) -> bool:
        qual = scope.project.qualify_in(expr, scope.mod, scope.imports) if expr is not None else None
        return bool(qual) and qual.split(".")[0] in HTTP_LIBS

    def _client(self, scope: Scope, receiver: ast.AST) -> tuple[bool, str]:
        """(is an HTTP client, base_url template) for the object a verb is called on."""
        if self._lib(scope, receiver):
            return True, ""
        chain = attr_chain(receiver)
        if not chain:
            return False, ""
        name = chain[-1]
        if len(chain) == 1:
            for value in scope.assigns.get(name, []):
                if isinstance(value, ast.Call) and self._lib(scope, value.func):
                    return True, template(kwarg(value, "base_url")) or ""
            ann = scope.annotations.get(name)
            if ann is not None and any(self._lib(scope, n) for n in ast.walk(ann) if isinstance(n, (ast.Name, ast.Attribute))):
                return True, ""
        return bool(CLIENT_HINT.search(name)), ""

    def _hole(self, scope: Scope, expr: ast.AST, depth: int) -> str:
        """Render an f-string hole: a resolvable constant / env default, else ``{name}`` as a hint."""
        for value in scope.values_of(expr):
            if (s := const_str(value)) is not None:
                return s
            env = env_lookup(value)
            if env:
                return env[1] if env[1] and env[1].startswith("http") else "{" + (env[0] or "env") + "}"
            if depth < 2 and value is not expr and (inner := self._render(scope, value, depth + 1)):
                return inner
        chain = attr_chain(expr)
        return "{" + (".".join(chain) if chain else short(expr, 40)) + "}"

    def _render(self, scope: Scope, expr: ast.AST | None, depth: int = 0) -> str | None:
        if expr is None:
            return None
        if (s := const_str(expr)) is not None:
            return s
        if isinstance(expr, ast.JoinedStr):
            return "".join(
                str(v.value) if isinstance(v, ast.Constant) else self._hole(scope, v.value, depth)
                for v in expr.values
            )
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            left = self._render(scope, expr.left, depth + 1) or self._hole(scope, expr.left, depth)
            right = self._render(scope, expr.right, depth + 1) or self._hole(scope, expr.right, depth)
            return left + right
        if isinstance(expr, ast.Name) and depth < 2:
            for value in scope.values_of(expr):
                if value is not expr and (url := self._render(scope, value, depth + 1)):
                    return url
        return None

    def _url(self, scope: Scope, expr: ast.AST | None) -> str | None:
        return self._render(scope, expr)

    def analyze(self, ctx: ScanContext, scope: Scope) -> None:
        fn = scope.fn
        for call in scope.calls:
            func = call.func
            if not isinstance(func, ast.Attribute) or func.attr not in VERBS:
                continue
            is_client, base = self._client(scope, func.value)
            if not is_client:
                continue
            if func.attr in ("request", "stream"):
                method = (call.args[0].value if call.args and isinstance(call.args[0], ast.Constant) else "GET")
                url_expr = kwarg(call, "url") or (call.args[1] if len(call.args) > 1 else None)
            else:
                method = func.attr
                url_expr = kwarg(call, "url") or (call.args[0] if call.args else None)
            url = self._url(scope, url_expr)
            if url is None:
                continue
            url = base + url if base and not url.startswith("http") else url
            if not ("/" in url or url.startswith("{")):
                continue
            ctx.graph.http_calls.append({
                "from": fn.id, "method": str(method).upper(), "url": url, "file": fn.path, "line": call.lineno,
            })
