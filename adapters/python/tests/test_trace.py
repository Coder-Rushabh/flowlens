"""Tracer behaviour on plain Python (no web frameworks), for each available backend."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.dirname(HERE)
TRACEE = os.path.join(HERE, "fixtures", "tracee")


def trace(backend: str) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "events.jsonl")
        env = {**os.environ, "PYTHONPATH": ADAPTER, "FLOWLENS_SERVICE": "shop", "FLOWLENS_ROOT": TRACEE,
               "FLOWLENS_COLLECTOR": "", "FLOWLENS_OUT": out, "FLOWLENS_BACKEND": backend, "FLOWLENS_QUIET": "1"}
        code = "import flowlens.trace as t; t.install(); from app.logic import run; run(); t.uninstall()"
        subprocess.run([sys.executable, "-c", code], cwd=TRACEE, env=env, check=True)
        with open(out, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh]


class TraceMixin:
    backend = "auto"

    @classmethod
    def setUpClass(cls):
        cls.records = trace(cls.backend)
        cls.spans = [r for r in cls.records if r["kind"] == "span"]
        cls.by_name = {}
        for s in cls.spans:
            cls.by_name.setdefault(s["name"], []).append(s)

    def test_node_ids_match_static_scanner(self):
        self.assertIn("fn:shop:app.logic.Cart.add", {s["node"] for s in self.spans})

    def test_arguments_return_values_and_redaction(self):
        (add,) = self.by_name["Cart.add"]
        self.assertEqual(add["input"], {"sku": "A", "qty": 2})
        self.assertEqual(add["output"], 1)
        (checkout,) = self.by_name["checkout"]
        self.assertEqual(checkout["input"]["password"], "***")
        self.assertEqual(checkout["output"], {"owner": "ana", "total": 10})

    def test_mutated_arguments_are_reported(self):
        (checkout,) = self.by_name["checkout"]
        self.assertEqual(checkout["mutated"]["cart"]["items"], [])

    def test_parent_child_nesting(self):
        (run,) = self.by_name["run"]
        (checkout,) = self.by_name["checkout"]
        self.assertEqual(checkout["parent"], run["span"])
        self.assertTrue(all(p["parent"] == checkout["span"] for p in self.by_name["price"] if p["input"]["sku"] == "A"))
        self.assertEqual(len({s["trace"] for s in self.spans}), 1)

    def test_exceptions(self):
        bad = [p for p in self.by_name["price"] if p["input"]["sku"] == "bad"]
        self.assertEqual(bad[0]["status"], "error")
        expected = "ValueError" if self.backend == "monitoring" else "UnwoundError"
        self.assertEqual(bad[0]["error"]["type"], expected)
        ok = [p for p in self.by_name["price"] if p["input"]["sku"] == "A"]
        self.assertEqual(ok[0]["status"], "ok")

    def test_async_exceptions(self):
        (failing,) = self.by_name["failing"]
        (guarded,) = self.by_name["guarded"]
        self.assertEqual(failing["status"], "error")
        self.assertEqual(guarded["status"], "ok")
        self.assertEqual(guarded["output"], "recovered")

    def test_generator_segments(self):
        yields = [s["output"] for s in self.by_name["numbers"] if s["status"] == "yield"]
        self.assertEqual(yields, [0, 10])

    def test_async_nesting_survives_awaits(self):
        (fetch,) = self.by_name["fetch"]
        (double,) = self.by_name["double"]
        self.assertEqual(double["parent"], fetch["span"])
        self.assertEqual(fetch["output"], 42)


@unittest.skipUnless(hasattr(sys, "monitoring"), "sys.monitoring needs Python 3.12+")
class MonitoringBackendTest(TraceMixin, unittest.TestCase):
    backend = "monitoring"


@unittest.skipIf(hasattr(sys, "monitoring"), "the profile backend is for Python < 3.12")
class ProfileBackendTest(TraceMixin, unittest.TestCase):
    backend = "profile"


if __name__ == "__main__":
    unittest.main()
