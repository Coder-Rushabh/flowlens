"""Scanner behaviour, checked against the examples/shop fixture (FastAPI + Flask services)."""

from __future__ import annotations

import os
import unittest

from flowlens.scan import scan
from flowlens.scan.detectors.sql import analyze_sql

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SHOP = os.path.join(REPO, "examples", "shop")


def run(service: str) -> dict:
    return scan({"service": service, "root": os.path.join(SHOP, service), "repoRoot": SHOP})


def edges(graph: dict, kind: str) -> set[tuple[str, str]]:
    names = {n["id"]: n["name"] for n in graph["nodes"]}
    return {(names[e["from"]], names[e["to"]]) for e in graph["edges"] if e["kind"] == kind}


class OrdersServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g = run("orders")

    def test_fastapi_routes_include_mount_and_router_prefixes(self):
        routes = {n["name"] for n in self.g["nodes"] if n["kind"] == "route"}
        self.assertEqual(routes, {"POST /api/orders", "DELETE /api/orders/{order_id}", "GET /health"})

    def test_calls_resolve_through_module_imports(self):
        self.assertIn(("create_order", "place_order"), edges(self.g, "calls"))
        self.assertIn(("place_order", "reserve_stock"), edges(self.g, "calls"))

    def test_orm_writes_and_reads_use_schema_qualified_tables(self):
        writes = edges(self.g, "writes")
        self.assertIn(("place_order", "sales.orders"), writes)
        self.assertIn(("place_order", "sales.audit_log"), writes)
        self.assertIn(("cancel_order", "sales.orders"), writes)  # attribute update on a fetched row
        self.assertIn(("sales.orders", "cancel_order"), edges(self.g, "reads"))

    def test_publish_with_constant_routing_key(self):
        self.assertIn(("place_order", "order.placed"), edges(self.g, "publishes"))

    def test_http_call_url_resolves_env_hint(self):
        (call,) = self.g["httpCalls"]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "http://inventory:5000/stock/{sku}/reserve")


class InventoryServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g = run("inventory")

    def test_flask_blueprint_prefix(self):
        routes = {n["name"] for n in self.g["nodes"] if n["kind"] == "route"}
        self.assertEqual(routes, {"POST /stock/<sku>/reserve", "GET /stock/<sku>"})

    def test_raw_sql_in_literals_and_module_constants(self):
        self.assertIn(("reserve", "warehouse.stock_levels"), edges(self.g, "writes"))
        self.assertIn(("warehouse.stock_levels", "reserve"), edges(self.g, "reads"))
        self.assertIn(("on_message", "warehouse.movements"), edges(self.g, "writes"))

    def test_consumer_bindings_from_constant_list(self):
        consumes = edges(self.g, "consumes")
        self.assertIn(("order.placed", "on_message"), consumes)
        self.assertIn(("order.cancelled", "on_message"), consumes)

    def test_celery_task_and_s3_bucket_from_env_default(self):
        self.assertIn(("on_message", "task:inventory.archive_receipt"), edges(self.g, "publishes"))
        self.assertIn(("archive_receipt", "shop-receipts"), edges(self.g, "writes"))

    def test_main_block_is_an_entry_point(self):
        self.assertIn(("python -m inventory.worker", "main"), edges(self.g, "handles"))


class PluginTest(unittest.TestCase):
    def test_plugin_detector_loaded_from_config(self):
        fixtures = os.path.join(os.path.dirname(__file__), "fixtures")
        g = scan({
            "service": "jobs", "root": os.path.join(fixtures, "plugin_app"), "repoRoot": fixtures,
            "detectors": {"plugins": ["plugin_detector.py:NotifyDetector", "missing.py:Nope"]},
        })
        self.assertIn(("nightly_report", "notify:ops-alerts"), edges(g, "publishes"))
        self.assertTrue(any("missing.py:Nope" in w for w in g["warnings"]), "a broken plugin is a warning, not a crash")


class SqlTest(unittest.TestCase):
    def test_ctes_functions_and_prose_are_not_tables(self):
        writes, reads = analyze_sql(
            "WITH recent AS (SELECT * FROM a.events) "
            "SELECT extract(epoch from created_at), x FROM recent JOIN b.items i ON true "
            "WHERE x IS DISTINCT FROM y AND z IN (SELECT 1 FROM generate_series(1, 3))"
        )
        self.assertEqual(writes, {})
        self.assertEqual(reads, {"a.events", "b.items"})

    def test_writes(self):
        writes, reads = analyze_sql("INSERT INTO s.t (a) SELECT a FROM s.u ON CONFLICT (a) DO UPDATE SET a = 1")
        self.assertEqual(writes, {"s.t": "insert"})
        self.assertEqual(reads, {"s.u"})
        self.assertEqual(analyze_sql("DELETE FROM s.t WHERE id = 1"), ({"s.t": "delete"}, set()))

    def test_dynamic_table_is_unknown_but_dynamic_schema_is_dropped(self):
        self.assertEqual(analyze_sql("SELECT id FROM auth.__fl__ WHERE x = 1"), ({}, set()))
        self.assertEqual(analyze_sql("SELECT id FROM __fl__.users"), ({}, {"users"}))

    def test_not_sql(self):
        self.assertEqual(analyze_sql("from must be <= to"), ({}, set()))
        self.assertEqual(analyze_sql("Select the best option from the list"), ({}, set()))


if __name__ == "__main__":
    unittest.main()
