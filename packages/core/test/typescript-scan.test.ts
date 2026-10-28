import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { mergeGraphs } from "../src/merge.ts";
import { scanTypescript } from "../src/scanners/typescript.ts";

const ROOT = resolve(import.meta.dirname, "fixtures/ts-app");
const scan = (service: string) => scanTypescript({ service, root: resolve(ROOT, service), rootRel: service, repoRoot: ROOT });
const web = scan("web");
const api = scan("api");
const graph = mergeGraphs("ts-app", ROOT, [web, api]);
const name = (id: string) => graph.nodes.find((n) => n.id === id)?.name;
const has = (from: string, kind: string, to: string) =>
  graph.edges.some((e) => name(e.from) === from && e.kind === kind && name(e.to) === to);

test("React Navigation screens are entries; Supabase tables, buckets and rpc", () => {
  const m = mergeGraphs("ts-app", ROOT, [scan("mobile")]);
  const nm = (id: string) => m.nodes.find((n) => n.id === id)?.name;
  const edge = (from: string, kind: string, to: string) => m.edges.some((e) => nm(e.from) === from && e.kind === kind && nm(e.to) === to);
  assert.ok(edge("screen Places", "handles", "PlacesScreen"));
  assert.ok(edge("screen Report", "handles", "ReportScreen"));
  assert.ok(edge("places", "reads", "listPlaces"));
  assert.ok(edge("reportPlace", "writes", "reports"));
  assert.ok(!edge("reports", "reads", "reportPlace"), "insert without select is not a read");
  assert.ok(edge("nearby", "calls", "rpc nearby_places"));
  assert.ok(edge("uploadPhoto", "writes", "photos"));
  assert.ok(edge("places", "reads", "restCount"), "PostgREST URL");
});

test("Next.js pages and route handlers (groups dropped, [id] -> {id})", () => {
  assert.ok(has("page /orders/{id}", "handles", "OrderPage"));
  assert.ok(has("GET /api/health", "handles", "GET"));
});

test("calls through tsconfig paths, object-literal APIs and JSX renders", () => {
  assert.ok(has("OrderPage", "calls", "ordersApi.get"), "path alias + object method");
  assert.ok(has("OrderPage", "calls", "OrderCard"), "JSX render");
  assert.ok(has("OrderCard", "calls", "ordersApi.cancel"), "relative import");
});

test("Express routers mounted with app.use get their prefix", () => {
  assert.ok(has("GET /api/orders/:id", "handles", "<GET /:id>"));
  assert.ok(has("<POST /:id/cancel>", "calls", "cancelOrder"));
});

test("frontend HTTP calls link to backend routes", () => {
  assert.ok(has("ordersApi.get", "http", "GET /api/orders/:id"));
  assert.ok(has("ordersApi.cancel", "http", "POST /api/orders/:id/cancel"));
});

test("Prisma models use @@map table names; raw SQL is parsed", () => {
  assert.ok(has("orders", "reads", "getOrder"));
  assert.ok(has("cancelOrder", "writes", "audit_log"));
  assert.ok(has("cancelOrder", "writes", "orders"));
});
