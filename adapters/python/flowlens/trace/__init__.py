"""FlowLens runtime tracer.

Start it in one of three ways:
  * ``python -m flowlens.trace -m uvicorn app.main:app``  (wraps any module or script)
  * put ``adapters/python/bootstrap`` and ``adapters/python`` on PYTHONPATH and set FLOWLENS_TRACE=1
    (no code changes; works in containers)
  * ``import flowlens.trace; flowlens.trace.install()`` at the top of your entry point

Configuration (environment, or keyword arguments to ``install``):
  FLOWLENS_SERVICE    service name; must match the name in flowlens.yaml (default: root folder name)
  FLOWLENS_ROOT       service root that module names are computed from (default: current directory)
  FLOWLENS_COLLECTOR  collector base URL (default http://127.0.0.1:4870; empty string disables)
  FLOWLENS_OUT        also append records to this JSONL file
  FLOWLENS_REDACT     regex of keys whose values are masked
  FLOWLENS_BACKEND    auto | monitoring | profile
  FLOWLENS_EXCLUDE    comma-separated globs (relative to root) not to trace
  FLOWLENS_HOOKS_OFF  comma-separated libraries not to hook (sqlalchemy, httpx, aio_pika, ...)
"""

from __future__ import annotations

import os
import sys
from typing import Any

from .context import current
from .sink import Sink
from .tracer import Tracer
from .values import DEFAULT_REDACT, Snapshotter

_tracer: Tracer | None = None


def install(**options: Any) -> Tracer:
    """Start tracing this process. Idempotent."""
    global _tracer
    if _tracer is not None:
        return _tracer

    def opt(name: str, default: Any = None) -> Any:
        return options.get(name.lower(), os.environ.get(f"FLOWLENS_{name}", default))

    root = os.path.abspath(opt("ROOT") or os.getcwd())
    service = opt("SERVICE") or os.path.basename(root)
    collector = opt("COLLECTOR", "http://127.0.0.1:4870")
    sink = Sink(collector or None, opt("OUT"))
    tracer = Tracer(
        service, root, sink, Snapshotter(opt("REDACT") or DEFAULT_REDACT, project_root=root),
        exclude=[g for g in str(opt("EXCLUDE") or "").split(",") if g],
    )
    from .hooks import install_hooks

    install_hooks(tracer, {h.strip() for h in str(opt("HOOKS_OFF") or "").split(",") if h.strip()})
    backend = tracer.start(opt("BACKEND", "auto"))
    _tracer = tracer
    if not opt("QUIET"):
        print(f"[flowlens] tracing service={service} root={root} backend={backend} -> {collector or opt('OUT')}", file=sys.stderr)
    return tracer


def uninstall() -> None:
    global _tracer
    if _tracer is not None:
        _tracer.stop()
        _tracer.sink.close()
        _tracer = None


def current_trace_id() -> str | None:
    span = current.get()
    return span.trace if span else None


__all__ = ["install", "uninstall", "current_trace_id"]
