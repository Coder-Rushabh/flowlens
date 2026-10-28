import { useMemo, useState, type ComponentProps } from "react";
import type { GraphNode } from "../../../core/src/types.ts";
import { defaultAction, shortModule, type GraphIndex, type Route, type View } from "../graph/views.ts";
import { EDGE_KINDS, NODE_KINDS } from "../kinds.ts";
import type { Selection } from "./Canvas.tsx";
import { PlayerBar } from "./Player.tsx";

interface Props {
  ix: GraphIndex;
  route: Route;
  view: View;
  selection: Selection;
  stepIndex: number | null;
  onStep: (i: number | null) => void;
  onNavigate: (r: Route) => void;
  onSelect: (s: Selection) => void;
  player: ComponentProps<typeof PlayerBar>;
}

export function Sidebar(props: Props) {
  const { route } = props;
  return (
    <nav className="fl-sidebar">
      {route.view === "flow" ? <Steps {...props} /> : route.view === "system" ? <SystemList {...props} /> : <ServiceList {...props} />}
    </nav>
  );
}

function Filter({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input className="fl-filter" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
}

function Item({ node, label, sub, onClick, active }: { node?: GraphNode; label: string; sub?: string; onClick: () => void; active?: boolean }) {
  const kind = node ? NODE_KINDS[node.kind] : undefined;
  return (
    <li>
      <button className={`fl-item${active ? " is-active" : ""}`} onClick={onClick} style={kind ? { ["--kind" as string]: kind.color } : undefined}>
        <span className="fl-dot" />
        <span className="fl-item-label">{label}</span>
        {sub && <span className="fl-item-sub">{sub}</span>}
      </button>
    </li>
  );
}

function SystemList({ ix, onNavigate }: Props) {
  const [q, setQ] = useState("");
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const topics = ix.graph.nodes.filter((n) => n.kind === "topic" && match(n.name)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <Filter value={q} onChange={setQ} placeholder="Filter services and topics" />
      <h4>Services</h4>
      <ul>
        {ix.graph.services.filter((s) => match(s.name)).map((s) => {
          const stats = ix.serviceStats.get(s.name);
          return s.status === "scanned" ? (
            <Item key={s.name} node={ix.byId.get(`svc:${s.name}`)} label={s.name} sub={`${stats?.routes ?? 0} routes`} onClick={() => onNavigate({ view: "service", service: s.name })} />
          ) : (
            <li key={s.name} className="fl-item is-off" title={s.message}>
              <span className="fl-item-label">{s.name}</span>
              <span className="fl-item-sub">{s.status}</span>
            </li>
          );
        })}
      </ul>
      {topics.length > 0 && <h4>Topics</h4>}
      <ul>
        {topics.map((t) => (
          <Item key={t.id} node={t} label={t.name} onClick={() => onNavigate(defaultAction(t))} />
        ))}
      </ul>
    </>
  );
}

function ServiceList({ ix, route, onNavigate, onSelect, selection }: Props) {
  const [q, setQ] = useState("");
  const service = route.view === "service" || route.view === "module" ? route.service : "";
  const { entries, modules, functions } = useMemo(() => {
    const own = ix.graph.nodes.filter((n) => n.service === service);
    return {
      entries: own.filter((n) => n.kind === "route" || n.kind === "entry").sort((a, b) => String(a.path ?? a.name).localeCompare(String(b.path ?? b.name))),
      modules: [...new Set(own.filter((n) => n.kind === "function").map((n) => String(n.module)))].sort(),
      functions: route.view === "module" ? own.filter((n) => n.kind === "function" && n.module === route.module) : [],
    };
  }, [ix, service, route]);
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  return (
    <>
      <Filter value={q} onChange={setQ} placeholder="Filter entry points, modules" />
      {functions.length > 0 && (
        <>
          <h4>Functions in module</h4>
          <ul>
            {functions.filter((f) => match(f.name)).map((f) => (
              <Item key={f.id} node={f} label={f.name} active={selection?.type === "node" && selection.id === f.id}
                onClick={() => onSelect({ type: "node", id: f.id })} />
            ))}
          </ul>
        </>
      )}
      <h4>Entry points ({entries.length})</h4>
      <ul>
        {entries.filter((n) => match(n.name)).map((n) => (
          <Item key={n.id} node={n} label={n.name} onClick={() => onNavigate(defaultAction(n))} />
        ))}
      </ul>
      <h4>Modules ({modules.length})</h4>
      <ul>
        {modules.filter(match).map((m) => (
          <Item key={m} label={shortModule(m)} sub={m.split(".").length > 2 ? m : undefined}
            active={route.view === "module" && route.module === m}
            onClick={() => onNavigate({ view: "module", service, module: m })} />
        ))}
      </ul>
    </>
  );
}

function Steps({ ix, view, stepIndex, onStep, onSelect, player }: Props) {
  const steps = view.steps ?? [];
  const go = (i: number) => {
    const clamped = Math.max(0, Math.min(steps.length - 1, i));
    onStep(clamped);
    onSelect({ type: "node", id: steps[clamped].id });
  };
  return (
    <>
      <div className="fl-stepper">
        <button onClick={() => go((stepIndex ?? 0) - 1)} disabled={!steps.length || stepIndex === 0 || stepIndex === null} title="Previous step (←)">◀</button>
        <span>{stepIndex === null ? `${steps.length} steps` : `Step ${stepIndex + 1} / ${steps.length}`}</span>
        <button onClick={() => go(stepIndex === null ? 0 : stepIndex + 1)} disabled={!steps.length || stepIndex === steps.length - 1} title="Next step (→)">▶</button>
        {stepIndex !== null && <button onClick={() => { onStep(null); onSelect(null); }} title="Show everything">✕</button>}
      </div>
      {steps.length > 1 && <PlayerBar {...player} label="Play flow" />}
      <p className="fl-muted fl-small">
        Static walk of what <i>can</i> happen. To step through what <i>did</i> happen with real values, open a recorded run from{" "}
        <a href="#/traces">Runs</a>.
      </p>
      <ol className="fl-steps">
        {steps.map((s, i) => {
          const n = ix.byId.get(s.id);
          const via = s.via ? ix.edgeById.get(s.via) : undefined;
          if (!n) return null;
          return (
            <li key={s.id} className={i === stepIndex ? "is-active" : stepIndex !== null && i > stepIndex ? "is-future" : undefined}
              style={{ paddingLeft: 6 + Math.min(s.depth, 8) * 10, ["--kind" as string]: NODE_KINDS[n.kind]?.color }}>
              <button onClick={() => go(i)}>
                {via && <span className="fl-via" style={{ color: EDGE_KINDS[via.kind]?.color }}>{EDGE_KINDS[via.kind]?.title}</span>}
                <span className="fl-dot" />
                <span className="fl-item-label">{n.name}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
