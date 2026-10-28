import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { linkHttpCall, mergeGraphs, splitUrl, topicMatches } from "../src/merge.ts";
import { scanRepo } from "../src/scan.ts";
import type { GraphNode, PartialGraph } from "../src/types.ts";

test("topic patterns follow AMQP rules", () => {
  assert.ok(topicMatches("order.*", "order.placed"));
  assert.ok(!topicMatches("order.*", "order.placed.eu"));
  assert.ok(topicMatches("order.#", "order.placed.eu"));
  assert.ok(topicMatches("#", "anything.at.all"));
  assert.ok(!topicMatches("invoice.*", "order.placed"));
});

test("splitUrl separates the target from the path", () => {
  assert.deepEqual(splitUrl("http://inventory:5000/stock/{sku}?x=1"), { target: "inventory:5000", path: "/stock/{sku}" });
  assert.deepEqual(splitUrl("{settings.AUTH_URL}/api/v1/users"), { target: "settings.AUTH_URL", path: "/api/v1/users" });
});

const route = (service: string, method: string, path: string): { node: GraphNode; segs: string[] } => ({
  node: { id: `route:${service}:${method} ${path}`, kind: "route", name: `${method} ${path}`, service, method, path },
  segs: path.split("/").filter(Boolean),
});

test("HTTP calls prefer the service named in the URL", () => {
  const routes = [route("backend-auth", "GET", "/api/v1/users/{id}"), route("backend-crm", "GET", "/api/v1/users/{id}")];
  const call = { from: "fn:x", method: "GET", url: "{settings.AUTH_SERVICE_URL}/api/v1/users/{uid}", file: "a.py", line: 1 };
  const { matches } = linkHttpCall(call, routes, "caller");
  assert.deepEqual(matches.map((m) => m.service), ["backend-auth"]);
});

test("HTTP calls with no literal path segment are not linked", () => {
  const { matches } = linkHttpCall({ from: "fn:x", method: "GET", url: "{base}{path}", file: "a.py", line: 1 }, [route("s", "GET", "/{id}")], "c");
  assert.equal(matches.length, 0);
});

test("unqualified tables fold into their single schema-qualified twin", () => {
  const part = (name: string, nodes: GraphNode[], edges: PartialGraph["edges"]): PartialGraph => ({
    service: { name, language: "python", root: name },
    nodes,
    edges,
    httpCalls: [],
    warnings: [],
  });
  const g = mergeGraphs("p", "/r", [
    part("a", [{ id: "fn:a:f", kind: "function", name: "f" }, { id: "table:orders", kind: "table", name: "orders" }],
      [{ from: "fn:a:f", to: "table:orders", kind: "writes", origin: "static", evidence: [] }]),
    part("b", [{ id: "fn:b:g", kind: "function", name: "g" }, { id: "table:sales.orders", kind: "table", name: "sales.orders" }],
      [{ from: "table:sales.orders", to: "fn:b:g", kind: "reads", origin: "static", evidence: [] }]),
  ]);
  assert.ok(!g.nodes.some((n) => n.id === "table:orders"));
  assert.ok(g.edges.some((e) => e.from === "fn:a:f" && e.to === "table:sales.orders" && e.kind === "writes"));
});

test("end to end: the shop example links services through HTTP and topics", async () => {
  const repo = resolve(import.meta.dirname, "../../../examples/shop");
  const g = await scanRepo(repo, loadConfig(repo).config);
  const has = (from: string, kind: string, to: string) => g.edges.some((e) => e.from.endsWith(from) && e.kind === kind && e.to.endsWith(to));
  assert.deepEqual(g.services.map((s) => s.status), ["scanned", "scanned"]);
  assert.ok(has("clients.reserve_stock", "http", "POST /stock/<sku>/reserve"), "http call linked to the Flask route");
  assert.ok(has("service.place_order", "publishes", "topic:order.placed"));
  assert.ok(has("topic:order.placed", "consumes", "worker.on_message"), "consumer in the other service");
});
