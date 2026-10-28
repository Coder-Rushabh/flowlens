"""Turn live Python values into small, JSON-safe, redacted snapshots.

Never calls user code: no repr(), no properties, no __iter__ on unknown types. Only plain containers,
well-known value types and an object's own ``__dict__`` / ``__slots__`` are walked.
"""

from __future__ import annotations

import datetime as _dt
import decimal
import enum
import os
import re
import sys
import uuid
from typing import Any

DEFAULT_REDACT = r"pass(word|wd)?|secret|token|authorization|api[_-]?key|cookie|credential|private[_-]?key"


class Snapshotter:
    def __init__(self, redact: str = DEFAULT_REDACT, max_depth: int = 4, max_items: int = 25, max_str: int = 400,
                 project_root: str | None = None):
        self.redact = re.compile(redact, re.I) if redact else None
        self.max_depth = max_depth
        self.max_items = max_items
        self.max_str = max_str
        self.project_root = os.path.normcase(os.path.abspath(project_root)) + os.sep if project_root else None
        self._expand: dict[type, bool] = {}

    def expandable(self, cls: type) -> bool:
        """Data-shaped objects are expanded; library internals (connections, clients…) are not."""
        try:
            return self._expand[cls]
        except KeyError:
            pass
        ok = (
            hasattr(cls, "__dataclass_fields__")
            or hasattr(cls, "model_fields")  # pydantic v2
            or hasattr(cls, "__fields__") and hasattr(cls, "__config__")  # pydantic v1
            or hasattr(cls, "__mapper__")  # SQLAlchemy ORM rows
            or hasattr(cls, "_meta") and hasattr(cls, "objects")  # Django models
            or cls.__module__ in ("types", "argparse") and cls.__name__ in ("SimpleNamespace", "Namespace")
        )
        if not ok and self.project_root:
            mod = sys.modules.get(cls.__module__)
            path = getattr(mod, "__file__", None)
            ok = bool(path) and os.path.normcase(os.path.abspath(path)).startswith(self.project_root)
        self._expand[cls] = ok
        return ok

    def secret(self, key: Any) -> bool:
        return bool(self.redact and isinstance(key, str) and self.redact.search(key))

    def __call__(self, value: Any, depth: int = 0) -> Any:
        if value is None or isinstance(value, (bool, int)):
            return value
        if isinstance(value, float):
            return value if value == value and value not in (float("inf"), float("-inf")) else str(value)
        if isinstance(value, str):
            return value if len(value) <= self.max_str else value[: self.max_str] + f"…(+{len(value) - self.max_str})"
        if isinstance(value, (bytes, bytearray, memoryview)):
            return f"<{len(value)} bytes>"
        if isinstance(value, enum.Enum):
            return self(value.value, depth)
        if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
            return value.isoformat()
        if isinstance(value, _dt.timedelta):
            return f"{value.total_seconds()}s"
        if isinstance(value, (decimal.Decimal, uuid.UUID)):
            return str(value)
        if depth >= self.max_depth:
            return f"<{type(value).__name__}>"
        if isinstance(value, dict):
            out = {}
            for i, (k, v) in enumerate(value.items()):
                if i >= self.max_items:
                    out["…"] = f"+{len(value) - self.max_items} more"
                    break
                key = k if isinstance(k, str) else str(self(k, self.max_depth))
                out[key] = "***" if self.secret(key) else self(v, depth + 1)
            return out
        if isinstance(value, (list, tuple, set, frozenset)):
            items = list(value) if not isinstance(value, (set, frozenset)) else list(value)[: self.max_items]
            out_list = [self(v, depth + 1) for v in items[: self.max_items]]
            if len(value) > self.max_items:
                out_list.append(f"…+{len(value) - self.max_items} more")
            return out_list
        return self._object(value, depth)

    def _object(self, value: Any, depth: int) -> Any:
        cls = type(value)
        name = cls.__qualname__
        if not self.expandable(cls):
            return f"<{cls.__module__.split('.')[0]}.{name}>" if cls.__module__ != "builtins" else f"<{name}>"
        fields: dict[str, Any] | None = None
        try:
            d = object.__getattribute__(value, "__dict__")
            if isinstance(d, dict):
                fields = {k: v for k, v in d.items() if not k.startswith("_")}
        except AttributeError:
            pass
        if fields is None:
            slots = [s for c in cls.__mro__ for s in getattr(c, "__slots__", ()) if isinstance(s, str)]
            if slots:
                fields = {}
                for s in slots:
                    if s.startswith("_"):
                        continue
                    try:
                        fields[s] = object.__getattribute__(value, s)
                    except AttributeError:
                        pass
        if not fields:
            return f"<{name}>"
        snap = self(fields, depth)
        if isinstance(snap, dict):
            snap = {"__type__": name, **snap}
        return snap
