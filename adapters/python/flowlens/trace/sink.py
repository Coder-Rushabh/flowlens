"""Ship records to the FlowLens collector (HTTP) and/or a JSONL file, off the hot path."""

from __future__ import annotations

import atexit
import json
import queue
import sys
import threading
import urllib.request
from typing import Any

MAX_RECORD_BYTES = 48_000


def _dumps(record: dict[str, Any]) -> str:
    text = json.dumps(record, default=str, separators=(",", ":"))
    if len(text) > MAX_RECORD_BYTES:
        for key in ("input", "output", "mutated", "detail"):
            if key in record:
                record[key] = {"__truncated__": f"{len(text)} bytes"}
        text = json.dumps(record, default=str, separators=(",", ":"))
    return text


class Sink:
    def __init__(self, collector: str | None, out_file: str | None, flush_interval: float = 0.25, batch: int = 300):
        self.collector = collector.rstrip("/") + "/api/events" if collector else None
        self.out_file = out_file
        self.queue: queue.SimpleQueue[dict[str, Any] | None] = queue.SimpleQueue()
        self.flush_interval = flush_interval
        self.batch = batch
        self.dropped = 0
        self._warned = False
        self._thread = threading.Thread(target=self._run, name="flowlens-sink", daemon=True)
        self._thread.start()
        atexit.register(self.close)

    def put(self, record: dict[str, Any]) -> None:
        self.queue.put(record)

    def close(self) -> None:
        self.queue.put(None)
        self._thread.join(timeout=3)

    def _run(self) -> None:
        stop = False
        while not stop:
            items: list[str] = []
            try:
                first = self.queue.get(timeout=self.flush_interval)
                if first is None:
                    stop = True
                else:
                    items.append(_dumps(first))
                while len(items) < self.batch:
                    nxt = self.queue.get_nowait()
                    if nxt is None:
                        stop = True
                        break
                    items.append(_dumps(nxt))
            except queue.Empty:
                pass
            if items:
                self._send(items)

    def _send(self, items: list[str]) -> None:
        if self.out_file:
            try:
                with open(self.out_file, "a", encoding="utf-8") as fh:
                    fh.write("\n".join(items) + "\n")
            except OSError as exc:
                self._warn(f"cannot write {self.out_file}: {exc}")
        if self.collector:
            body = ("[" + ",".join(items) + "]").encode("utf-8")
            req = urllib.request.Request(self.collector, data=body, headers={"content-type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=3) as resp:
                    resp.read()
            except Exception as exc:  # collector down: drop, never disturb the app
                self.dropped += len(items)
                self._warn(f"collector {self.collector} unreachable ({exc.__class__.__name__}); dropping events")

    def _warn(self, msg: str) -> None:
        if not self._warned:
            self._warned = True
            print(f"[flowlens] {msg}", file=sys.stderr)
