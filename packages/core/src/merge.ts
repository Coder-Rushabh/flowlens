import type { EdgeKind, FlowGraph, GraphEdge, GraphNode, HttpCall, PartialGraph, ServiceInfo } from "./types.ts";

const edgeId = (from: string, kind: string, to: string) => `${from}|${kind}|${to}`;

/** AMQP-style topic match: `*` = exactly one word, `#` = zero or more words. */
export function topicMatches(pattern: string, key: string): boolean {
  const p = pattern.split(".");
  const k = key.split(".");
  const go = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length;
    if (p[i] === "#") return go(i + 1, j) || (j < k.length && go(i, j + 1));
    if (j === k.length) return false;
    return (p[i] === "*" || p[i] === k[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

// ------------------------------------------------------------------- HTTP linking
const STOP = new Set([
  "settings", "config", "cfg", "env", "os", "environ", "get", "self", "url", "urls", "uri", "base", "host", "hostname",
  "port", "addr", "address", "endpoint", "service", "svc", "api", "http", "https", "backend", "frontend", "server",
  "internal", "client", "localhost", "local", "app", "v1", "the",
]);

export const tokens = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));

export function splitUrl(url: string): { target?: string; path: string } {
  let target: string | undefined;
  let path = url.trim();
  const abs = path.match(/^(?:https?:)?\/\/([^/?#]+)(.*)$/i);
  const hole = path.match(/^\{([^}]+)\}(.*)$/);
  if (abs) {
    target = abs[1];
    path = abs[2];
  } else if (hole) {
    target = hole[1];
    path = hole[2];
  }
  path = path.split(/[?#]/)[0] || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return { target, path };
}

const segments = (p: string) => p.split("/").filter(Boolean);
const isParam = (s: string) => /^\{.*\}$/.test(s) || s.startsWith(":") || /^<.*>$/.test(s) || s.includes("__fl__");
/** Route params that swallow several segments: FastAPI {x:path}, Flask <path:x>, Next [...x], Express :x* */
const isGreedy = (s: string) => /^\{[^}]*:path\}/.test(s) || /^<path:/.test(s) || /^\{\.\.\./.test(s) || /^:\w+[*+]$/.test(s);
/** A route segment with a literal suffix after a param, e.g. `{name:path}.pdf` */
const greedySuffix = (s: string) => s.match(/^(?:\{[^}]*\}|<[^>]*>)(.+)$/)?.[1];

function segMatch(call: string, route: string): boolean {
  if (isParam(call) || isParam(route)) return true;
  const suffix = greedySuffix(route);
  if (suffix) return call.toLowerCase().endsWith(suffix.toLowerCase());
  return call.toLowerCase() === route.toLowerCase();
}

export function pathMatches(call: string[], route: string[], i = 0, j = 0): boolean {
  if (j === route.length) return i === call.length;
  if (i === call.length) return false;
  if (isGreedy(route[j])) {
    // consume one or more call segments; the last consumed one may carry the route's suffix
    for (let k = i + 1; k <= call.length; k++) {
      if (greedySuffix(route[j]) && !call[k - 1].toLowerCase().endsWith(greedySuffix(route[j])!.toLowerCase())) continue;
      if (pathMatches(call, route, k, j + 1)) return true;
    }
    return false;
  }
  return segMatch(call[i], route[j]) && pathMatches(call, route, i + 1, j + 1);
}

interface RouteRef {
  node: GraphNode;
  segs: string[];
}

export function linkHttpCall(call: HttpCall, routes: RouteRef[], callerService: string | undefined) {
  const { target, path } = splitUrl(call.url);
  const segs = segments(path);
  const literal = segs.filter((s) => !isParam(s)).length;
  const label = target ? target.replace(/^.*\./, "") : "external";
  if (literal === 0) return { matches: [] as GraphNode[], label, path };
  let candidates = routes.filter(
    (r) => (r.node.method === call.method || r.node.method === "ANY" || call.method === "REQUEST") && pathMatches(segs, r.segs),
  );
  if (candidates.length > 1 && target) {
    const want = new Set(tokens(target));
    const score = (r: RouteRef) => tokens(String(r.node.service ?? "")).filter((t) => want.has(t)).length;
    const best = Math.max(...candidates.map(score));
    if (best > 0) candidates = candidates.filter((r) => score(r) === best);
  }
  if (candidates.length > 1) {
    // prefer the route whose segments line up best: literal==literal, then param~param, then literal~param
    const align = (r: RouteRef) =>
      r.segs.reduce((score, rs, i) => {
        const cs = segs[i];
        if (cs === undefined) return score;
        if (!isParam(cs) && !isParam(rs)) return score + (cs.toLowerCase() === rs.toLowerCase() ? 3 : 0);
        if (isParam(cs) && isParam(rs)) return score + 2;
        return score + (isParam(rs) ? 1 : 0); // literal call segment filling a route param
      }, 0) - (r.node.method === "ANY" ? 1 : 0);
    const top = Math.max(...candidates.map(align));
    candidates = candidates.filter((r) => align(r) === top);
    const others = candidates.filter((r) => r.node.service !== callerService);
    if (others.length) candidates = others;
  }
  return { matches: candidates.slice(0, 5).map((r) => r.node), label, path };
}

// ------------------------------------------------------------------------- merge
export function mergeGraphs(
  project: string,
  repoRoot: string,
  partials: PartialGraph[],
  extraServices: ServiceInfo[] = [],
): FlowGraph {
  const nodes = new Map<string, GraphNode>();
  const warnings: string[] = [];
  const services: ServiceInfo[] = [];

  for (const part of partials) {
    services.push({ ...part.service, status: "scanned" });
    nodes.set(`svc:${part.service.name}`, {
      id: `svc:${part.service.name}`,
      kind: "service",
      name: part.service.name,
      service: part.service.name,
      language: part.service.language,
      root: part.service.root,
    });
    for (const n of part.nodes) {
      const existing = nodes.get(n.id);
      if (!existing) nodes.set(n.id, { ...n });
      else for (const [k, v] of Object.entries(n)) if (existing[k] === undefined) existing[k] = v;
    }
    warnings.push(...part.warnings.map((w) => `[${part.service.name}] ${w}`));
  }
  services.push(...extraServices);

  // Tables: fold `public.x` into `x`, then point unqualified names at their single qualified twin.
  const alias = new Map<string, string>();
  const tables = [...nodes.values()].filter((n) => n.kind === "table");
  for (const t of tables) {
    if (t.name.startsWith("public.")) alias.set(t.id, `table:${t.name.slice(7)}`);
  }
  for (const t of tables) {
    if (t.name.includes(".")) continue;
    const twins = tables.filter((o) => o.name.endsWith(`.${t.name}`) && !o.name.startsWith("public."));
    if (twins.length === 1) alias.set(t.id, twins[0].id);
  }
  for (const [from, to] of alias) {
    const src = nodes.get(from)!;
    if (!nodes.has(to)) nodes.set(to, { ...src, id: to, name: to.slice(6), schema: undefined });
    nodes.delete(from);
  }
  const canon = (id: string) => alias.get(id) ?? id;

  const edges = new Map<string, GraphEdge>();
  const addEdge = (e: Omit<GraphEdge, "id">) => {
    const from = canon(e.from);
    const to = canon(e.to);
    if (from === to) return;
    const id = edgeId(from, e.kind, to);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, { ...e, id, from, to, evidence: [...e.evidence], ...(e.ops ? { ops: [...e.ops] } : {}) });
      return;
    }
    for (const ev of e.evidence) {
      if (!existing.evidence.some((x) => x.file === ev.file && x.line === ev.line && x.op === ev.op)) {
        existing.evidence.push(ev);
      }
    }
    for (const op of e.ops ?? []) if (!(existing.ops ??= []).includes(op)) existing.ops.push(op);
  };
  for (const part of partials) for (const e of part.edges) addEdge(e);

  // Topics: concrete routing keys flow into the wildcard bindings that match them.
  const topics = [...nodes.values()].filter((n) => n.kind === "topic");
  for (const pattern of topics.filter((t) => t.pattern && t.name !== "#")) {
    for (const key of topics.filter((t) => !t.pattern)) {
      if (topicMatches(pattern.name, key.name)) addEdge({ from: key.id, to: pattern.id, kind: "routes", origin: "static", evidence: [] });
    }
  }

  // HTTP: link outbound calls to the route that serves them, or to an external system.
  const routes: RouteRef[] = [...nodes.values()]
    .filter((n) => n.kind === "route")
    .map((node) => ({ node, segs: segments(String(node.path ?? "")) }));
  for (const part of partials) {
    for (const call of part.httpCalls) {
      const { matches, label, path } = linkHttpCall(call, routes, part.service.name);
      const ev = { file: call.file, line: call.line, op: `${call.method} ${path}` };
      if (matches.length) {
        for (const m of matches) {
          addEdge({ from: call.from, to: m.id, kind: "http" as EdgeKind, origin: "static", evidence: [ev], ops: [ev.op], ...(matches.length > 1 ? { ambiguous: true } : {}) });
        }
      } else {
        // a generic hint (`base_url`) says nothing on its own: scope it to the calling service
        const generic = tokens(label).length === 0;
        const id = generic ? `ext:${part.service.name}:${label}` : `ext:${label}`;
        const name = generic ? `${part.service.name} → ${label}` : label;
        if (!nodes.has(id)) nodes.set(id, { id, kind: "external", name, target: call.url });
        addEdge({ from: call.from, to: id, kind: "http", origin: "static", evidence: [ev], ops: [ev.op] });
      }
    }
  }

  const finalEdges: GraphEdge[] = [];
  for (const e of edges.values()) {
    if (nodes.has(e.from) && nodes.has(e.to)) finalEdges.push(e);
    else warnings.push(`dropped edge with unknown endpoint: ${e.id}`);
  }

  return {
    schema: "flowlens/graph@1",
    project,
    repoRoot,
    generatedAt: new Date().toISOString(),
    services,
    nodes: [...nodes.values()],
    edges: finalEdges,
    warnings,
  };
}
