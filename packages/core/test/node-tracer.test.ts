import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { scanTypescript } from "../src/scanners/typescript.ts";

const FIXTURE = resolve(import.meta.dirname, "../../../adapters/node/test/fixture");
const REGISTER = pathToFileURL(resolve(import.meta.dirname, "../../../adapters/node/register.mjs")).href;
const tmp = mkdtempSync(join(tmpdir(), "flowlens-node-"));
const procs: ChildProcess[] = [];

function start(service: string, entry: string, port: number, extra: Record<string, string> = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(process.execPath, ["--import", REGISTER, entry], {
      cwd: join(FIXTURE, service),
      env: {
        ...process.env, PORT: String(port), FLOWLENS_SERVICE: service, FLOWLENS_ROOT: join(FIXTURE, service),
        FLOWLENS_COLLECTOR: "", FLOWLENS_OUT: join(tmp, `${service}.jsonl`), FLOWLENS_QUIET: "1", ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(p);
    let err = "";
    p.stderr!.on("data", (d) => (err += d));
    p.stdout!.on("data", (d) => String(d).includes("ready") && resolvePromise());
    p.on("exit", (code) => reject(new Error(`${service} exited ${code}: ${err}`)));
  });
}

type Rec = Record<string, any>;
let records: Rec[] = [];

before(async () => {
  await start("inventory", "server.mjs", 47811);
  await start("orders", "server.ts", 47812, { INVENTORY_URL: "http://127.0.0.1:47811" });
  assert.equal((await fetch("http://127.0.0.1:47812/")).status, 200);
  assert.equal((await fetch("http://127.0.0.1:47812/big")).status, 409);
  await new Promise((r) => setTimeout(r, 700)); // sink flushes every 250ms
  records = ["orders", "inventory"].flatMap((s) =>
    readFileSync(join(tmp, `${s}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
  );
});

after(() => procs.forEach((p) => p.kill()));

const spans = () => records.filter((r) => r.kind === "span");
const byName = (name: string) => spans().filter((s) => s.name === name);

test("TypeScript functions are traced with arguments, results and mutations", () => {
  const [quote] = byName("quote");
  assert.deepEqual(quote.input, { sku: "SHOE-1", qty: 2 });
  assert.equal(quote.output, 98);
  const [place] = byName("placeOrder");
  assert.equal(place.node, "fn:orders:server.placeOrder");
  assert.equal(place.mutated.order.total, 98);
  assert.equal(quote.parent, place.span);
});

test("a fetch to another traced service continues the same trace", () => {
  const [place] = byName("placeOrder");
  const inbound = spans().find((s) => s.service === "inventory" && s.type === "route" && s.trace === place.trace);
  assert.ok(inbound, "inventory request span in the orders trace");
  assert.equal(inbound.parent, place.span);
  const reserve = spans().find((s) => s.name === "reserve" && s.trace === place.trace);
  assert.deepEqual(reserve?.input, { sku: "SHOE-1", qty: 2 });
  const http = records.find((r) => r.kind === "event" && r.type === "http" && r.trace === place.trace);
  assert.equal(http?.detail.status, 200);
});

test("rejected async functions are errors", () => {
  const failed = byName("placeOrder").find((s) => s.status === "error");
  assert.equal(failed?.error.message, "out of stock");
});

test("runtime node ids are the static scanner's ids", () => {
  const ids = new Set(
    ["orders", "inventory"].flatMap((s) =>
      scanTypescript({ service: s, root: join(FIXTURE, s), rootRel: s, repoRoot: FIXTURE }).nodes.map((n) => n.id),
    ),
  );
  const fnNodes = new Set(spans().filter((s) => s.type === "function").map((s) => s.node));
  for (const id of fnNodes) assert.ok(ids.has(id), `${id} is a static node`);
  assert.ok(fnNodes.has("fn:inventory:server.handlers.reserveRoute"));
});
