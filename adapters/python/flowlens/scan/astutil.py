"""Small AST helpers shared by the project index and detectors."""

from __future__ import annotations

import ast
from typing import Iterator


def attr_chain(expr: ast.AST | None) -> list[str] | None:
    """``a.b.c`` -> ``["a", "b", "c"]``; anything that is not a plain dotted name -> None."""
    parts: list[str] = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if isinstance(expr, ast.Name):
        parts.append(expr.id)
        return parts[::-1]
    return None


def last_name(expr: ast.AST | None) -> str | None:
    """Final identifier of a call target: ``foo`` for ``foo(...)`` and ``x.y.foo(...)``."""
    if isinstance(expr, ast.Attribute):
        return expr.attr
    if isinstance(expr, ast.Name):
        return expr.id
    return None


def receiver_name(expr: ast.AST | None) -> str | None:
    """Name of the object a method is called on: ``client`` for ``client.get`` and ``self._client.get``."""
    if isinstance(expr, ast.Attribute):
        return last_name(expr.value)
    return None


def kwarg(call: ast.Call, *names: str) -> ast.expr | None:
    for kw in call.keywords:
        if kw.arg in names:
            return kw.value
    return None


def const_str(expr: ast.AST | None) -> str | None:
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        return expr.value
    return None


def const_strs(expr: ast.AST | None) -> list[str]:
    """String constants in a literal str / list / tuple / set."""
    if expr is None:
        return []
    s = const_str(expr)
    if s is not None:
        return [s]
    if isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
        return [v for e in expr.elts if (v := const_str(e)) is not None]
    return []


def env_lookup(expr: ast.AST | None) -> tuple[str | None, str | None] | None:
    """``os.environ.get("NAME", "default")`` / ``os.getenv(...)`` / ``os.environ["NAME"]`` -> (name, default)."""
    if isinstance(expr, ast.Call):
        chain = attr_chain(expr.func) or []
        if chain[-1:] == ["getenv"] or chain[-2:] == ["environ", "get"]:
            name = const_str(expr.args[0]) if expr.args else None
            default = const_str(expr.args[1]) if len(expr.args) > 1 else const_str(kwarg(expr, "default"))
            return name, default
    if isinstance(expr, ast.Subscript) and (attr_chain(expr.value) or [""])[-1] == "environ":
        return const_str(expr.slice), None
    return None


def template(expr: ast.AST | None, placeholder: str | None = None) -> str | None:
    """Render a str constant / f-string / ``"a" + b`` concatenation as a template.

    Formatted parts become ``{expr}`` (or ``placeholder`` when given)."""
    if expr is None:
        return None
    s = const_str(expr)
    if s is not None:
        return s
    if isinstance(expr, ast.JoinedStr):
        out = []
        for v in expr.values:
            if isinstance(v, ast.Constant):
                out.append(str(v.value))
            elif isinstance(v, ast.FormattedValue):
                out.append(placeholder if placeholder is not None else "{" + short(v.value, 60) + "}")
        return "".join(out)
    if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
        left = template(expr.left, placeholder)
        right = template(expr.right, placeholder)
        if left is None and right is None:
            return None
        ph = lambda e: placeholder if placeholder is not None else "{" + short(e, 60) + "}"  # noqa: E731
        return (left if left is not None else ph(expr.left)) + (right if right is not None else ph(expr.right))
    return None


def short(node: ast.AST, limit: int = 80) -> str:
    try:
        text = ast.unparse(node)
    except Exception:  # pragma: no cover - unparse is total on valid trees
        return "?"
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def iter_toplevel(stmts: list[ast.stmt]) -> Iterator[ast.stmt]:
    """Statements at this block level, descending into if/try/with but not into defs."""
    for stmt in stmts:
        yield stmt
        if isinstance(stmt, (ast.If, ast.For, ast.While, ast.AsyncFor)):
            yield from iter_toplevel(stmt.body)
            yield from iter_toplevel(stmt.orelse)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            yield from iter_toplevel(stmt.body)
        elif isinstance(stmt, ast.Try) or type(stmt).__name__ == "TryStar":
            yield from iter_toplevel(stmt.body)  # type: ignore[attr-defined]
            for h in stmt.handlers:  # type: ignore[attr-defined]
                yield from iter_toplevel(h.body)
            yield from iter_toplevel(stmt.orelse)  # type: ignore[attr-defined]
            yield from iter_toplevel(stmt.finalbody)  # type: ignore[attr-defined]


def walk_body(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> Iterator[ast.AST]:
    """Every node in a function body (not its decorators or signature)."""
    for stmt in fn.body:
        yield from ast.walk(stmt)


def docstring_node(body: list[ast.stmt]) -> ast.AST | None:
    if body and isinstance(body[0], ast.Expr) and const_str(body[0].value) is not None:
        return body[0].value
    return None
