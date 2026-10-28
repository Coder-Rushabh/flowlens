"""Function-level tracing of project code.

Two backends:
  * ``monitoring`` — ``sys.monitoring`` (Python 3.12+). Code outside the project is disabled per code
    object after its first call, so library code costs almost nothing.
  * ``profile`` — ``sys.setprofile`` (Python 3.9–3.11). Every call reaches the callback, so expect a
    noticeable slowdown; fine for local debugging.

Each traced call becomes one *span* record when it finishes (arguments in, value out, mutated arguments,
error, timing). Library hooks (see hooks.py) add *events* (SQL, HTTP, publish, storage) to the current span.
"""

from __future__ import annotations

import dis
import itertools
import os
import re
import sys
import threading
from types import CodeType, FrameType
from typing import Any

from .context import Span, current, new_trace_id, now
from .sink import Sink
from .values import Snapshotter

CO_GENERATOR = 0x20
CO_COROUTINE = 0x80
CO_ITERABLE_COROUTINE = 0x100
CO_ASYNC_GENERATOR = 0x200
ASYNC_FLAGS = CO_COROUTINE | CO_ITERABLE_COROUTINE | CO_ASYNC_GENERATOR

SKIP_NAMES = {"<module>", "<lambda>", "<genexpr>", "<listcomp>", "<dictcomp>", "<setcomp>"}
SKIP_SEGMENTS = {"site-packages", "dist-packages", ".venv", "venv", "node_modules", "__pycache__", "tests", "test"}
_YIELD_OPS = {op for name, op in dis.opmap.items() if name in ("YIELD_VALUE", "YIELD_FROM", "SEND")}
_RETURN_OPS = {op for name, op in dis.opmap.items() if name in ("RETURN_VALUE", "RETURN_CONST")}


class UnwoundError(Exception):
    """Placeholder when an exception left a frame but the backend cannot see which (sys.setprofile)."""
_FLOWLENS_DIR = os.path.normcase(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# (node id, display name, file relative to service root, first line, co_flags)
CodeInfo = tuple


class Tracer:
    def __init__(self, service: str, root: str, sink: Sink, snapshot: Snapshotter, exclude: list[str] | None = None):
        self.service = service
        self.root = os.path.abspath(root)
        self._root_norm = os.path.normcase(self.root) + os.sep
        self.sink = sink
        self.snap = snapshot
        self.exclude = [re.compile(fnmatch_to_regex(g)) for g in (exclude or [])]
        self._codes: dict[CodeType, CodeInfo | None] = {}
        self._active: dict[int, tuple[Span, Any]] = {}
        self._seq = itertools.count(1)
        self._local = threading.local()
        self.backend = "off"

    # --------------------------------------------------------------- mapping
    def node_for(self, code: CodeType) -> CodeInfo | None:
        try:
            return self._codes[code]
        except KeyError:
            pass
        info = None
        name = code.co_name
        filename = code.co_filename
        # CO_OPTIMIZED: real functions only (not module or class bodies)
        if name not in SKIP_NAMES and code.co_flags & 0x01 and filename and not filename.startswith("<"):
            path = os.path.normcase(os.path.abspath(filename))
            if path.startswith(self._root_norm) and not path.startswith(_FLOWLENS_DIR) and path.endswith(".py"):
                rel = os.path.relpath(os.path.abspath(filename), self.root).replace("\\", "/")
                segments = rel.split("/")
                if not SKIP_SEGMENTS.intersection(segments[:-1]) and not any(r.match(rel) for r in self.exclude):
                    parts = rel[:-3].split("/")
                    if parts[-1] == "__init__":
                        parts = parts[:-1]
                    qual = getattr(code, "co_qualname", name)
                    node = f"fn:{self.service}:{'.'.join(parts)}.{qual}"
                    info = (node, qual.replace("<locals>.", ""), rel, code.co_firstlineno, code.co_flags)
        self._codes[code] = info
        return info

    # ----------------------------------------------------------- span plumbing
    def busy(self) -> bool:
        return getattr(self._local, "busy", False)

    def _set_busy(self, value: bool) -> None:
        self._local.busy = value

    def _args(self, code: CodeType, frame: FrameType) -> dict[str, Any]:
        n = code.co_argcount + code.co_kwonlyargcount + bool(code.co_flags & 0x04) + bool(code.co_flags & 0x08)
        names = code.co_varnames[:n]
        loc = frame.f_locals
        return {k: loc[k] for k in names if k not in ("self", "cls") and k in loc}

    def enter(self, info: CodeInfo, frame: FrameType, resumed: bool = False) -> None:
        self._set_busy(True)
        try:
            parent = current.get()
            span = Span(parent.trace if parent else new_trace_id(), parent, info[0], info[1], "function")
            span.seq = next(self._seq)
            span.file, span.line = info[2], info[3]
            args = self._args(frame.f_code, frame)
            span.input = self.snap(args)
            if resumed:
                span.input = {"__resumed__": True, **(span.input or {})}
            span.args = {k: v for k, v in args.items() if isinstance(v, (dict, list, set)) or hasattr(v, "__dict__")}
            token = current.set(span)
            self._active[id(frame)] = (span, token)
        finally:
            self._set_busy(False)

    def exit(self, frame: FrameType, value: Any = None, error: BaseException | None = None, status: str = "ok") -> None:
        rec = self._active.pop(id(frame), None)
        if rec is None:
            return
        self._set_busy(True)
        try:
            span, token = rec
            try:
                current.reset(token)
            except (ValueError, RuntimeError):
                current.set(span.parent)  # resumed in another context (e.g. generator driven by a thread pool)
            mutated = None
            if span.args and isinstance(span.input, dict):
                for k, v in span.args.items():
                    after = self.snap(v)
                    if after != span.input.get(k):
                        mutated = mutated or {}
                        mutated[k] = after
            self._emit_span(span, None if error else self.snap(value), error, status, mutated)
        finally:
            self._set_busy(False)

    def _emit_span(self, span: Span, output: Any, error: BaseException | None, status: str, mutated: Any = None) -> None:
        end = now()
        record: dict[str, Any] = {
            "kind": "span", "service": self.service, "trace": span.trace, "span": span.id, "parent": span.parent_id,
            "node": span.node, "name": span.name, "type": span.kind, "start": span.start, "end": end,
            "seq": span.seq, "endSeq": next(self._seq), "input": span.input, "output": output,
            "status": "error" if error else status, "pid": os.getpid(),
        }
        if span.file:
            record["file"], record["line"] = span.file, span.line
        if mutated:
            record["mutated"] = mutated
        if error is not None:
            record["error"] = {"type": type(error).__name__, "message": str(error)[:500]}
        self.sink.put(record)

    # Manual spans, used by hooks for entry points (HTTP requests, consumed messages).
    def start_span(self, node: str, name: str, kind: str, input: Any = None,
                   remote: tuple[str, str] | None = None, root: bool = False) -> tuple[Span, Any]:
        parent = None if root else current.get()
        if parent is not None:
            span = Span(parent.trace, parent, node, name, kind)
        elif remote:
            span = Span(remote[0], None, node, name, kind, parent_id=remote[1])
            span.remote = True
        else:
            span = Span(new_trace_id(), None, node, name, kind)
        span.seq = next(self._seq)
        span.input = input
        return span, current.set(span)

    def end_span(self, span: Span, token: Any, output: Any = None, error: BaseException | None = None) -> None:
        try:
            current.reset(token)
        except (ValueError, RuntimeError):
            current.set(span.parent)
        self._emit_span(span, output, error, "ok")

    def event(self, type: str, op: str, targets: list[dict[str, str]], detail: dict[str, Any],
              start: float, error: BaseException | None = None) -> None:
        span = current.get()
        if span is None:
            return
        record: dict[str, Any] = {
            "kind": "event", "service": self.service, "trace": span.trace, "span": span.id, "type": type,
            "op": op, "targets": targets, "ts": start, "durationMs": round((now() - start) * 1000, 3),
            "seq": next(self._seq), "detail": detail, "pid": os.getpid(),
        }
        if error is not None:
            record["error"] = {"type": type_name(error), "message": str(error)[:500]}
        self.sink.put(record)

    # --------------------------------------------------------------- backends
    def start(self, backend: str = "auto") -> str:
        if backend in ("auto", "monitoring") and hasattr(sys, "monitoring"):
            self._start_monitoring()
        else:
            self._start_profile()
        return self.backend

    def stop(self) -> None:
        if self.backend == "monitoring":
            mon = sys.monitoring
            mon.set_events(self._tool, 0)
            mon.free_tool_id(self._tool)
        elif self.backend == "profile":
            sys.setprofile(None)
            threading.setprofile(None)  # type: ignore[arg-type]
        self.backend = "off"

    def _start_monitoring(self) -> None:
        mon = sys.monitoring
        tool = next((t for t in (mon.PROFILER_ID, 3, 4, 5) if mon.get_tool(t) is None), None)
        if tool is None:
            self._start_profile()
            return
        mon.use_tool_id(tool, "flowlens")
        self._tool = tool
        E = mon.events
        DISABLE = mon.DISABLE
        node_for = self.node_for
        getframe = sys._getframe

        def on_start(code, offset):
            info = node_for(code)
            if info is None:
                return DISABLE
            if not self.busy():
                self.enter(info, getframe(1))

        def on_resume(code, offset):
            info = node_for(code)
            if info is None:
                return DISABLE
            if info[4] & CO_GENERATOR and not info[4] & ASYNC_FLAGS and not self.busy():
                self.enter(info, getframe(1), resumed=True)

        def on_return(code, offset, retval):
            if node_for(code) is None:
                return DISABLE
            self.exit(getframe(1), retval)

        def on_yield(code, offset, retval):
            info = node_for(code)
            if info is None:
                return DISABLE
            if info[4] & CO_GENERATOR and not info[4] & ASYNC_FLAGS:
                self.exit(getframe(1), retval, status="yield")

        def on_unwind(code, offset, exc):
            if node_for(code) is not None:
                self.exit(getframe(1), error=exc)

        mon.register_callback(tool, E.PY_START, on_start)
        mon.register_callback(tool, E.PY_RESUME, on_resume)
        mon.register_callback(tool, E.PY_RETURN, on_return)
        mon.register_callback(tool, E.PY_YIELD, on_yield)
        mon.register_callback(tool, E.PY_UNWIND, on_unwind)
        mon.set_events(tool, E.PY_START | E.PY_RESUME | E.PY_RETURN | E.PY_YIELD | E.PY_UNWIND)
        self.backend = "monitoring"

    def _start_profile(self) -> None:
        node_for = self.node_for
        active = self._active

        def suspended(frame: FrameType) -> bool:
            code = frame.f_code.co_code
            i = frame.f_lasti
            return 0 <= i < len(code) and code[i] in _YIELD_OPS

        def profiler(frame, event, arg):
            if event == "call":
                info = node_for(frame.f_code)
                if info is None or self.busy():
                    return
                if info[4] & ASYNC_FLAGS and id(frame) in active:
                    return  # an await resuming
                self.enter(info, frame, resumed=bool(info[4] & CO_GENERATOR and frame.f_lasti > 0))
            elif event == "return":
                if id(frame) not in active:
                    return
                flags = frame.f_code.co_flags
                if flags & ASYNC_FLAGS and suspended(frame):
                    return  # an await suspending, not a return
                if flags & CO_GENERATOR and not flags & ASYNC_FLAGS and suspended(frame):
                    self.exit(frame, arg, status="yield")
                    return
                code = frame.f_code.co_code
                i = frame.f_lasti
                if arg is None and 0 <= i < len(code) and code[i] not in _RETURN_OPS:
                    # left by an exception; setprofile can't see which one
                    self.exit(frame, error=UnwoundError("exception raised (type available on Python 3.12+)"))
                else:
                    self.exit(frame, arg)

        sys.setprofile(profiler)
        threading.setprofile(profiler)
        self.backend = "profile"


def type_name(exc: BaseException) -> str:
    return type(exc).__name__


def fnmatch_to_regex(glob: str) -> str:
    out, i = [], 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif glob[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(glob[i]))
            i += 1
    return "^" + "".join(out) + "$"
