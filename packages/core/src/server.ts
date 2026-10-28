import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeRecord, TraceStore } from "./store.ts";
import type { FlowGraph } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const UI_DIST = resolve(here, "../../ui/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  repoRoot: string;
  port: number;
  getGraph: () => FlowGraph;
  rescan: () => Promise<FlowGraph>;
  store: TraceStore;
  resolveFile: (service: string, file: string) => string;
  /** Extra listener that only accepts runtime events (e.g. 0.0.0.0 so containers can reach it). */
  ingestHost?: string;
  ingestPort?: number;
}

const MAX_BODY = 32 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Accepts a JSON array, a single JSON object, or NDJSON. */
export function parseRecords(body: string): RuntimeRecord[] {
  const text = body.trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  if (!text.includes("\n")) return [JSON.parse(text)];
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function ingest(opts: ServerOptions, req: IncomingMessage, res: ServerResponse) {
  const records = parseRecords(await readBody(req));
  const stored = opts.store.ingest(records, opts.resolveFile);
  send(res, 200, { ok: true, stored });
}

/** Runtime edges with node ids folded onto the static graph's (e.g. `lots` -> `inspection.lots`). */
function runtimeEdges(opts: ServerOptions) {
  const graph = opts.getGraph();
  const ids = new Set(graph.nodes.map((n) => n.id));
  const tables = graph.nodes.filter((n) => n.kind === "table");
  const fold = (id: string) => {
    if (ids.has(id) || !id.startsWith("table:")) return id;
    const name = id.slice(6);
    const twins = tables.filter((t) => t.name === name || t.name.endsWith(`.${name}`) || name.endsWith(`.${t.name}`));
    return twins.length === 1 ? twins[0].id : id;
  };
  return opts.store.runtimeEdges().map((e) => ({ ...e, from: fold(e.from), to: fold(e.to) }));
}

/** Resolve `rel` under `root`, refusing anything that escapes it. */
function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  const r = relative(root, full);
  return r && !r.startsWith("..") && !isAbsolute(r) ? full : null;
}

function send(res: ServerResponse, status: number, body: unknown, type = MIME[".json"]) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

function source(repoRoot: string, url: URL, res: ServerResponse) {
  const file = url.searchParams.get("file") ?? "";
  const full = inside(repoRoot, file);
  if (!full || !existsSync(full) || !statSync(full).isFile()) return send(res, 404, { error: "file not found" });
  const lines = readFileSync(full, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  const line = Math.max(1, Number(url.searchParams.get("line") ?? 1));
  const end = Number(url.searchParams.get("end") ?? 0);
  const ctx = Math.min(Number(url.searchParams.get("context") ?? 8), 60);
  const from = Math.max(1, line - (end ? 2 : ctx));
  const to = Math.min(lines.length, end ? Math.min(end + 1, from + 400) : line + ctx);
  send(res, 200, { file, absPath: full, from, to, focus: line, lines: lines.slice(from - 1, to), total: lines.length });
}

export function startServer(opts: ServerOptions): Promise<{ url: string; close: () => void }> {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/graph") return send(res, 200, opts.getGraph());
      if (url.pathname === "/api/source") return source(opts.repoRoot, url, res);
      if (url.pathname === "/api/events" && req.method === "POST") return await ingest(opts, req, res);
      if (url.pathname === "/api/traces" && req.method === "DELETE") {
        opts.store.clear();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/traces") {
        const p = url.searchParams;
        return send(res, 200, opts.store.listTraces({
          limit: Number(p.get("limit") ?? 200), q: p.get("q") ?? undefined,
          errors: p.get("errors") === "1", node: p.get("node") ?? undefined,
        }));
      }
      if (url.pathname.startsWith("/api/traces/")) {
        const t = opts.store.getTrace(decodeURIComponent(url.pathname.slice("/api/traces/".length)));
        return t.spans.length || t.events.length ? send(res, 200, t) : send(res, 404, { error: "trace not found" });
      }
      if (url.pathname === "/api/runtime/edges") return send(res, 200, runtimeEdges(opts));
      if (url.pathname === "/api/runtime/stats") return send(res, 200, opts.store.stats());
      if (url.pathname === "/api/search") return send(res, 200, opts.store.search(url.searchParams.get("value") ?? "", 100));
      if (url.pathname === "/api/rescan" && req.method === "POST") {
        const g = await opts.rescan();
        return send(res, 200, { ok: true, nodes: g.nodes.length, edges: g.edges.length, generatedAt: g.generatedAt });
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "unknown endpoint" });
      if (!existsSync(UI_DIST)) {
        return send(res, 503, "UI is not built. Run `npm run build` in the FlowLens repo.", "text/plain; charset=utf-8");
      }
      const asset = inside(UI_DIST, decodeURIComponent(url.pathname.slice(1)) || "index.html");
      const file = asset && existsSync(asset) && statSync(asset).isFile() ? asset : join(UI_DIST, "index.html");
      return send(res, 200, readFileSync(file), MIME[extname(file)] ?? "application/octet-stream");
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  };
  const server = createServer((req, res) => void handler(req, res));
  const servers = [server];
  if (opts.ingestHost) {
    // ingest-only: never serves source code or the graph
    const ingestOnly = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/api/events" && req.method === "POST") {
        ingest(opts, req, res).catch((e: Error) => send(res, 400, { error: e.message }));
      } else send(res, 404, { error: "this port only accepts POST /api/events" });
    });
    ingestOnly.listen(opts.ingestPort ?? opts.port + 1, opts.ingestHost);
    servers.push(ingestOnly);
  }
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    // loopback only: the API serves source code
    server.listen(opts.port, "127.0.0.1", () => {
      resolvePromise({ url: `http://127.0.0.1:${opts.port}`, close: () => servers.forEach((s) => s.close()) });
    });
  });
}
