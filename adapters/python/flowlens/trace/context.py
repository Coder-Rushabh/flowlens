"""Span ids, the current-span context variable and W3C traceparent helpers."""

from __future__ import annotations

import contextvars
import os
import re
import time
from typing import Any

_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")

# A high-resolution wall clock: monotonic within the process, comparable across processes on one host.
_WALL0 = time.time()
_PERF0 = time.perf_counter()


def now() -> float:
    return _WALL0 + (time.perf_counter() - _PERF0)


def new_trace_id() -> str:
    return os.urandom(16).hex()


def new_span_id() -> str:
    return os.urandom(8).hex()


class Span:
    __slots__ = (
        "trace", "id", "parent_id", "parent", "node", "name", "kind", "start", "seq",
        "input", "args", "file", "line", "remote",
    )

    def __init__(self, trace: str, parent: "Span | None", node: str, name: str, kind: str,
                 parent_id: str | None = None):
        self.trace = trace
        self.id = new_span_id()
        self.parent = parent
        self.parent_id = parent.id if parent is not None else parent_id
        self.node = node
        self.name = name
        self.kind = kind
        self.start = now()
        self.seq = 0
        self.input: Any = None
        self.args: dict[str, Any] | None = None  # live argument objects, for mutation diffs
        self.file: str | None = None
        self.line: int | None = None
        self.remote = False

    def traceparent(self) -> str:
        return f"00-{self.trace}-{self.id}-01"


current: contextvars.ContextVar[Span | None] = contextvars.ContextVar("flowlens_span", default=None)


def parse_traceparent(value: Any) -> tuple[str, str] | None:
    if isinstance(value, bytes):
        value = value.decode("latin-1", "replace")
    if not isinstance(value, str):
        return None
    m = _TRACEPARENT.match(value.strip().lower())
    return (m.group(1), m.group(2)) if m else None
