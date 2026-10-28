import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { NODE_HEIGHT, type Positioned } from "../graph/layout.ts";
import type { View } from "../graph/views.ts";
import { EDGE_KINDS, NODE_KINDS } from "../kinds.ts";
import type { NodeCard } from "../runtime/model.ts";
import { DataEdge, type DataEdgeType, type EdgePacket } from "./DataEdge.tsx";
import { FlowNode, type FlowNodeType } from "./FlowNode.tsx";

export type Selection = { type: "node"; id: string } | { type: "edge"; id: string } | null;

/** Debugger mode: the call stack is lit, steps already walked stay visible, everything else dims. */
export interface Highlight {
  nodes: Set<string>;
  edges: Set<string>;
  current?: string;
  trail: Set<string>;
}

const nodeTypes = { flow: FlowNode };
const edgeTypes = { data: DataEdge };

/** Data in motion for the current step: packets keyed by edge id, restarted whenever tick changes. */
export interface Motion {
  packets: (EdgePacket & { edge: string })[];
  tick: number;
  dur: number;
  cards?: Map<string, NodeCard>;
}

interface Props {
  view: View;
  layout: Map<string, Positioned>;
  selection: Selection;
  stepIndex: number | null;
  highlight?: Highlight;
  motion?: Motion;
  onSelect: (s: Selection) => void;
  onDrill: (nodeId: string) => void;
}

export function Canvas({ view, layout, selection, stepIndex, highlight, motion, onSelect, onDrill }: Props) {
  // neighbourhood of the selected node (or the walked path) stays bright, the rest dims
  const focus = useMemo(() => {
    if (highlight) {
      const trailEdges = view.edges.filter((e) => highlight.trail.has(e.source) && highlight.trail.has(e.target)).map((e) => e.id);
      return { nodes: new Set([...highlight.nodes, ...highlight.trail]), edges: new Set([...highlight.edges, ...trailEdges]), strong: highlight.edges };
    }
    if (stepIndex !== null && view.steps) {
      const walked = view.steps.slice(0, stepIndex + 1);
      return { nodes: new Set(walked.map((s) => s.id)), edges: new Set(walked.flatMap((s) => (s.via ? [s.via] : []))) };
    }
    if (selection?.type === "node") {
      const edges = view.edges.filter((e) => e.source === selection.id || e.target === selection.id);
      return { nodes: new Set([selection.id, ...edges.flatMap((e) => [e.source, e.target])]), edges: new Set(edges.map((e) => e.id)) };
    }
    if (selection?.type === "edge") {
      const e = view.edges.find((x) => x.id === selection.id);
      return e ? { nodes: new Set([e.source, e.target]), edges: new Set([e.id]) } : null;
    }
    return null;
  }, [view, selection, stepIndex, highlight]);

  const stepNo = useMemo(() => new Map(view.steps?.map((s, i) => [s.id, i + 1]) ?? []), [view]);
  const current = highlight ? highlight.current : stepIndex !== null ? view.steps?.[stepIndex]?.id : undefined;
  const observedView = useMemo(() => view.edges.some((e) => e.observed), [view]);

  const nodes: FlowNodeType[] = useMemo(
    () =>
      view.nodes.map((v) => {
        const p = layout.get(v.id) ?? { x: 0, y: 0, width: 170 };
        return {
          id: v.id,
          type: "flow",
          position: { x: p.x, y: p.y },
          width: p.width,
          height: NODE_HEIGHT,
          selected: selection?.type === "node" && selection.id === v.id,
          data: { v, width: p.width, dim: !!focus && !focus.nodes.has(v.id), current: v.id === current, stepNo: stepNo.get(v.id), card: motion?.cards?.get(v.id) },
        };
      }),
    [view, layout, selection, focus, current, stepNo, motion],
  );

  const packetsByEdge = useMemo(() => {
    const m = new Map<string, EdgePacket[]>();
    for (const p of motion?.packets ?? []) (m.get(p.edge) ?? m.set(p.edge, []).get(p.edge)!).push(p);
    return m;
  }, [motion]);

  const edges: DataEdgeType[] = useMemo(
    () =>
      view.edges.map((e): DataEdgeType => {
        const k = EDGE_KINDS[e.kind] ?? EDGE_KINDS.calls;
        // leave/enter on the sides that face each other, so backward edges don't loop around nodes
        const a = layout.get(e.source);
        const b = layout.get(e.target);
        const forward = !a || !b || b.x + b.width / 2 >= a.x + a.width / 2 + 40;
        const backward = !!a && !!b && b.x + b.width < a.x;
        const lit = !focus || focus.edges.has(e.id);
        const strong = highlight ? highlight.edges.has(e.id) : lit && !!focus;
        // once runtime data exists, edges never observed fade so what actually happens stands out
        const unobserved = observedView && !e.observed && !highlight;
        const label = e.observed && !highlight
          ? `${k.title} · seen ×${e.observed}`
          : e.count > 1 ? `${k.title} ×${e.count}` : e.ops.length && e.kind !== "reads" && e.kind !== "calls" ? e.ops.slice(0, 2).join(", ") : undefined;
        const packets = packetsByEdge.get(e.id);
        return {
          id: e.id,
          type: "data",
          data: { packets, color: k.color, tick: motion?.tick ?? 0, dur: motion?.dur ?? 1 },
          zIndex: packets ? 2000 : undefined, // above nodes, even a selected one (raised to 1000)
          source: e.source,
          target: e.target,
          sourceHandle: forward ? "rs" : backward ? "ls" : "rs",
          targetHandle: forward ? "lt" : backward ? "rt" : "rt",
          selected: selection?.type === "edge" && selection.id === e.id,
          animated: strong && (e.kind === "writes" || e.kind === "publishes" || e.kind === "http" || e.kind === "handles" || !!highlight),
          label: packets ? undefined : (lit && focus) || (e.observed && !focus) ? label : undefined,
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          labelStyle: { fill: "var(--fg-muted)", fontSize: 11 },
          labelBgStyle: { fill: "var(--bg-panel)" },
          style: {
            stroke: k.color,
            strokeWidth: Math.min(1.4 + Math.log2(e.count + 1) * 0.6, 4) + (strong ? 1.2 : 0) + (e.observed ? 0.5 : 0),
            strokeDasharray: k.dashed || unobserved ? "5 4" : undefined,
            opacity: !lit ? 0.12 : highlight && !strong ? 0.45 : unobserved ? 0.4 : 0.95,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: k.color, width: 16, height: 16 },
        };
      }),
    [view, layout, focus, selection, highlight, observedView, packetsByEdge, motion],
  );

  // SVG attributes can't use CSS variables: resolve the theme colours for the minimap
  const palette = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const resolve = (v: string) => css.getPropertyValue(v.replace(/^var\((.*)\)$/, "$1")).trim() || "#888";
    return { kind: (k: string) => resolve(NODE_KINDS[k]?.color ?? "var(--k-function)"), mask: resolve("var(--minimap-mask)") };
  }, []);

  return (
    <div className="fl-canvas">
      <ReactFlow
        key={view.key}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => onSelect({ type: "node", id: n.id })}
        onNodeDoubleClick={(_, n) => onDrill(n.id)}
        onEdgeClick={(_, e) => onSelect({ type: "edge", id: e.id })}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        minZoom={0.05}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: 0.5 }}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <FollowStep layout={layout} nodeId={current} />
        <Background gap={24} size={1} color="var(--grid)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => palette.kind((n as FlowNodeType).data.v.kind)} maskColor={palette.mask} />
      </ReactFlow>
      <Legend view={view} observed={observedView && !highlight} />
    </div>
  );
}

/** Keeps the current step of a walk in view, like a debugger following the execution point. */
function FollowStep({ layout, nodeId }: { layout: Map<string, Positioned>; nodeId?: string }) {
  const rf = useReactFlow();
  useEffect(() => {
    const p = nodeId ? layout.get(nodeId) : undefined;
    if (!p) return;
    rf.setCenter(p.x + p.width / 2, p.y + NODE_HEIGHT / 2, { zoom: Math.max(rf.getZoom(), 0.85), duration: 280 });
  }, [rf, layout, nodeId]);
  return null;
}

function Legend({ view, observed }: { view: View; observed: boolean }) {
  const kinds = [...new Set(view.edges.map((e) => e.kind))];
  if (!kinds.length) return null;
  return (
    <div className="fl-legend">
      {observed && <span className="fl-legend-item"><b>solid</b> = seen at runtime, dashed = static only</span>}
      {kinds.map((k) => (
        <span key={k} className="fl-legend-item">
          <svg width="26" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="25" y2="4" stroke={EDGE_KINDS[k].color} strokeWidth="2" strokeDasharray={EDGE_KINDS[k].dashed ? "4 3" : undefined} />
          </svg>
          {EDGE_KINDS[k].title}
        </span>
      ))}
    </div>
  );
}
