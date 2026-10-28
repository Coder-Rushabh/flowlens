"""Raw SQL in string literals (text(), cursor.execute(), module-level query constants)."""

from __future__ import annotations

import ast
import re

from ..context import Detector, ScanContext
from ..project import Scope

PH = "__fl__"  # placeholder for f-string holes
IDENT = r'((?:[A-Za-z_"`\[][\w$"`\]]*)(?:\.[A-Za-z_"`\[][\w$"`\]]*)?)'
STARTS = re.compile(r"^\s*(select|with|insert|update|delete|merge|truncate)\b", re.I)
WRITE_PATTERNS = [
    (re.compile(r"\binsert\s+(?:ignore\s+)?into\s+" + IDENT, re.I), "insert"),
    (re.compile(r"\bupdate\s+(?:only\s+)?" + IDENT + r"(?:\s+(?:as\s+)?\w+)?\s+set\b", re.I), "update"),
    (re.compile(r"\bdelete\s+from\s+(?:only\s+)?" + IDENT, re.I), "delete"),
    (re.compile(r"\bmerge\s+into\s+" + IDENT, re.I), "upsert"),
    (re.compile(r"\btruncate\s+(?:table\s+)?" + IDENT, re.I), "delete"),
]
READ_PATTERN = re.compile(r"\b(from|join)\s+" + IDENT + r"(\s*\()?", re.I)
CTE_PATTERN = re.compile(r"(?:^\s*|\bwith\s+(?:recursive\s+)?|,\s*)(\w+)\s+as\s+(?:not\s+)?(?:materialized\s+)?\(", re.I)
FUNC_CONTEXT = re.compile(r"\b(extract|substring|trim|overlay|position)\s*\([^()]*$", re.I)
NOT_TABLES = {
    "select", "lateral", "unnest", "values", "only", "dual", "set", "the", "a", "an", "this", "that", "where",
    "generate_series", "jsonb_array_elements", "jsonb_each", "json_each", "json_array_elements", "jsonb_to_recordset",
}


def _clean(name: str) -> str | None:
    name = name.replace('"', "").replace("`", "").replace("[", "").replace("]", "").lower()
    parts = [p for p in name.split(".") if p]
    if not parts or PH in parts[-1]:
        return None  # the table itself is dynamic: unknown
    parts = [p for p in parts if PH not in p]  # a dynamic schema is dropped
    name = ".".join(parts)
    if name in NOT_TABLES or name.split(".")[-1] in NOT_TABLES or not re.match(r"^[a-z_]", name):
        return None
    return name


def _normalize(text: str) -> str:
    text = re.sub(r"--[^\n]*", " ", text)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return " ".join(text.split())


def cte_names(text: str) -> set[str]:
    return {m.group(1).lower() for m in CTE_PATTERN.finditer(_normalize(text))}


def analyze_sql(text: str, extra_ctes: set[str] | None = None) -> tuple[dict[str, str], set[str]]:
    """Return ({table: write op}, {tables read}) for one SQL string. Empty when it is not SQL.

    ``extra_ctes`` are CTE names defined in sibling strings of the same query (queries split across literals)."""
    text = _normalize(text)
    lowered = text.lower()
    # whole statements, or fragments of a CTE query split across literals
    if not STARTS.match(text) and not re.match(r"^\s*(\w+\s+as\s*\(|\)\s*,)", lowered):
        return {}, set()
    if lowered.startswith(("select", "with")) and " from " not in f" {lowered} ":
        return {}, set()
    writes: dict[str, str] = {}
    for pattern, op in WRITE_PATTERNS:
        for m in pattern.finditer(text):
            name = _clean(m.group(1))
            if name:
                writes.setdefault(name, op)
    ctes = cte_names(text) | (extra_ctes or set())
    reads: set[str] = set()
    for m in READ_PATTERN.finditer(text):
        if m.group(3):  # from some_function(...)
            continue
        before = lowered[: m.start()].rstrip()
        if m.group(1).lower() == "from" and (before.endswith("delete") or before.endswith("distinct")):
            continue
        if FUNC_CONTEXT.search(lowered[max(0, m.start() - 80): m.start()]):
            continue
        name = _clean(m.group(2))
        if name and name not in ctes:
            reads.add(name)
    return writes, reads


class SqlDetector(Detector):
    name = "sql"

    def analyze(self, ctx: ScanContext, scope: Scope) -> None:
        fn = scope.fn
        candidates = list(scope.strings)
        for name, line in scope.names_loaded.items():
            if scope.is_local(name):
                continue
            qual = scope.qualify(ast.Name(id=name, ctx=ast.Load()))
            value = scope.project.module_value(qual) if qual else None
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                candidates.append((value.value, line))
        ctes: set[str] = set()
        for text, _ in candidates:
            ctes |= cte_names(text)
        for text, line in candidates:
            if len(text) < 12:
                continue
            writes, reads = analyze_sql(text, ctes)
            for table, op in writes.items():
                ctx.graph.add_edge(fn.id, ctx.table(table), "writes", fn.path, line, op)
            for table in reads:
                ctx.graph.add_edge(ctx.table(table), fn.id, "reads", fn.path, line, "select")
