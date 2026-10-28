import type { EdgeKind, GraphNode } from "../../../core/src/types.ts";
import { nodeToV, type GraphIndex, type VEdge, type View, type VNode } from "../graph/views.ts";

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

export interface TSpan {
  span: string;
  parent: string | null;
  service: string;
  node: string;
  name: string;
  type: string;
  start: number;
  end: number;
  seq: number;
  endSeq: number;
  status: string;
  input?: unknown;
  output?: unknown;
  mutated?: Record<string, unknown>;
  error?: { type: string; message: string };
  file?: string;
  line?: number;
}

export interface TEvent {
  id: number;
  span: string;
  service: string;
  type: string; // db | http | publish | storage
  op: string;
  targets: { node: string; op: string }[];
  ts: number;
  durationMs: number;
  seq: number;
  detail?: Record<string, unknown>;
  error?: { type: string; message: string };
}

export interface TraceData {
  trace: TraceSummary | null;
  spans: TSpan[];
  events: TEvent[];
}

export type TStep =
  | { kind: "enter" | "exit"; span: TSpan; depth: number; async?: boolean }
  | { kind: "event"; event: TEvent; span?: TSpan; depth: number };

export const stepNode = (s: TStep): string =>
  s.kind === "event" ? s.event.targets[0]?.node ?? s.span?.node ?? "?" : s.span.node;

/**
 * Depth-first walk of the span tree into debugger steps: enter → (children and events in time order) → exit.
 * A child that starts after its parent finished (a message consumed later) follows the parent's exit.
 */
export function buildTimeline(data: TraceData): TStep[] {
  const byId = new Map(data.spans.map((s) => [s.span, s]));
  const children = new Map<string, TSpan[]>();
  const events = new Map<string, TEvent[]>();
  const roots: TSpan[] = [];
  for (const s of data.spans) {
    if (s.parent && byId.has(s.parent)) (children.get(s.parent) ?? children.set(s.parent, []).get(s.parent)!).push(s);
    else roots.push(s);
  }
  const orphanEvents: TEvent[] = [];
  for (const e of data.events) {
    if (byId.has(e.span)) (events.get(e.span) ?? events.set(e.span, []).get(e.span)!).push(e);
    else orphanEvents.push(e);
  }
  const steps: TStep[] = [];
  const walk = (span: TSpan, depth: number, isAsync = false) => {
    steps.push({ kind: "enter", span, depth, async: isAsync });
    const kids = children.get(span.span) ?? [];
    const later = kids.filter((k) => k.start > span.end);
    type Item = { t: number; seq: number; span?: TSpan; event?: TEvent };
    const items: Item[] = [
      ...kids.filter((k) => k.start <= span.end).map((k) => ({ t: k.start, seq: k.seq, span: k })),
      ...(events.get(span.span) ?? []).map((e) => ({ t: e.ts, seq: e.seq, event: e })),
    ].sort((a, b) => a.t - b.t || a.seq - b.seq);
    for (const it of items) {
      if (it.span) walk(it.span, depth + 1);
      else steps.push({ kind: "event", event: it.event!, span, depth: depth + 1 });
    }
    steps.push({ kind: "exit", span, depth });
    for (const k of later.sort((a, b) => a.start - b.start)) walk(k, depth, true);
  };
  for (const r of roots.sort((a, b) => a.start - b.start || a.seq - b.seq)) walk(r, 0);
  for (const e of orphanEvents) steps.push({ kind: "event", event: e, depth: 0 });
  return steps;
}

/** Ancestors of a span, root first. */
export function stackOf(data: TraceData, span: TSpan | undefined): TSpan[] {
  const byId = new Map(data.spans.map((s) => [s.span, s]));
  const out: TSpan[] = [];
  let cur = span;
  while (cur) {
    out.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return out;
}

const prefix = (id: string) => id.slice(0, id.indexOf(":"));

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

const KIND_OF: Record<string, GraphNode["kind"]> = {
  fn: "function", route: "route", topic: "topic", table: "table", bucket: "bucket", entry: "entry", ext: "external",
};

/** A node for an id the static scan doesn't know (nested function, unscanned service…). */
export function syntheticNode(id: string, name?: string, service?: string): GraphNode {
  const kind = KIND_OF[prefix(id)] ?? "function";
  const label = name ?? (kind === "table" || kind === "topic" || kind === "bucket" ? id.slice(id.indexOf(":") + 1) : id.split(/[:.]/).pop()!);
  return { id, kind, name: label, service, runtimeOnly: true };
}

const READS = new Set(["select", "get", "stat", "list"]);
/** Room under each trace node for its value card. */
const CARD_SPACE = 52;

/** The graph of one trace: every node it touched, edges counted by how often data moved along them. */
export function traceView(ix: GraphIndex, data: TraceData, steps: TStep[], fold: (id: string) => string): View {
  const nodes = new Map<string, VNode>();
  const edges = new Map<string, VEdge>();
  const calls = new Map<string, number>();
  const byId = new Map(data.spans.map((s) => [s.span, s]));
  const addNode = (id: string, name?: string, service?: string) => {
    if (nodes.has(id)) return;
    const n = ix.byId.get(id) ?? syntheticNode(id, name, service);
    const v = nodeToV(n);
    v.drill = undefined;
    nodes.set(id, v);
  };
  const addEdge = (from: string, kind: EdgeKind, to: string, op?: string) => {
    const id = `${from}|${kind}|${to}`;
    const e = edges.get(id) ?? { id, source: from, target: to, kind, count: 0, ops: [], refs: [] };
    e.count++;
    if (op && !e.ops.includes(op)) e.ops.push(op);
    edges.set(id, e);
  };
  for (const s of data.spans) {
    const node = fold(s.node);
    addNode(node, s.name, s.service);
    calls.set(node, (calls.get(node) ?? 0) + 1);
    const parent = s.parent ? byId.get(s.parent) : undefined;
    if (parent) {
      const kind = spanEdgeKind(parent.node, s.node);
      if (kind) addEdge(fold(parent.node), kind, node);
    }
  }
  for (const e of data.events) {
    const owner = byId.get(e.span);
    if (!owner) continue;
    for (const t of e.targets) {
      const target = fold(t.node);
      addNode(target);
      if (e.type === "publish") addEdge(fold(owner.node), "publishes", target, t.op);
      else if (READS.has(t.op)) addEdge(target, "reads", fold(owner.node), t.op);
      else addEdge(fold(owner.node), "writes", target, t.op);
    }
  }
  for (const [id, n] of calls) {
    const v = nodes.get(id)!;
    if (n > 1) v.sub = `${v.sub ? `${v.sub} · ` : ""}×${n}`;
  }
  const first = steps[0] ? fold(stepNode(steps[0])) : undefined;
  for (const v of nodes.values()) v.source = v.id === first;
  return {
    key: `trace:${data.trace?.trace ?? data.spans[0]?.span}`,
    title: data.trace?.rootName ?? "trace",
    reserve: CARD_SPACE,
    crumbs: [],
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

/** One-line preview of a value: `{lot_id: 5, qty: 3}` → `lot_id=5, qty=3`. */
export function compact(v: unknown, n = 44): string {
  const cut = (s: string) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (v === undefined) return "";
  if (v === null || typeof v !== "object") return cut(typeof v === "string" ? JSON.stringify(v) : String(v));
  if (Array.isArray(v)) return cut(v.length === 0 ? "[]" : `[${v.length}] ${compact(v[0], n)}`);
  const o = v as Record<string, unknown>;
  const type = typeof o.__type__ === "string" ? `${o.__type__} ` : "";
  const parts = Object.entries(o)
    .filter(([k]) => k !== "__type__" && k !== "__resumed__")
    .map(([k, x]) => `${k}=${x !== null && typeof x === "object" ? (Array.isArray(x) ? `[${x.length}]` : "{…}") : compact(x, 20)}`);
  return cut(type + (parts.join(", ") || "{}"));
}

/** A piece of data moving along one edge of the trace view during a step. */
export interface Packet {
  edge: string;
  reverse?: boolean; // travels against the edge: a return value going back to the caller
  label: string;
  tone?: "return" | "error";
}

/**
 * What moves on the canvas at a step: arguments into a call, the result back out,
 * rows out of a table, parameters into one. Several targets = the data splits.
 */
export function stepPackets(step: TStep | undefined, data: TraceData, fold: (id: string) => string): Packet[] {
  if (!step) return [];
  if (step.kind === "event") {
    const owner = step.span;
    if (!owner) return [];
    const o = fold(owner.node);
    const d = (step.event.detail ?? {}) as Record<string, unknown>;
    return step.event.targets.map((t) => {
      const target = fold(t.node);
      if (step.event.type === "publish") return { edge: `${o}|publishes|${target}`, label: compact(d.body ?? d.routingKey) };
      if (READS.has(t.op)) {
        const rows = typeof d.rowcount === "number" && d.rowcount >= 0 ? `${d.rowcount} row${d.rowcount === 1 ? "" : "s"}` : t.op;
        return { edge: `${target}|reads|${o}`, label: rows };
      }
      const payload = d.params ?? d.key ?? (step.event.type === "http" ? d.url : undefined);
      return { edge: `${o}|writes|${target}`, label: `${t.op}${payload !== undefined ? ` ${compact(payload, 36)}` : ""}` };
    });
  }
  const sp = step.span;
  const parent = sp.parent ? data.spans.find((s) => s.span === sp.parent) : undefined;
  const kind = parent ? spanEdgeKind(parent.node, sp.node) : null;
  if (!parent || !kind) return [];
  const edge = `${fold(parent.node)}|${kind}|${fold(sp.node)}`;
  if (step.kind === "enter") return [{ edge, label: compact(sp.input) || "()" }];
  if (sp.status === "error") return [{ edge, reverse: true, label: `✕ ${sp.error?.type ?? "error"}`, tone: "error" }];
  return [{ edge, reverse: true, label: sp.output === undefined || sp.output === null ? "done" : compact(sp.output), tone: "return" }];
}

/** What each node received and produced so far: the card shown under it on the canvas. */
export interface NodeCard {
  rows: { k: string; text: string; tone?: "in" | "out" | "err" | "chg" | "op" }[];
  fresh: boolean;
}

export function nodeCards(steps: TStep[], index: number, fold: (id: string) => string): Map<string, NodeCard> {
  type Acc = { in?: string; out?: string; err?: string; chg?: string; ops: Map<string, number>; last?: string; at: number };
  const acc = new Map<string, Acc>();
  const get = (id: string) => acc.get(id) ?? acc.set(id, { ops: new Map(), at: -1 }).get(id)!;
  for (let i = 0; i <= index && i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "event") {
      const d = (s.event.detail ?? {}) as Record<string, unknown>;
      for (const t of s.event.targets) {
        const a = get(fold(t.node));
        const op = s.event.type === "publish" ? "message" : t.op;
        a.ops.set(op, (a.ops.get(op) ?? 0) + 1);
        a.last = compact(s.event.type === "publish" ? d.body : d.params ?? d.key, 40) || undefined;
        a.at = i;
      }
      continue;
    }
    const a = get(fold(s.span.node));
    a.at = i;
    if (s.kind === "enter") {
      a.in = compact(s.span.input) || "()";
      a.out = a.err = a.chg = undefined;
    } else if (s.span.status === "error") a.err = `${s.span.error?.type ?? "error"}: ${s.span.error?.message ?? ""}`;
    else {
      a.out = s.span.output === undefined || s.span.output === null ? "—" : compact(s.span.output);
      if (s.span.mutated) a.chg = Object.keys(s.span.mutated).join(", ");
    }
  }
  const out = new Map<string, NodeCard>();
  for (const [id, a] of acc) {
    const rows: NodeCard["rows"] = [];
    if (a.ops.size) rows.push({ k: "", text: [...a.ops].map(([op, n]) => `${op}${n > 1 ? ` ×${n}` : ""}`).join(" · "), tone: "op" });
    if (a.last) rows.push({ k: "with", text: a.last, tone: "op" });
    if (a.in) rows.push({ k: "in", text: a.in, tone: "in" });
    if (a.err) rows.push({ k: "err", text: a.err, tone: "err" });
    else if (a.out) rows.push({ k: "out", text: a.out, tone: "out" });
    if (a.chg) rows.push({ k: "chg", text: a.chg, tone: "chg" });
    if (rows.length) out.set(id, { rows: rows.slice(0, 3), fresh: a.at === index });
  }
  return out;
}

/** Every step where a primitive value appears (in arguments, results, mutations or event details). */
export function stepsWithValue(steps: TStep[], value: string): number[] {
  const needle = value.length > 1 ? value : null;
  if (!needle) return [];
  const contains = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === "object") return Object.values(v as object).some(contains);
    return String(v) === needle;
  };
  const hits: number[] = [];
  steps.forEach((s, i) => {
    if (s.kind === "enter" && (contains(s.span.input))) hits.push(i);
    else if (s.kind === "exit" && (contains(s.span.output) || contains(s.span.mutated))) hits.push(i);
    else if (s.kind === "event" && contains(s.event.detail)) hits.push(i);
  });
  return hits;
}

export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

/** Leaf-level differences between two snapshots. */
export function diff(before: unknown, after: unknown, path = "", out: DiffEntry[] = []): DiffEntry[] {
  if (out.length > 40) return out;
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (isObj(before) && isObj(after) && Array.isArray(before) === Array.isArray(after)) {
    const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
    for (const k of keys) {
      if (k === "__type__") continue;
      diff((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path: path || "(value)", before, after });
  return out;
}

export const fmtMs = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(ms < 10 ? 2 : 0)}ms` : `${(ms / 1000).toFixed(2)}s`);

export function fmtAgo(epochSeconds: number): string {
  const s = Date.now() / 1000 - epochSeconds;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}
