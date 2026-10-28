import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlowGraph } from "../../core/src/types.ts";
import { fetchGraph, fetchRuntimeEdges, fetchRuntimeStats, rescan, type RuntimeEdge } from "./api.ts";
import { Canvas, type Motion, type Selection } from "./components/Canvas.tsx";
import { usePlayer } from "./components/Player.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Search } from "./components/Search.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TraceDebugger } from "./components/TraceDebugger.tsx";
import { TraceList } from "./components/TraceList.tsx";
import { layoutView, type Positioned } from "./graph/layout.ts";
import { buildView, flowWave, hashToRoute, indexGraph, mergeRuntime, routeToHash, type Route, type ViewOptions } from "./graph/views.ts";
import { syntheticNode } from "./runtime/model.ts";

const OPTS_KEY = "flowlens.options";

function loadOptions(): ViewOptions {
  const fallback = { groupTables: true, followAsync: true };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => hashToRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(hashToRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((r: Route) => {
    location.hash = routeToHash(r);
  }, []);
  return [route, navigate];
}

/** Map runtime ids onto static ones where they differ only by schema (`orders` vs `sales.orders`). */
function makeFold(graph: FlowGraph | null) {
  const ids = new Set(graph?.nodes.map((n) => n.id) ?? []);
  const tables = graph?.nodes.filter((n) => n.kind === "table") ?? [];
  const cache = new Map<string, string>();
  return (id: string) => {
    if (ids.has(id) || !id.startsWith("table:")) return id;
    const hit = cache.get(id);
    if (hit) return hit;
    const name = id.slice(6);
    const twins = tables.filter((t) => t.name === name || t.name.endsWith(`.${name}`) || name.endsWith(`.${t.name}`));
    const folded = twins.length === 1 ? twins[0].id : id;
    cache.set(id, folded);
    return folded;
  };
}

export function App() {
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [runtime, setRuntime] = useState<RuntimeEdge[]>([]);
  const [runs, setRuns] = useState<{ traces: number; lastEventAt: number | null }>({ traces: 0, lastEventAt: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [route, navigate] = useHashRoute();
  const [opts, setOpts] = useState<ViewOptions>(loadOptions);
  const [selection, setSelection] = useState<Selection>(null);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [layout, setLayout] = useState<{ key: string; pos: Map<string, Positioned> } | null>(null);

  const load = useCallback(() => {
    fetchGraph().then(setGraph).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  // runtime overlay: refresh observed edges whenever new events arrive
  useEffect(() => {
    let alive = true;
    let last: number | null | undefined;
    const tick = () =>
      fetchRuntimeStats()
        .then((s) => {
          if (!alive) return;
          setRuns(s);
          if (s.lastEventAt !== last) {
            last = s.lastEventAt;
            fetchRuntimeEdges().then((r) => alive && setRuntime(r));
          }
        })
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
    } catch {
      /* storage unavailable: options just won't persist */
    }
  }, [opts]);

  const fold = useMemo(() => makeFold(graph), [graph]);
  const merged = useMemo(() => (graph ? mergeRuntime(graph, runtime, (id) => syntheticNode(id)) : null), [graph, runtime]);
  const ix = useMemo(() => (merged ? indexGraph(merged) : null), [merged]);
  const isRuntimeRoute = route.view === "traces" || route.view === "trace";
  const view = useMemo(() => (ix && !isRuntimeRoute ? buildView(ix, route, opts) : null), [ix, route, opts, isRuntimeRoute]);

  useEffect(() => {
    if (!view) return;
    setStepIndex(null);
    const start = view.nodes.find((n) => n.start);
    setSelection(start ? { type: "node", id: start.id } : null);
    let alive = true;
    layoutView(view)
      .then((pos) => alive && setLayout({ key: view.key, pos }))
      .catch((e: Error) => alive && setError(`Layout failed: ${e.message}`));
    return () => {
      alive = false;
    };
    // re-layout only when the view's shape changes, not when runtime counts tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key, view?.nodes.length]);

  // arrow keys walk the steps of a static flow
  useEffect(() => {
    const steps = view?.steps;
    if (!steps?.length) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      setStepIndex((i) => {
        const next = i === null ? 0 : Math.max(0, Math.min(steps.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)));
        setSelection({ type: "node", id: steps[next].id });
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // play a static flow wave by wave: every edge leaving the same node animates together
  const advance = useCallback(() => {
    const steps = view?.steps;
    if (!view || !steps?.length) return false;
    const from = stepIndex === null ? 0 : stepIndex + 1;
    if (from >= steps.length) return false;
    const next = flowWave(view, from).end;
    setStepIndex(next);
    setSelection({ type: "node", id: steps[next].id });
    return true;
  }, [view, stepIndex]);
  const player = usePlayer(stepIndex, advance);
  const { playing, setPlaying } = player;
  const togglePlay = useCallback(() => {
    if (!playing && view?.steps && stepIndex !== null && stepIndex >= view.steps.length - 1) setStepIndex(null);
    setPlaying(!playing);
  }, [playing, view, stepIndex, setPlaying]);
  useEffect(() => setPlaying(false), [view?.key, setPlaying]);
  const motion: Motion | undefined = useMemo(
    () => (view?.steps && stepIndex !== null ? { packets: flowWave(view, stepIndex).packets, tick: stepIndex, dur: player.dur } : undefined),
    [view, stepIndex, player.dur],
  );

  const drill = useCallback(
    (id: string) => {
      const v = view?.nodes.find((n) => n.id === id);
      if (v?.drill) navigate(v.drill);
    },
    [view, navigate],
  );

  const doRescan = async () => {
    setBusy(true);
    try {
      await rescan();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !graph) return <div className="fl-fatal">Could not load the graph: {error}</div>;
  if (!ix) return <div className="fl-fatal">Loading graph…</div>;
  const ready = view && layout?.key === view.key;
  const crumbs = view?.crumbs ?? [
    { label: ix.graph.project, route: { view: "system" } as Route },
    ...(route.view === "trace" ? [{ label: "Runs", route: { view: "traces" } as Route }, { label: "Debugger" }] : [{ label: "Runs" }]),
  ];
  const recent = runs.lastEventAt !== null && Date.now() / 1000 - runs.lastEventAt < 10;

  return (
    <div className="fl-app">
      <header className="fl-top">
        <a className="fl-brand" href="#/system" title="System map">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="8" cy="16" r="5" fill="var(--k-route)" />
            <circle cx="24" cy="8" r="5" fill="var(--k-service)" />
            <circle cx="24" cy="24" r="5" fill="var(--k-table)" />
            <path d="M12 15 20 9M12 17l8 6" stroke="var(--fg-muted)" strokeWidth="2" />
          </svg>
          FlowLens
        </a>
        <ol className="fl-crumbs">
          {crumbs.map((c, i) => (
            <li key={i}>{c.route ? <button className="fl-link" onClick={() => navigate(c.route!)}>{c.label}</button> : <span>{c.label}</span>}</li>
          ))}
        </ol>
        <Search ix={ix} onNavigate={navigate} />
        <div className="fl-toggles">
          {route.view === "system" && (
            <label><input type="checkbox" checked={opts.groupTables} onChange={(e) => setOpts({ ...opts, groupTables: e.target.checked })} /> Group tables</label>
          )}
          {route.view === "flow" && (
            <label><input type="checkbox" checked={opts.followAsync} onChange={(e) => setOpts({ ...opts, followAsync: e.target.checked })} /> Follow topics</label>
          )}
          <button className={`fl-runs${recent ? " is-live" : ""}`} onClick={() => navigate({ view: "traces" })} title="Recorded runs (runtime traces)">
            <span className="fl-live-dot" />Runs{runs.traces ? ` (${runs.traces})` : ""}
          </button>
          <button onClick={doRescan} disabled={busy} title={`Scanned ${new Date(ix.graph.generatedAt).toLocaleString()}`}>{busy ? "Scanning…" : "Rescan"}</button>
        </div>
      </header>
      {(view?.note || error) && <div className="fl-note">{error ?? view?.note}</div>}
      {route.view === "trace" ? (
        <TraceDebugger key={route.id} ix={ix} id={route.id} focusValue={route.focus} fold={fold} onNavigate={navigate} />
      ) : route.view === "traces" ? (
        <TraceList key={`${route.node}|${route.value}`} onNavigate={navigate} node={route.node} initialValue={route.value} />
      ) : (
        <main className="fl-main">
          <Sidebar ix={ix} route={route} view={view!} selection={selection} stepIndex={stepIndex} onStep={setStepIndex} onNavigate={navigate} onSelect={setSelection}
            player={{ playing, speed: player.speed, setSpeed: player.setSpeed, onToggle: togglePlay }} />
          {ready ? (
            <ReactFlowProvider>
              <Canvas view={view!} layout={layout!.pos} selection={selection} stepIndex={stepIndex} motion={motion} onSelect={setSelection} onDrill={drill} />
            </ReactFlowProvider>
          ) : (
            <div className="fl-canvas fl-center">Laying out {view?.nodes.length} nodes…</div>
          )}
          <Inspector ix={ix} view={view!} selection={selection} onNavigate={navigate} onSelect={setSelection} />
        </main>
      )}
    </div>
  );
}
