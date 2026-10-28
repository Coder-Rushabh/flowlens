import { useEffect, useState } from "react";
import type { Evidence, GraphEdge, GraphNode } from "../../../core/src/types.ts";
import { fetchTraces } from "../api.ts";
import { fmtAgo, fmtMs, type TraceSummary } from "../runtime/model.ts";
import { defaultAction, type GraphIndex, type Route, type View } from "../graph/views.ts";
import { EDGE_KINDS, NODE_KINDS } from "../kinds.ts";
import type { Selection } from "./Canvas.tsx";
import { SourceView } from "./SourceView.tsx";

interface Props {
  ix: GraphIndex;
  view: View;
  selection: Selection;
  onNavigate: (r: Route) => void;
  onSelect: (s: Selection) => void;
}

const META_KEYS: [string, string][] = [
  ["service", "Service"], ["module", "Module"], ["method", "Method"], ["path", "Path"], ["schema", "Schema"],
  ["transport", "Transport"], ["trigger", "Trigger"], ["target", "Target"], ["language", "Language"], ["root", "Root"],
];

export function Inspector({ ix, view, selection, onNavigate, onSelect }: Props) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  useEffect(() => setEvidence(null), [selection]);

  if (!selection) {
    return (
      <aside className="fl-inspector">
        <div className="fl-empty">
          <p><b>Click</b> a node or edge to inspect it.</p>
          <p><b>Double-click</b> to drill in: system → service → module → function flow.</p>
          <p>Tables, buckets and external systems open their <b>lineage</b>: everything upstream that writes into them.</p>
        </div>
      </aside>
    );
  }

  if (selection.type === "edge") {
    const ve = view.edges.find((e) => e.id === selection.id);
    if (!ve) return <aside className="fl-inspector" />;
    const refs = ve.refs.map((id) => ix.edgeById.get(id)).filter((e): e is GraphEdge => !!e);
    const src = view.nodes.find((n) => n.id === ve.source);
    const dst = view.nodes.find((n) => n.id === ve.target);
    return (
      <aside className="fl-inspector">
        <header>
          <span className="fl-chip" style={{ ["--kind" as string]: EDGE_KINDS[ve.kind]?.color }}>{EDGE_KINDS[ve.kind]?.title ?? ve.kind}</span>
          <h2>{src?.label} → {dst?.label}</h2>
          <div className="fl-muted">{ve.count} underlying edge{ve.count === 1 ? "" : "s"}</div>
        </header>
        <section>
          <h3>Where in code</h3>
          <ul className="fl-list">
            {refs.slice(0, 60).map((e) => (
              <li key={e.id}>
                <div className="fl-row-title">
                  {ix.byId.get(e.from)?.name} → {ix.byId.get(e.to)?.name}
                  {e.ambiguous && <span className="fl-tag warn" title="Several routes match this URL">ambiguous</span>}
                </div>
                <EvidenceList items={e.evidence} onPick={setEvidence} />
              </li>
            ))}
          </ul>
        </section>
        {evidence && <SourceView file={evidence.file} line={evidence.line ?? 1} />}
      </aside>
    );
  }

  const vnode = view.nodes.find((n) => n.id === selection.id);
  const node = vnode?.ref ? ix.byId.get(vnode.ref) : undefined;
  if (!vnode) return <aside className="fl-inspector" />;
  const kind = NODE_KINDS[vnode.kind] ?? NODE_KINDS.function;

  return (
    <aside className="fl-inspector">
      <header>
        <span className="fl-chip" style={{ ["--kind" as string]: kind.color }}>{kind.chip}</span>
        <h2>{node?.name ?? vnode.label}</h2>
        {vnode.sub && <div className="fl-muted">{vnode.sub}</div>}
        <div className="fl-actions">
          {vnode.drill && vnode.drill.view !== "flow" && <button onClick={() => onNavigate(vnode.drill!)}>{drillLabel(vnode.drill)}</button>}
          {node && node.kind !== "service" && (
            <>
              <button onClick={() => onNavigate({ view: "flow", node: node.id, dir: "down" })}>Trace downstream</button>
              <button onClick={() => onNavigate({ view: "flow", node: node.id, dir: "up" })}>Lineage (upstream)</button>
            </>
          )}
        </div>
      </header>

      {node && <NodeMeta node={node} />}
      {node?.doc ? <p className="fl-doc">{String(node.doc)}</p> : null}

      {node?.file && node.kind === "function" && !evidence && (
        <section>
          <h3>Source</h3>
          <SourceView file={node.file} line={Number(node.line ?? 1)} end={Number(node.endLine ?? node.line ?? 1)} highlight={Number(node.line ?? 1)} />
        </section>
      )}
      {evidence && (
        <section>
          <h3>
            Evidence <button className="fl-link" onClick={() => setEvidence(null)}>clear</button>
          </h3>
          <SourceView file={evidence.file} line={evidence.line ?? 1} />
        </section>
      )}

      {node && node.kind !== "service" && <RecentRuns nodeId={node.id} onNavigate={onNavigate} />}

      {node ? (
        <>
          <EdgeGroup title="Data in" ix={ix} edges={ix.inc.get(node.id) ?? []} side="from" onNavigate={onNavigate} onEvidence={setEvidence} />
          <EdgeGroup title="Data out" ix={ix} edges={ix.out.get(node.id) ?? []} side="to" onNavigate={onNavigate} onEvidence={setEvidence} />
        </>
      ) : vnode.members?.length ? (
        <section>
          <h3>Contains ({vnode.members.length})</h3>
          <ul className="fl-list">
            {vnode.members.slice(0, 150).map((id) => {
              const m = ix.byId.get(id);
              return m ? (
                <li key={id}>
                  <button className="fl-link" onClick={() => onNavigate(defaultAction(m))}>{m.name}</button>
                </li>
              ) : null;
            })}
          </ul>
        </section>
      ) : null}
      <div className="fl-hint">
        <button className="fl-link" onClick={() => onSelect(null)}>Clear selection</button>
      </div>
    </aside>
  );
}

function RecentRuns({ nodeId, onNavigate }: { nodeId: string; onNavigate: (r: Route) => void }) {
  const [runs, setRuns] = useState<TraceSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    setRuns(null);
    fetchTraces({ node: nodeId, limit: 6 }).then((r) => alive && setRuns(r)).catch(() => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, [nodeId]);
  if (!runs?.length) return null;
  return (
    <section>
      <h3>
        Recent runs through here{" "}
        <button className="fl-link" onClick={() => onNavigate({ view: "traces", node: nodeId })}>all</button>
      </h3>
      <ul className="fl-list">
        {runs.map((t) => (
          <li key={t.trace}>
            <button className="fl-link" onClick={() => onNavigate({ view: "trace", id: t.trace })}>{t.rootName}</button>
            <span className="fl-muted"> · {fmtMs((t.end - t.start) * 1000)} · {fmtAgo(t.start)}</span>
            {t.errors > 0 && <span className="fl-tag err">error</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function drillLabel(r: Route): string {
  switch (r.view) {
    case "service": return "Open service";
    case "module": return "Open module";
    case "system": return "Expand";
    case "flow": return r.dir === "down" ? "Trace flow from here" : "Lineage (upstream)";
    default: return "Open";
  }
}

function NodeMeta({ node }: { node: GraphNode }) {
  const rows = META_KEYS.filter(([k]) => node[k] !== undefined && node[k] !== "").map(([k, label]) => [label, String(node[k])]);
  if (node.kind === "function") {
    const params = Array.isArray(node.params) ? (node.params as string[]).join(", ") : "";
    rows.push(["Signature", `${node.isAsync ? "async " : ""}${String(node.name).split(".").pop()}(${params})${node.returns ? ` → ${node.returns}` : ""}`]);
    if (Array.isArray(node.decorators) && node.decorators.length) rows.push(["Decorators", (node.decorators as string[]).map((d) => `@${d}`).join("\n")]);
  }
  if (node.file) rows.push(["File", `${node.file}${node.line ? `:${node.line}` : ""}`]);
  if (!rows.length) return null;
  return (
    <dl className="fl-meta">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function EdgeGroup({ title, ix, edges, side, onNavigate, onEvidence }: {
  title: string;
  ix: GraphIndex;
  edges: GraphEdge[];
  side: "from" | "to";
  onNavigate: (r: Route) => void;
  onEvidence: (e: Evidence) => void;
}) {
  if (!edges.length) return null;
  const byKind = new Map<string, GraphEdge[]>();
  for (const e of edges) (byKind.get(e.kind) ?? byKind.set(e.kind, []).get(e.kind)!).push(e);
  return (
    <section>
      <h3>{title} ({edges.length})</h3>
      {[...byKind].map(([kind, list]) => (
        <div key={kind} className="fl-edge-group">
          <div className="fl-edge-kind" style={{ color: EDGE_KINDS[kind]?.color }}>{EDGE_KINDS[kind]?.title ?? kind}</div>
          <ul className="fl-list">
            {list.slice(0, 80).map((e) => {
              const other = ix.byId.get(side === "from" ? e.from : e.to);
              if (!other) return null;
              return (
                <li key={e.id}>
                  <button className="fl-link" onClick={() => onNavigate(defaultAction(other))} title={other.id}>
                    {other.name}
                  </button>
                  {other.service && other.kind !== "service" ? <span className="fl-muted"> · {other.service}</span> : null}
                  {e.ops?.length ? <span className="fl-tag">{e.ops.join(", ")}</span> : null}
                  <EvidenceList items={e.evidence} onPick={onEvidence} />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function EvidenceList({ items, onPick }: { items: Evidence[]; onPick: (e: Evidence) => void }) {
  if (!items.length) return null;
  return (
    <span className="fl-evidence">
      {items.slice(0, 6).map((ev, i) => (
        <button key={i} className="fl-link" onClick={() => onPick(ev)} title={`${ev.file}:${ev.line ?? ""}`}>
          L{ev.line ?? "?"}
        </button>
      ))}
      {items.length > 6 && <span className="fl-muted">+{items.length - 6}</span>}
    </span>
  );
}
