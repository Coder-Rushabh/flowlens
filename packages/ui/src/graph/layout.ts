import ELK from "elkjs/lib/elk.bundled.js";
import type { View, VNode } from "./views.ts";

const elk = new ELK();

export const NODE_HEIGHT = 58;

export function nodeWidth(n: VNode): number {
  const text = Math.max(n.label.length * 7.4, (n.sub?.length ?? 0) * 6.2);
  return Math.round(Math.min(340, Math.max(170, text + 64)));
}

export interface Positioned {
  x: number;
  y: number;
  width: number;
}

const COL_GAP = 170;
const SUBCOL_GAP = 36;
const ROW = NODE_HEIGHT + 18;

/**
 * Architecture layout for views whose nodes carry a `column` (system map):
 * fixed columns, each ordered by the barycenter of its neighbours to reduce crossings,
 * and wrapped into sub-columns when taller than the reference column.
 */
export function layoutColumns(view: View): Map<string, Positioned> {
  const cols = new Map<number, VNode[]>();
  for (const n of view.nodes) {
    const c = n.column ?? 1;
    (cols.get(c) ?? cols.set(c, []).get(c)!).push(n);
  }
  const order = [...cols.keys()].sort((a, b) => a - b);
  const neighbours = new Map<string, string[]>();
  for (const e of view.edges) {
    (neighbours.get(e.source) ?? neighbours.set(e.source, []).get(e.source)!).push(e.target);
    (neighbours.get(e.target) ?? neighbours.set(e.target, []).get(e.target)!).push(e.source);
  }
  // the busiest column is the anchor: alphabetical; others follow it by barycenter
  const anchor = order.reduce((a, b) => ((cols.get(b)!.length > cols.get(a)!.length) ? b : a), order[0]);
  const rank = new Map<string, number>();
  cols.get(anchor)!.sort((a, b) => a.label.localeCompare(b.label)).forEach((n, i) => rank.set(n.id, i));
  for (let pass = 0; pass < 2; pass++) {
    for (const c of order) {
      if (c === anchor && pass === 0) continue;
      const list = cols.get(c)!;
      const bary = (n: VNode) => {
        const r = (neighbours.get(n.id) ?? []).map((id) => rank.get(id)).filter((x): x is number => x !== undefined);
        return r.length ? r.reduce((s, x) => s + x, 0) / r.length : Number.MAX_SAFE_INTEGER;
      };
      list.sort((a, b) => bary(a) - bary(b) || a.label.localeCompare(b.label));
      list.forEach((n, i) => rank.set(n.id, i));
    }
  }
  const rowsMax = Math.max(8, Math.min(cols.get(anchor)!.length, 16));
  const out = new Map<string, Positioned>();
  const heights = order.map((c) => Math.min(cols.get(c)!.length, rowsMax) * ROW);
  const tallest = Math.max(...heights);
  let x = 0;
  order.forEach((c, ci) => {
    const list = cols.get(c)!;
    const sub = Math.ceil(list.length / rowsMax);
    const perCol = Math.ceil(list.length / sub);
    const width = Math.max(...list.map(nodeWidth));
    const top = (tallest - Math.min(list.length, perCol) * ROW) / 2;
    list.forEach((n, i) => {
      const s = Math.floor(i / perCol);
      out.set(n.id, { x: x + s * (width + SUBCOL_GAP), y: top + (i % perCol) * ROW, width: nodeWidth(n) });
    });
    x += sub * width + (sub - 1) * SUBCOL_GAP + (ci < order.length - 1 ? COL_GAP : 0);
  });
  return out;
}

/** Left-to-right layered layout: entry points first, data sinks drift right. */
export async function layoutView(view: View, aspectRatio = 1.6): Promise<Map<string, Positioned>> {
  if (view.nodes.length && view.nodes.every((n) => n.column !== undefined)) return layoutColumns(view);
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "22",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "48",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      // long layerings get cut into rows stacked top-to-bottom, so big views stay legible when fitted
      "elk.aspectRatio": String(aspectRatio),
      ...(view.nodes.length > 30 ? { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.layered.wrapping.additionalEdgeSpacing": "20" } : {}),
    },
    children: view.nodes.map((n) => ({
      id: n.id,
      width: nodeWidth(n),
      height: NODE_HEIGHT + (view.reserve ?? 0),
      ...(n.source ? { layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" } } : {}),
    })),
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const result = await elk.layout(graph);
  const out = new Map<string, Positioned>();
  for (const c of result.children ?? []) out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 170 });
  return out;
}
