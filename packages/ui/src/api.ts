import type { FlowGraph } from "../../core/src/types.ts";
import type { TraceData, TraceSummary } from "./runtime/model.ts";

export interface SourceSlice {
  file: string;
  absPath: string;
  from: number;
  to: number;
  focus: number;
  lines: string[];
  total: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const fetchGraph = () => fetch("/api/graph").then((r) => json<FlowGraph>(r));

export const rescan = () => fetch("/api/rescan", { method: "POST" }).then((r) => json<{ ok: boolean }>(r));

export function fetchSource(file: string, line: number, end?: number): Promise<SourceSlice> {
  const q = new URLSearchParams({ file, line: String(line) });
  if (end) q.set("end", String(end));
  return fetch(`/api/source?${q}`).then((r) => json<SourceSlice>(r));
}

export interface RuntimeEdge {
  from: string;
  to: string;
  kind: string;
  count: number;
  lastSeen: number;
  trace: string;
}

export interface SearchHit {
  trace: string;
  span: string;
  node?: string;
  name?: string;
  type?: string;
  op?: string;
  service: string;
  start: number;
  where: string;
}

export const fetchTraces = (opts: { q?: string; errors?: boolean; node?: string; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.q) q.set("q", opts.q);
  if (opts.errors) q.set("errors", "1");
  if (opts.node) q.set("node", opts.node);
  if (opts.limit) q.set("limit", String(opts.limit));
  return fetch(`/api/traces?${q}`).then((r) => json<TraceSummary[]>(r));
};
export const fetchTrace = (id: string) => fetch(`/api/traces/${encodeURIComponent(id)}`).then((r) => json<TraceData>(r));
export const clearTraces = () => fetch("/api/traces", { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r));
export const fetchRuntimeEdges = () => fetch("/api/runtime/edges").then((r) => json<RuntimeEdge[]>(r));
export const fetchRuntimeStats = () => fetch("/api/runtime/stats").then((r) => json<{ traces: number; lastEventAt: number | null }>(r));
export const searchValue = (value: string) => fetch(`/api/search?value=${encodeURIComponent(value)}`).then((r) => json<SearchHit[]>(r));

export const editorLink = (absPath: string, line: number) =>
  `vscode://file/${absPath.replace(/\\/g, "/")}:${line}`;
