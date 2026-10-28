// FlowLens graph schema (flowlens/graph@1). Mirrors schema/graph.schema.json.
// Every language adapter emits these shapes; the UI only ever reads them.

export type NodeKind =
  | "service" // a deployable unit (one scanned root)
  | "route" // HTTP entry point (source)
  | "entry" // other entry point: CLI main, scheduled job (source)
  | "function" // code that transforms data
  | "table" // database table (sink / source)
  | "topic" // message topic, routing key or task queue (channel)
  | "bucket" // object storage bucket (sink / source)
  | "external"; // a system outside the scanned repo

// Edges always point in the direction data moves.
export type EdgeKind =
  | "handles" // route/entry/topic -> function that receives the data
  | "calls" // function -> function
  | "reads" // table/bucket -> function
  | "writes" // function -> table/bucket
  | "publishes" // function -> topic
  | "consumes" // topic -> handler function
  | "routes" // topic -> wildcard topic binding that receives it
  | "http"; // function -> route of another service (or external)

export type Origin = "static" | "runtime" | "both";

export interface Evidence {
  file: string;
  line?: number | null;
  op?: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  service?: string;
  module?: string;
  file?: string;
  line?: number;
  endLine?: number;
  [attr: string]: unknown;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  origin: Origin;
  evidence: Evidence[];
  ops?: string[];
  ambiguous?: boolean;
  runtimeCount?: number; // times observed at runtime (set when runtime edges are merged in)
}

export interface ServiceInfo {
  name: string;
  language: string;
  root: string;
  status: "scanned" | "skipped" | "failed";
  message?: string;
  stats?: Record<string, number>;
}

export interface FlowGraph {
  schema: "flowlens/graph@1";
  project: string;
  repoRoot: string;
  generatedAt: string;
  services: ServiceInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

export interface HttpCall {
  from: string;
  method: string;
  url: string;
  file: string;
  line: number;
}

/** What one adapter's scanner returns for one service. */
export interface PartialGraph {
  service: Omit<ServiceInfo, "status">;
  nodes: GraphNode[];
  edges: Omit<GraphEdge, "id">[];
  httpCalls: HttpCall[];
  warnings: string[];
}
