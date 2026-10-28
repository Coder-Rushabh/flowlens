import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { EdgeKind } from "./types.ts";

/** What a runtime adapter sends: one record per finished span, one per library event. */
export interface SpanRecord {
  kind: "span";
  service: string;
  trace: string;
  span: string;
  parent: string | null;
  node: string;
  name: string;
  type: string; // function | route | consume | entry
  start: number;
  end: number;
  seq: number;
  endSeq: number;
  status: string; // ok | error | yield
  input?: unknown;
  output?: unknown;
  mutated?: unknown;
  error?: { type: string; message: string };
  file?: string;
  line?: number;
  pid?: number;
}

export interface EventRecord {
  kind: "event";
  service: string;
  trace: string;
  span: string;
  type: string; // db | http | publish | storage
  op: string;
  targets: { node: string; op: string }[];
  ts: number;
  durationMs: number;
  seq: number;
  detail?: unknown;
  error?: { type: string; message: string };
  pid?: number;
}

export type RuntimeRecord = SpanRecord | EventRecord;

export interface TraceSummary {
  trace: string;
  rootName: string;
  rootNode: string;
  services: string[];
  start: number;
  end: number;
  spans: number;
  events: number;
  errors: number;
}

export interface RuntimeEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  count: number;
  lastSeen: number;
  trace: string;
}

const READ_OPS = new Set(["select", "get", "stat", "list"]);
const prefix = (node: string) => node.slice(0, node.indexOf(":"));

/** Edge kind between a parent span's node and a child span's node. */
export function spanEdgeKind(parent: string, child: string): EdgeKind | null {
  const p = prefix(parent);
  const c = prefix(child);
  if (p === "fn" && c === "fn") return "calls";
  if ((p === "route" || p === "entry") && c === "fn") return "handles";
  if (p === "topic" && c === "fn") return "consumes";
  if (p === "fn" && c === "route") return "http";
  if (p === "fn" && c === "topic") return "publishes";
  return null;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v ?? undefined);

export class TraceStore {
  readonly db: DatabaseSync;
  private readonly maxTraces: number;
  private ingestCount = 0;
  private stmt: Record<string, StatementSync>;

  constructor(file: string, opts: { maxTraces?: number } = {}) {
    this.db = new DatabaseSync(file);
    this.maxTraces = opts.maxTraces ?? 2000;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS spans (
        span TEXT PRIMARY KEY, trace TEXT NOT NULL, parent TEXT, service TEXT, node TEXT, name TEXT, type TEXT,
        start REAL, "end" REAL, seq INTEGER, end_seq INTEGER, status TEXT, input TEXT, output TEXT, mutated TEXT,
        error TEXT, file TEXT, line INTEGER, pid INTEGER);
      CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace);
      CREATE INDEX IF NOT EXISTS spans_parent ON spans(parent);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, trace TEXT NOT NULL, span TEXT, service TEXT, type TEXT, op TEXT, targets TEXT,
        ts REAL, duration REAL, seq INTEGER, detail TEXT, error TEXT, pid INTEGER);
      CREATE INDEX IF NOT EXISTS events_trace ON events(trace);
      CREATE INDEX IF NOT EXISTS events_span ON events(span);
      CREATE TABLE IF NOT EXISTS traces (
        trace TEXT PRIMARY KEY, root_name TEXT, root_node TEXT, services TEXT, start REAL, "end" REAL,
        spans INTEGER DEFAULT 0, events INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, updated REAL);
      CREATE TABLE IF NOT EXISTS edges (
        from_node TEXT, kind TEXT, to_node TEXT, count INTEGER, last_seen REAL, trace TEXT,
        PRIMARY KEY (from_node, kind, to_node));
    `);
    this.stmt = {
      span: this.db.prepare(`INSERT OR REPLACE INTO spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      event: this.db.prepare(`INSERT INTO events (trace, span, service, type, op, targets, ts, duration, seq, detail, error, pid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      spanNode: this.db.prepare(`SELECT node FROM spans WHERE span = ?`),
      children: this.db.prepare(`SELECT node FROM spans WHERE parent = ?`),
      eventsOf: this.db.prepare(`SELECT targets, type FROM events WHERE span = ?`),
      edge: this.db.prepare(`INSERT INTO edges VALUES (?,?,?,1,?,?) ON CONFLICT (from_node, kind, to_node)
        DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, trace = excluded.trace`),
      trace: this.db.prepare(`INSERT INTO traces (trace, services, start, "end", spans, events, errors, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (trace) DO UPDATE SET start = min(start, excluded.start), "end" = max("end", excluded."end"),
        spans = spans + excluded.spans, events = events + excluded.events, errors = errors + excluded.errors,
        updated = excluded.updated,
        services = CASE WHEN instr(services, '"' || json_extract(excluded.services, '$[0]') || '"') > 0 THEN services
                        ELSE json_insert(services, '$[#]', json_extract(excluded.services, '$[0]')) END`),
      root: this.db.prepare(`UPDATE traces SET root_name = ?, root_node = ? WHERE trace = ?`),
    };
  }

  private edge(from: string, kind: EdgeKind, to: string, ts: number, trace: string) {
    this.stmt.edge.run(from, kind, to, ts, trace);
  }

  private eventEdges(fnNode: string, targets: { node: string; op: string }[], type: string, ts: number, trace: string) {
    for (const t of targets) {
      if (type === "publish") this.edge(fnNode, "publishes", t.node, ts, trace);
      else if (READ_OPS.has(t.op)) this.edge(t.node, "reads", fnNode, ts, trace);
      else this.edge(fnNode, "writes", t.node, ts, trace);
    }
  }

  /** Store records. `resolveFile` maps a service-relative file to a repo-relative one. */
  ingest(records: RuntimeRecord[], resolveFile: (service: string, file: string) => string = (_, f) => f): number {
    let stored = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of records) {
        if (!r || typeof r !== "object" || !r.trace) continue;
        if (r.kind === "span") this.ingestSpan(r, resolveFile);
        else if (r.kind === "event") this.ingestEvent(r);
        else continue;
        stored++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if ((this.ingestCount += 1) % 50 === 0) this.prune();
    return stored;
  }

  private ingestSpan(r: SpanRecord, resolveFile: (service: string, file: string) => string) {
    const file = r.file ? resolveFile(r.service, r.file) : null;
    this.stmt.span.run(
      r.span, r.trace, r.parent ?? null, r.service, r.node, r.name, r.type, r.start, r.end, r.seq, r.endSeq,
      r.status, json(r.input), json(r.output), json(r.mutated), json(r.error), file, r.line ?? null, r.pid ?? null,
    );
    const isError = r.status === "error" ? 1 : 0;
    this.stmt.trace.run(r.trace, JSON.stringify([r.service]), r.start, r.end, 1, 0, isError, Date.now() / 1000);
    if (!r.parent) this.stmt.root.run(r.name, r.node, r.trace);
    if (r.parent) {
      const parent = this.stmt.spanNode.get(r.parent) as { node: string } | undefined;
      const kind = parent && spanEdgeKind(parent.node, r.node);
      if (kind) this.edge(parent.node, kind, r.node, r.end, r.trace);
    }
    for (const child of this.stmt.children.all(r.span) as { node: string }[]) {
      const kind = spanEdgeKind(r.node, child.node);
      if (kind) this.edge(r.node, kind, child.node, r.end, r.trace);
    }
    if (prefix(r.node) === "fn") {
      for (const ev of this.stmt.eventsOf.all(r.span) as { targets: string; type: string }[]) {
        this.eventEdges(r.node, JSON.parse(ev.targets), ev.type, r.end, r.trace);
      }
    }
  }

  private ingestEvent(r: EventRecord) {
    this.stmt.event.run(
      r.trace, r.span, r.service, r.type, r.op, JSON.stringify(r.targets ?? []), r.ts, r.durationMs, r.seq,
      json(r.detail), json(r.error), r.pid ?? null,
    );
    this.stmt.trace.run(r.trace, JSON.stringify([r.service]), r.ts, r.ts, 0, 1, r.error ? 1 : 0, Date.now() / 1000);
    const owner = this.stmt.spanNode.get(r.span) as { node: string } | undefined;
    if (owner && prefix(owner.node) === "fn") this.eventEdges(owner.node, r.targets ?? [], r.type, r.ts, r.trace);
  }

  private prune() {
    const row = this.db.prepare(`SELECT count(*) AS n FROM traces`).get() as { n: number };
    const extra = row.n - this.maxTraces;
    if (extra <= 0) return;
    const old = `SELECT trace FROM traces ORDER BY updated ASC LIMIT ${Math.floor(extra)}`;
    this.db.exec(`BEGIN;
      DELETE FROM spans WHERE trace IN (${old});
      DELETE FROM events WHERE trace IN (${old});
      DELETE FROM traces WHERE trace IN (${old});
      COMMIT;`);
  }

  listTraces(opts: { limit?: number; q?: string; errors?: boolean; node?: string } = {}): TraceSummary[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.q) {
      where.push(`(t.root_name LIKE ? OR t.services LIKE ? OR EXISTS (SELECT 1 FROM spans s WHERE s.trace = t.trace AND s.name LIKE ?))`);
      const like = `%${opts.q}%`;
      args.push(like, like, like);
    }
    if (opts.errors) where.push("t.errors > 0");
    if (opts.node) {
      where.push(`(EXISTS (SELECT 1 FROM spans s WHERE s.trace = t.trace AND s.node = ?)
        OR EXISTS (SELECT 1 FROM events e WHERE e.trace = t.trace AND e.targets LIKE ?))`);
      args.push(opts.node, `%"${opts.node}"%`);
    }
    const rows = this.db.prepare(`
      SELECT t.*, COALESCE(t.root_name, (SELECT name FROM spans s WHERE s.trace = t.trace ORDER BY start LIMIT 1)) AS rn,
             COALESCE(t.root_node, (SELECT node FROM spans s WHERE s.trace = t.trace ORDER BY start LIMIT 1)) AS rnode
      FROM traces t ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.start DESC LIMIT ?`).all(...args, Math.min(opts.limit ?? 200, 1000)) as Record<string, unknown>[];
    return rows.map((r) => ({
      trace: String(r.trace),
      rootName: String(r.rn ?? "?"),
      rootNode: String(r.rnode ?? ""),
      services: JSON.parse(String(r.services ?? "[]")),
      start: Number(r.start),
      end: Number(r.end),
      spans: Number(r.spans),
      events: Number(r.events),
      errors: Number(r.errors),
    }));
  }

  getTrace(trace: string) {
    const spans = (this.db.prepare(`SELECT * FROM spans WHERE trace = ? ORDER BY start, seq`).all(trace) as Record<string, unknown>[]).map((s) => ({
      span: s.span, parent: s.parent, service: s.service, node: s.node, name: s.name, type: s.type,
      start: s.start, end: s.end, seq: s.seq, endSeq: s.end_seq, status: s.status,
      input: parse(s.input), output: parse(s.output), mutated: parse(s.mutated), error: parse(s.error),
      file: s.file ?? undefined, line: s.line ?? undefined, pid: s.pid,
    }));
    const events = (this.db.prepare(`SELECT * FROM events WHERE trace = ? ORDER BY ts, seq`).all(trace) as Record<string, unknown>[]).map((e) => ({
      id: e.id, span: e.span, service: e.service, type: e.type, op: e.op, targets: parse(e.targets), ts: e.ts,
      durationMs: e.duration, seq: e.seq, detail: parse(e.detail), error: parse(e.error), pid: e.pid,
    }));
    const summary = this.listTraces({ limit: 1000 }).find((t) => t.trace === trace);
    return { trace: summary ?? null, spans, events };
  }

  runtimeEdges(): RuntimeEdge[] {
    return (this.db.prepare(`SELECT * FROM edges`).all() as Record<string, unknown>[]).map((e) => ({
      from: String(e.from_node), to: String(e.to_node), kind: e.kind as EdgeKind, count: Number(e.count),
      lastSeen: Number(e.last_seen), trace: String(e.trace),
    }));
  }

  /** Find a value anywhere in captured inputs, outputs, mutations and event details. */
  search(value: string, limit = 100) {
    const like = `%${value.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const spans = this.db.prepare(`
      SELECT trace, span, node, name, service, start,
        CASE WHEN input LIKE ?1 ESCAPE '\\' THEN 'input' WHEN output LIKE ?1 ESCAPE '\\' THEN 'output' ELSE 'mutated' END AS "where"
      FROM spans WHERE input LIKE ?1 ESCAPE '\\' OR output LIKE ?1 ESCAPE '\\' OR mutated LIKE ?1 ESCAPE '\\'
      ORDER BY start DESC LIMIT ?2`).all(like, limit) as Record<string, unknown>[];
    const events = this.db.prepare(`
      SELECT trace, span, type, op, service, ts AS start, 'event' AS "where" FROM events
      WHERE detail LIKE ?1 ESCAPE '\\' ORDER BY ts DESC LIMIT ?2`).all(like, limit) as Record<string, unknown>[];
    return [...spans, ...events].sort((a, b) => Number(b.start) - Number(a.start)).slice(0, limit);
  }

  stats() {
    const row = this.db.prepare(`SELECT count(*) AS traces, max(updated) AS last FROM traces`).get() as { traces: number; last: number | null };
    return { traces: row.traces, lastEventAt: row.last };
  }

  clear() {
    this.db.exec(`DELETE FROM spans; DELETE FROM events; DELETE FROM traces; DELETE FROM edges;`);
  }

  close() {
    this.db.close();
  }
}
