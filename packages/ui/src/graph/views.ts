import type { EdgeKind, FlowGraph, GraphEdge, GraphNode, NodeKind } from "../../../core/src/types.ts";

// ------------------------------------------------------------------------ index
export interface GraphIndex {
  graph: FlowGraph;
  byId: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  inc: Map<string, GraphEdge[]>;
  edgeById: Map<string, GraphEdge>;
  serviceStats: Map<string, { functions: number; routes: number; modules: Set<string> }>;
  tablesBySchema: Map<string, string[]>;
}

export function indexGraph(graph: FlowGraph): GraphIndex {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  const edgeById = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    edgeById.set(e.id, e);
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }
  const serviceStats = new Map<string, { functions: number; routes: number; modules: Set<string> }>();
  const tablesBySchema = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.service && (n.kind === "function" || n.kind === "route")) {
      const s = serviceStats.get(n.service) ?? { functions: 0, routes: 0, modules: new Set<string>() };
      if (n.kind === "function") {
        s.functions++;
        if (n.module) s.modules.add(n.module);
      } else s.routes++;
      serviceStats.set(n.service, s);
    }
    if (n.kind === "table") {
      const schema = schemaOf(n);
      (tablesBySchema.get(schema) ?? tablesBySchema.set(schema, []).get(schema)!).push(n.id);
    }
  }
  return { graph, byId, out, inc, edgeById, serviceStats, tablesBySchema };
}

export const schemaOf = (n: GraphNode) => (typeof n.schema === "string" && n.schema ? n.schema : "(no schema)");

// ----------------------------------------------------------------------- routes
export type Route =
  | { view: "system"; expand?: string[] }
  | { view: "service"; service: string }
  | { view: "module"; service: string; module: string }
  | { view: "flow"; node: string; dir: "down" | "up" }
  | { view: "traces"; node?: string; value?: string }
  | { view: "trace"; id: string; focus?: string };

export function routeToHash(r: Route): string {
  const e = encodeURIComponent;
  switch (r.view) {
    case "traces": {
      const q = new URLSearchParams();
      if (r.node) q.set("node", r.node);
      if (r.value) q.set("value", r.value);
      return `#/traces${q.size ? `?${q}` : ""}`;
    }
    case "trace":
      return `#/trace/${e(r.id)}${r.focus ? `?focus=${e(r.focus)}` : ""}`;
    case "system":
      return r.expand?.length ? `#/system?expand=${r.expand.map(e).join(",")}` : "#/system";
    case "service":
      return `#/service/${e(r.service)}`;
    case "module":
      return `#/module/${e(r.service)}/${e(r.module)}`;
    case "flow":
      return `#/flow/${r.dir}/${e(r.node)}`;
  }
}

export function hashToRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").map(decodeURIComponent);
  if (parts[0] === "service" && parts[1]) return { view: "service", service: parts[1] };
  if (parts[0] === "module" && parts[2]) return { view: "module", service: parts[1], module: parts[2] };
  if (parts[0] === "flow" && parts[2]) return { view: "flow", dir: parts[1] === "up" ? "up" : "down", node: parts.slice(2).join("/") };
  const params = new URLSearchParams(query);
  if (parts[0] === "traces") return { view: "traces", node: params.get("node") ?? undefined, value: params.get("value") ?? undefined };
  if (parts[0] === "trace" && parts[1]) return { view: "trace", id: parts[1], focus: params.get("focus") ?? undefined };
  const expand = params.get("expand");
  return { view: "system", expand: expand ? expand.split(",").filter(Boolean) : undefined };
}

// ------------------------------------------------------------------- view model
export type VKind = NodeKind | "module" | "routes" | "schema";

export interface VNode {
  id: string;
  kind: VKind;
  label: string;
  sub?: string;
  ref?: string; // underlying graph node, when 1:1
  members?: string[]; // underlying graph nodes, when aggregated
  drill?: Route;
  start?: boolean;
  source?: boolean; // place in the first layer
  column?: number; // fixed column for architecture layouts
}

// system map columns: channels | services | storage | outside world
const SYSTEM_COLUMN: Record<string, number> = { topic: 0, entry: 0, service: 1, schema: 2, table: 2, bucket: 2, external: 3 };

export interface VEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  count: number;
  ops: string[];
  refs: string[];
  observed?: number; // how many times data moved along it at runtime
}

export interface RuntimeEdgeIn {
  from: string;
  to: string;
  kind: string;
  count: number;
}

/** Fold runtime-observed edges into the static graph (origin both / runtime, with counts). */
export function mergeRuntime(graph: FlowGraph, runtime: RuntimeEdgeIn[], synth: (id: string) => GraphNode): FlowGraph {
  if (!runtime.length) return graph;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.id, { ...e }]));
  for (const r of runtime) {
    for (const id of [r.from, r.to]) if (!nodes.has(id)) nodes.set(id, synth(id));
    const id = `${r.from}|${r.kind}|${r.to}`;
    const existing = edges.get(id);
    if (existing) {
      existing.origin = "both";
      existing.runtimeCount = r.count;
    } else {
      edges.set(id, { id, from: r.from, to: r.to, kind: r.kind as EdgeKind, origin: "runtime", evidence: [], runtimeCount: r.count });
    }
  }
  return { ...graph, nodes: [...nodes.values()], edges: [...edges.values()] };
}

export interface Step {
  id: string;
  depth: number;
  via?: string; // VEdge id that reached this node
}

export interface View {
  key: string;
  title: string;
  crumbs: { label: string; route?: Route }[];
  nodes: VNode[];
  edges: VEdge[];
  steps?: Step[];
  note?: string;
  reserve?: number; // extra height kept free under each node (value cards)
}

/** A packet on the static flow: the operation an edge performs, no values. */
export interface FlowPacket {
  edge: string;
  label: string;
}

/**
 * Steps reached from the same node form a wave: played together, they show where the data splits.
 * Returns the packets for step i (its wave up to i) and the index where its wave ends.
 */
export function flowWave(view: View, i: number): { packets: FlowPacket[]; end: number } {
  const steps = view.steps ?? [];
  const edge = (j: number) => (steps[j]?.via ? view.edges.find((e) => e.id === steps[j].via) : undefined);
  const anchor = (j: number) => {
    const e = edge(j);
    return e ? (e.source === steps[j].id ? e.target : e.source) : undefined;
  };
  const a0 = anchor(i);
  if (!a0) return { packets: [], end: i };
  let start = i;
  while (start > 0 && anchor(start - 1) === a0) start--;
  let end = i;
  while (end + 1 < steps.length && anchor(end + 1) === a0) end++;
  const packets: FlowPacket[] = [];
  for (let j = start; j <= i; j++) {
    const e = edge(j)!;
    const ops = e.ops.filter(Boolean).slice(0, 2).join(", ");
    packets.push({ edge: e.id, label: ops || (e.kind === "calls" ? "call" : e.kind) });
  }
  return { packets, end };
}

export interface ViewOptions {
  groupTables: boolean;
  followAsync: boolean;
}

const SOURCE_KINDS = new Set<string>(["route", "entry"]);
const CODE_KINDS = new Set<string>(["function", "route", "entry"]);

export const shortModule = (m?: unknown) => {
  const parts = String(m ?? "").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
};

export function defaultAction(n: GraphNode): Route {
  if (n.kind === "service") return { view: "service", service: n.name };
  if (n.kind === "table" || n.kind === "bucket" || n.kind === "external") return { view: "flow", node: n.id, dir: "up" };
  return { view: "flow", node: n.id, dir: "down" };
}

export function nodeToV(n: GraphNode, start = false): VNode {
  let sub: string | undefined;
  switch (n.kind) {
    case "function":
      sub = `${n.service} · ${shortModule(n.module)}`;
      break;
    case "route":
    case "entry":
      sub = n.service;
      break;
    case "table":
      sub = "table";
      break;
    case "topic":
      sub = n.transport === "task-queue" ? "task queue" : n.pattern ? "binding pattern" : "topic";
      break;
    case "bucket":
      sub = "object storage";
      break;
    case "external":
      sub = "external system";
      break;
  }
  return { id: n.id, kind: n.kind, label: n.name, sub, ref: n.id, drill: defaultAction(n), start, source: SOURCE_KINDS.has(n.kind) };
}

/**
 * Columns around a centre set (the service's modules, or the module's functions):
 * 0 = what feeds the centre, 1 = the centre, 2 = storage and what it feeds, 3 = other services / outside.
 */
function assignColumns(nodes: VNode[], edges: VEdge[], centre: (n: VNode) => boolean) {
  const centreIds = new Set(nodes.filter(centre).map((n) => n.id));
  const balance = new Map<string, number>();
  for (const e of edges) {
    if (centreIds.has(e.target) && !centreIds.has(e.source)) balance.set(e.source, (balance.get(e.source) ?? 0) - e.count);
    if (centreIds.has(e.source) && !centreIds.has(e.target)) balance.set(e.target, (balance.get(e.target) ?? 0) + e.count);
  }
  for (const n of nodes) {
    if (centreIds.has(n.id)) n.column = 1;
    else if (n.kind === "external" || n.kind === "service") n.column = 3;
    else if (n.kind === "table" || n.kind === "bucket" || n.kind === "schema") n.column = 2;
    else if (n.kind === "route" || n.kind === "routes" || n.kind === "entry") n.column = 0;
    else n.column = (balance.get(n.id) ?? 0) < 0 ? 0 : 2;
  }
}

/** Collapse graph edges onto view groups. `groupOf` returns null to drop a node. */
function aggregate(
  ix: GraphIndex,
  include: (e: GraphEdge) => boolean,
  groupOf: (n: GraphNode) => string | null,
  makeNode: (group: string, members: GraphNode[]) => VNode,
  always: GraphNode[] = [],
) {
  const groups = new Map<string, Map<string, GraphNode>>();
  const edges = new Map<string, VEdge>();
  const addMember = (g: string, n: GraphNode) => (groups.get(g) ?? groups.set(g, new Map()).get(g)!).set(n.id, n);
  for (const n of always) {
    const g = groupOf(n);
    if (g) addMember(g, n);
  }
  for (const e of ix.graph.edges) {
    if (!include(e)) continue;
    const from = ix.byId.get(e.from);
    const to = ix.byId.get(e.to);
    if (!from || !to) continue;
    const s = groupOf(from);
    const t = groupOf(to);
    if (!s || !t || s === t) continue;
    addMember(s, from);
    addMember(t, to);
    const key = `${s}|${e.kind}|${t}`;
    const ve = edges.get(key) ?? { id: key, source: s, target: t, kind: e.kind, count: 0, ops: [], refs: [] };
    ve.count++;
    if (e.runtimeCount) ve.observed = (ve.observed ?? 0) + e.runtimeCount;
    for (const op of e.ops ?? []) if (!ve.ops.includes(op) && ve.ops.length < 6) ve.ops.push(op);
    if (ve.refs.length < 200) ve.refs.push(e.id);
    edges.set(key, ve);
  }
  const nodes = [...groups].map(([g, members]) => makeNode(g, [...members.values()]));
  return { nodes, edges: [...edges.values()] };
}

function systemView(ix: GraphIndex, expand: string[], opts: ViewOptions): View {
  const tableCount = ix.graph.nodes.filter((n) => n.kind === "table").length;
  const group = opts.groupTables && tableCount > 0;
  const groupOf = (n: GraphNode): string | null => {
    if (CODE_KINDS.has(n.kind) || n.kind === "service") return n.service ? `svc:${n.service}` : null;
    if (n.kind === "table" && group && !expand.includes(schemaOf(n))) return `schema:${schemaOf(n)}`;
    return n.id;
  };
  const services = ix.graph.nodes.filter((n) => n.kind === "service");
  const { nodes, edges } = aggregate(
    ix,
    () => true,
    groupOf,
    (g, members) => {
      if (g.startsWith("svc:")) {
        const name = g.slice(4);
        const s = ix.serviceStats.get(name);
        const svc = ix.byId.get(g);
        return {
          id: g, kind: "service", label: name, ref: g,
          sub: `${svc?.language ?? ""} · ${s?.functions ?? 0} fn · ${s?.routes ?? 0} routes`,
          drill: { view: "service", service: name },
        };
      }
      if (g.startsWith("schema:")) {
        const schema = g.slice(7);
        const all = ix.tablesBySchema.get(schema) ?? [];
        return {
          id: g, kind: "schema", label: `${schema}.*`, sub: `${all.length} tables · double-click to expand`,
          members: all, drill: { view: "system", expand: [...expand, schema] },
        };
      }
      return nodeToV(members[0]);
    },
    services,
  );
  for (const n of nodes) n.column = SYSTEM_COLUMN[n.kind] ?? 1;
  const skipped = ix.graph.services.filter((s) => s.status !== "scanned");
  return {
    key: `system:${expand.join(",")}:${group}`,
    title: ix.graph.project,
    crumbs: [{ label: ix.graph.project }],
    nodes,
    edges,
    note: skipped.length ? `${skipped.length} service(s) not scanned: ${skipped.map((s) => s.name).join(", ")}` : undefined,
  };
}

function serviceView(ix: GraphIndex, svc: string): View {
  const inSvc = (n?: GraphNode) => !!n && n.service === svc && CODE_KINDS.has(n.kind);
  const handlerModule = (n: GraphNode) => ix.byId.get(String(n.handler ?? ""))?.module ?? "?";
  // topics this service touches: also show who is on the other side of them
  const topics = new Set<string>();
  for (const e of ix.graph.edges) {
    if (e.kind === "publishes" && inSvc(ix.byId.get(e.from))) topics.add(e.to);
    if (e.kind === "consumes" && inSvc(ix.byId.get(e.to))) topics.add(e.from);
  }
  const groupOf = (n: GraphNode): string | null => {
    if (n.kind === "service") return null;
    if (n.service === svc) {
      if (n.kind === "function") return `mod:${n.module}`;
      if (n.kind === "route") return `routes:${handlerModule(n)}`;
      return n.id;
    }
    if (CODE_KINDS.has(n.kind)) return `svc:${n.service}`;
    return n.id;
  };
  const include = (e: GraphEdge) =>
    inSvc(ix.byId.get(e.from)) ||
    inSvc(ix.byId.get(e.to)) ||
    ((e.kind === "consumes" || e.kind === "routes") && topics.has(e.from)) ||
    (e.kind === "publishes" && topics.has(e.to));
  const own = ix.graph.nodes.filter((n) => n.service === svc && n.kind === "function");
  const { nodes, edges } = aggregate(
    ix,
    include,
    groupOf,
    (g, members) => {
      if (g.startsWith("mod:")) {
        const module = g.slice(4);
        const all = own.filter((n) => n.module === module);
        return {
          id: g, kind: "module", label: shortModule(module), sub: `${all.length} functions · ${module}`,
          members: all.map((n) => n.id), drill: { view: "module", service: svc, module },
        };
      }
      if (g.startsWith("routes:")) {
        const module = g.slice(7);
        return {
          id: g, kind: "routes", label: `${members.length} route${members.length === 1 ? "" : "s"}`,
          sub: shortModule(module), members: members.map((n) => n.id), source: true,
          drill: { view: "module", service: svc, module },
        };
      }
      if (g.startsWith("svc:")) {
        const name = g.slice(4);
        return { id: g, kind: "service", label: name, sub: "other service", ref: g, drill: { view: "service", service: name } };
      }
      return nodeToV(members[0]);
    },
    own,
  );
  assignColumns(nodes, edges, (n) => n.kind === "module");
  return {
    key: `service:${svc}`,
    title: svc,
    crumbs: [{ label: ix.graph.project, route: { view: "system" } }, { label: svc }],
    nodes,
    edges,
  };
}

function moduleView(ix: GraphIndex, svc: string, module: string): View {
  const members = ix.graph.nodes.filter((n) => n.service === svc && n.module === module && n.kind === "function");
  const memberIds = new Set(members.map((n) => n.id));
  const groupOf = (n: GraphNode): string | null => {
    if (memberIds.has(n.id) || n.kind === "route" || n.kind === "entry") return n.id;
    if (n.kind === "function") return n.service === svc ? `mod:${n.module}` : `svc:${n.service}`;
    if (n.kind === "service") return null;
    return n.id;
  };
  const { nodes, edges } = aggregate(
    ix,
    (e) => memberIds.has(e.from) || memberIds.has(e.to),
    groupOf,
    (g, ms) => {
      if (g.startsWith("mod:")) {
        const m = g.slice(4);
        return { id: g, kind: "module", label: shortModule(m), sub: m, members: ms.map((n) => n.id), drill: { view: "module", service: svc, module: m } };
      }
      if (g.startsWith("svc:")) {
        const name = g.slice(4);
        return { id: g, kind: "service", label: name, sub: "other service", ref: g, drill: { view: "service", service: name } };
      }
      const v = nodeToV(ms[0]);
      if (memberIds.has(g)) v.sub = v.sub?.replace(`${svc} · `, "");
      return v;
    },
    members,
  );
  assignColumns(nodes, edges, (n) => memberIds.has(n.id));
  return {
    key: `module:${svc}:${module}`,
    title: module,
    crumbs: [
      { label: ix.graph.project, route: { view: "system" } },
      { label: svc, route: { view: "service", service: svc } },
      { label: shortModule(module) },
    ],
    nodes,
    edges,
  };
}

const MAX_FLOW_NODES = 220;
const DOWN_FROM: Record<string, EdgeKind[]> = {
  route: ["handles"],
  entry: ["handles"],
  function: ["calls", "writes", "publishes", "http"],
  topic: ["consumes", "routes"],
};
const UP_INTO: Record<string, EdgeKind[]> = {
  function: ["calls", "handles", "consumes"],
  route: ["http"],
  table: ["writes"],
  bucket: ["writes"],
  external: ["http"],
  topic: ["publishes", "routes"],
};

function flowView(ix: GraphIndex, startId: string, dir: "down" | "up", opts: ViewOptions): View {
  const start = ix.byId.get(startId);
  const crumbs: View["crumbs"] = [{ label: ix.graph.project, route: { view: "system" } }];
  if (!start) return { key: `flow:${startId}`, title: "Not found", crumbs, nodes: [], edges: [], note: `No node ${startId}` };
  if (start.service && start.kind !== "service") crumbs.push({ label: start.service, route: { view: "service", service: start.service } });
  crumbs.push({ label: `${dir === "down" ? "Flow from" : "Lineage of"} ${start.name}` });

  const nodeIds = new Set<string>([start.id]);
  const edgeIds = new Set<string>();
  const steps: Step[] = [{ id: start.id, depth: 0 }];
  const extra: Step[] = [];
  let truncated = false;
  const queue: [string, number][] = [[start.id, 0]];
  const expandable = (n: GraphNode) =>
    n.kind === "function" || n.kind === "route" || n.kind === "entry" || (n.kind === "topic" && (opts.followAsync || n.id === start.id));

  while (queue.length && !truncated) {
    const [id, depth] = queue.shift()!;
    const node = ix.byId.get(id)!;
    const edges = dir === "down"
      ? (ix.out.get(id) ?? []).filter((e) => DOWN_FROM[node.kind]?.includes(e.kind))
      : (ix.inc.get(id) ?? []).filter((e) => UP_INTO[node.kind]?.includes(e.kind));
    for (const e of edges) {
      const otherId = dir === "down" ? e.to : e.from;
      edgeIds.add(e.id);
      if (nodeIds.has(otherId)) continue;
      if (nodeIds.size >= MAX_FLOW_NODES) {
        truncated = true;
        break;
      }
      nodeIds.add(otherId);
      steps.push({ id: otherId, depth: depth + 1, via: e.id });
      const other = ix.byId.get(otherId)!;
      if (expandable(other)) queue.push([otherId, depth + 1]);
    }
    // context: what each function on the path reads
    if (dir === "down" && node.kind === "function") {
      for (const e of ix.inc.get(id) ?? []) {
        if (e.kind !== "reads") continue;
        edgeIds.add(e.id);
        if (!nodeIds.has(e.from)) {
          nodeIds.add(e.from);
          extra.push({ id: e.from, depth: depth + 1, via: e.id });
        }
      }
    }
  }
  if (dir === "up" && (start.kind === "table" || start.kind === "bucket")) {
    for (const e of ix.out.get(start.id) ?? []) {
      if (e.kind !== "reads") continue;
      edgeIds.add(e.id);
      if (!nodeIds.has(e.to)) {
        nodeIds.add(e.to);
        extra.push({ id: e.to, depth: 1, via: e.id });
      }
    }
  }
  const nodes = [...nodeIds].map((id) => nodeToV(ix.byId.get(id)!, id === start.id));
  if (dir === "down") nodes.forEach((n) => (n.source = n.start));
  const edges: VEdge[] = [...edgeIds]
    .map((id) => ix.edgeById.get(id)!)
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({ id: e.id, source: e.from, target: e.to, kind: e.kind, count: 1, ops: e.ops ?? [], refs: [e.id], observed: e.runtimeCount }));
  const reads = dir === "down" ? "Tables each step reads are shown as context. " : "Direct readers are shown as context. ";
  return {
    key: `flow:${dir}:${startId}:${opts.followAsync}`,
    title: start.name,
    crumbs,
    nodes,
    edges,
    steps: [...steps, ...extra],
    note: (truncated ? `Showing the first ${MAX_FLOW_NODES} nodes. ` : "") + reads +
      (opts.followAsync ? "" : "Async hops through topics are not followed."),
  };
}

export function buildView(ix: GraphIndex, route: Route, opts: ViewOptions): View {
  switch (route.view) {
    case "service":
      return serviceView(ix, route.service);
    case "module":
      return moduleView(ix, route.service, route.module);
    case "flow":
      return flowView(ix, route.node, route.dir, opts);
    case "traces":
    case "trace":
      return { key: route.view, title: "Runs", crumbs: [], nodes: [], edges: [] };
    default:
      return systemView(ix, route.expand ?? [], opts);
  }
}
