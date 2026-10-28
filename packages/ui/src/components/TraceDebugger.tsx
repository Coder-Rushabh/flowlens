import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTrace } from "../api.ts";
import { layoutView, type Positioned } from "../graph/layout.ts";
import type { GraphIndex, Route } from "../graph/views.ts";
import { EDGE_KINDS, NODE_KINDS } from "../kinds.ts";
import {
  buildTimeline, diff, fmtMs, nodeCards, spanEdgeKind, stackOf, stepNode, stepPackets, stepsWithValue, traceView,
  type TraceData, type TSpan, type TStep,
} from "../runtime/model.ts";
import { Canvas, type Highlight, type Motion, type Selection } from "./Canvas.tsx";
import { JsonTree } from "./JsonTree.tsx";
import { PlayerBar, usePlayer } from "./Player.tsx";
import { SourceView } from "./SourceView.tsx";

interface Props {
  ix: GraphIndex;
  id: string;
  focusValue?: string;
  fold: (id: string) => string;
  onNavigate: (r: Route) => void;
}

const short = (v: unknown, n = 40): string => {
  const s = v === undefined ? "" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function argsLabel(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(([k]) => k !== "__resumed__")
    .map(([k, v]) => `${k}=${short(v, 24)}`);
  const s = parts.join(", ");
  return s.length > 70 ? `${s.slice(0, 69)}…` : s;
}

const EVENT_BADGE: Record<string, string> = { db: "SQL", http: "HTTP", publish: "PUB", storage: "STORE" };

function stepLabel(s: TStep): { badge: string; text: string; tone?: string } {
  if (s.kind === "event") {
    const e = s.event;
    const d = (e.detail ?? {}) as Record<string, unknown>;
    if (e.type === "db") {
      const tables = e.targets.map((t) => t.node.replace(/^table:/, "")).join(", ");
      return { badge: "SQL", text: `${e.op} ${tables}${typeof d.rowcount === "number" && d.rowcount >= 0 ? ` · ${d.rowcount} row${d.rowcount === 1 ? "" : "s"}` : ""}`, tone: e.error ? "err" : "db" };
    }
    if (e.type === "http") return { badge: "HTTP", text: `${e.op}${d.status ? ` → ${d.status}` : ""}`, tone: e.error ? "err" : "http" };
    if (e.type === "publish") return { badge: "PUB", text: `publish ${String(d.routingKey ?? "")}`, tone: "topic" };
    return { badge: EVENT_BADGE[e.type] ?? e.type, text: `${e.op} ${String(d.bucket ?? "")}/${short(d.key, 30)}`, tone: "bucket" };
  }
  const sp = s.span;
  if (s.kind === "enter") {
    if (sp.type === "route") return { badge: "IN", text: sp.name, tone: "route" };
    if (sp.type === "consume") return { badge: "MSG", text: sp.name, tone: "topic" };
    return { badge: "→", text: `${sp.name}(${argsLabel(sp.input)})`, tone: s.async ? "topic" : undefined };
  }
  const ms = fmtMs((sp.end - sp.start) * 1000);
  if (sp.status === "error") return { badge: "✕", text: `${sp.name} raised ${sp.error?.type ?? "error"} · ${ms}`, tone: "err" };
  if (sp.type === "route") return { badge: "OUT", text: `${sp.name} → ${short((sp.output as Record<string, unknown>)?.status)} · ${ms}`, tone: "route" };
  if (sp.status === "yield") return { badge: "↩", text: `${sp.name} yielded ${short(sp.output)}`, tone: undefined };
  return { badge: "←", text: `${sp.name}${sp.output !== undefined && sp.output !== null ? ` = ${short(sp.output, 34)}` : ""} · ${ms}` };
}

export function TraceDebugger({ ix, id, focusValue, fold, onNavigate }: Props) {
  const [data, setData] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(focusValue ?? null);
  const [layout, setLayout] = useState<{ key: string; pos: Map<string, Positioned> } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // late parts of a run (queue consumers) keep arriving: refresh while it is recent
  useEffect(() => {
    let alive = true;
    setIndex(0);
    const load = () =>
      fetchTrace(id)
        .then((d) => alive && setData((prev) => (prev && prev.spans.length === d.spans.length && prev.events.length === d.events.length ? prev : d)))
        .catch((e: Error) => alive && setError(e.message));
    load();
    const timer = setInterval(() => {
      if (data?.trace && Date.now() / 1000 - data.trace.end > 120) return;
      load();
    }, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const steps = useMemo(() => (data ? buildTimeline(data) : []), [data]);
  const view = useMemo(() => (data ? traceView(ix, data, steps, fold) : null), [ix, data, steps, fold]);
  const valueHits = useMemo(() => (picked ? stepsWithValue(steps, picked) : []), [steps, picked]);

  useEffect(() => {
    if (!view) return;
    let alive = true;
    layoutView(view).then((pos) => alive && setLayout({ key: view.key + view.nodes.length, pos }));
    return () => {
      alive = false;
    };
  }, [view]);

  useEffect(() => {
    if (focusValue && valueHits.length) setIndex(valueHits[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusValue, valueHits.length > 0]);

  const step = steps[index] as TStep | undefined;
  const spanOf = (s?: TStep): TSpan | undefined => (s ? (s.kind === "event" ? s.span : s.span) : undefined);

  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(steps.length - 1, i))), [steps.length]);
  const stepOver = useCallback(() => {
    if (step?.kind === "enter") {
      const exit = steps.findIndex((s, i) => i > index && s.kind === "exit" && s.span.span === step.span.span);
      if (exit >= 0) return go(exit + 1 < steps.length ? exit + 1 : exit);
    }
    go(index + 1);
  }, [step, steps, index, go]);
  const stepBackOver = useCallback(() => {
    const prev = steps[index - 1];
    if (prev?.kind === "exit") {
      const enter = steps.findIndex((s) => s.kind === "enter" && s.span.span === prev.span.span);
      if (enter >= 0) return go(enter);
    }
    go(index - 1);
  }, [steps, index, go]);
  const stepOut = useCallback(() => {
    const sp = spanOf(step);
    const parent = sp?.parent;
    const target = steps.findIndex((s, i) => i > index && s.kind === "exit" && (s.span.span === parent || (step?.kind !== "exit" && s.span.span === sp?.span)));
    go(target >= 0 ? target : steps.length - 1);
  }, [step, steps, index, go]);

  const advance = useCallback(() => {
    if (index >= steps.length - 1) return false;
    setIndex(index + 1);
    return true;
  }, [index, steps.length]);
  const player = usePlayer(index, advance);
  const { playing, setPlaying } = player;
  const togglePlay = useCallback(() => {
    if (!playing && index >= steps.length - 1) setIndex(0); // replay from the start
    setPlaying(!playing);
  }, [playing, index, steps.length, setPlaying]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["INPUT", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
      const map: Record<string, () => void> = {
        " ": togglePlay,
        ArrowRight: e.shiftKey ? stepOver : () => go(index + 1),
        ArrowLeft: e.shiftKey ? stepBackOver : () => go(index - 1),
        ArrowUp: stepOut,
        Home: () => go(0),
        End: () => go(steps.length - 1),
      };
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, stepOver, stepBackOver, stepOut, steps.length, togglePlay]);

  const motion: Motion | undefined = useMemo(
    () => (data ? { packets: stepPackets(step, data, fold), tick: index, dur: player.dur, cards: nodeCards(steps, index, fold) } : undefined),
    [data, step, steps, index, fold, player.dur],
  );

  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const highlight: Highlight | undefined = useMemo(() => {
    if (!data || !step) return undefined;
    const stack = stackOf(data, spanOf(step));
    const nodes = new Set(stack.map((s) => fold(s.node)));
    const edges = new Set<string>();
    for (let i = 1; i < stack.length; i++) {
      const kind = spanEdgeKind(stack[i - 1].node, stack[i].node);
      if (kind) edges.add(`${fold(stack[i - 1].node)}|${kind}|${fold(stack[i].node)}`);
    }
    const current = fold(stepNode(step));
    nodes.add(current);
    if (step.kind === "event" && step.span) {
      const owner = fold(step.span.node);
      for (const t of step.event.targets) {
        const target = fold(t.node);
        if (step.event.type === "publish") edges.add(`${owner}|publishes|${target}`);
        else if (["select", "get", "stat", "list"].includes(t.op)) edges.add(`${target}|reads|${owner}`);
        else edges.add(`${owner}|writes|${target}`);
      }
    }
    const trail = new Set(steps.slice(0, index + 1).map((s) => fold(stepNode(s))));
    return { nodes, edges, current, trail };
  }, [data, step, steps, index, fold]);

  if (error) return <div className="fl-fatal">Could not load trace: {error}</div>;
  if (!data || !view) return <div className="fl-fatal">Loading trace…</div>;
  const ready = layout?.key === view.key + view.nodes.length;
  const total = data.trace ? fmtMs((data.trace.end - data.trace.start) * 1000) : "";

  return (
    <main className="fl-main">
      <nav className="fl-sidebar">
        <div className="fl-trace-head">
          <div className="fl-item-label"><b>{data.trace?.rootName ?? "run"}</b></div>
          <div className="fl-muted fl-small0">{data.trace?.services.join(", ")} · {total} · {steps.length} steps</div>
        </div>
        <div className="fl-stepper">
          <button onClick={() => go(0)} title="First step (Home)">⏮</button>
          <button onClick={stepBackOver} title="Step back over (Shift+←)">↶</button>
          <button onClick={() => go(index - 1)} disabled={index === 0} title="Step back (←)">◀</button>
          <span>{index + 1} / {steps.length}</span>
          <button onClick={() => go(index + 1)} disabled={index >= steps.length - 1} title="Step (→)">▶</button>
          <button onClick={stepOver} title="Step over (Shift+→)">↷</button>
          <button onClick={stepOut} title="Step out (↑)">⤴</button>
        </div>
        <PlayerBar playing={playing} speed={player.speed} setSpeed={player.setSpeed} onToggle={togglePlay} />
        {picked && (
          <div className="fl-lineage-bar">
            <span>Tracing <b>{picked.length > 28 ? `${picked.slice(0, 27)}…` : picked}</b>: {valueHits.length} step{valueHits.length === 1 ? "" : "s"}</span>
            <button className="fl-link" onClick={() => setPicked(null)}>clear</button>
          </div>
        )}
        <ol className="fl-timeline" ref={listRef}>
          {steps.map((s, i) => {
            const l = stepLabel(s);
            const hit = picked && valueHits.includes(i);
            return (
              <li key={i} className={[i === index && "is-active", i > index && "is-future", hit && "is-hit"].filter(Boolean).join(" ")}
                style={{ paddingLeft: 6 + Math.min(s.depth, 10) * 11 }}>
                <button onClick={() => setIndex(i)} title={l.text}>
                  <span className={`fl-badge ${l.tone ?? ""}`}>{l.badge}</span>
                  <span className="fl-item-label">{l.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {ready ? (
        <ReactFlowProvider>
          <Canvas view={view} layout={layout!.pos} selection={null as Selection} stepIndex={null} highlight={highlight} motion={motion}
            onSelect={() => {}} onDrill={(nodeId) => {
              const i = steps.findIndex((s, k) => k > index && fold(stepNode(s)) === nodeId);
              const j = i >= 0 ? i : steps.findIndex((s) => fold(stepNode(s)) === nodeId);
              if (j >= 0) setIndex(j);
            }} />
        </ReactFlowProvider>
      ) : (
        <div className="fl-canvas fl-center">Laying out…</div>
      )}
      <StepInspector ix={ix} data={data} steps={steps} index={index} picked={picked} valueHits={valueHits}
        onPick={setPicked} onJump={setIndex} onNavigate={onNavigate} fold={fold} />
    </main>
  );
}

function StepInspector({ ix, data, steps, index, picked, valueHits, onPick, onJump, onNavigate, fold }: {
  ix: GraphIndex;
  data: TraceData;
  steps: TStep[];
  index: number;
  picked: string | null;
  valueHits: number[];
  onPick: (v: string) => void;
  onJump: (i: number) => void;
  onNavigate: (r: Route) => void;
  fold: (id: string) => string;
}) {
  const step = steps[index];
  if (!step) return <aside className="fl-inspector" />;
  const span = step.span;
  const stack = stackOf(data, span);
  const enterIndex = (s: TSpan) => steps.findIndex((x) => x.kind === "enter" && x.span.span === s.span);
  const staticNode = span ? ix.byId.get(fold(span.node)) : undefined;
  const file = span?.file ?? (staticNode?.file as string | undefined);
  const line = span?.line ?? (staticNode?.line as number | undefined);
  const kind = step.kind === "event" ? null : NODE_KINDS[staticNode?.kind ?? (span?.type === "route" ? "route" : span?.type === "consume" ? "topic" : "function")];

  return (
    <aside className="fl-inspector">
      {step.kind === "event" ? (
        <EventDetail step={step} picked={picked} onPick={onPick} />
      ) : (
        <CallDetail span={step.span} entering={step.kind === "enter"} color={kind?.color} picked={picked} onPick={onPick} onNavigate={onNavigate} fold={fold} />
      )}

      {stack.length > 1 && (
        <section>
          <h3>Call stack</h3>
          <ol className="fl-stack">
            {[...stack].reverse().map((s) => (
              <li key={s.span}>
                <button className="fl-link" onClick={() => onJump(enterIndex(s))}>{s.name}</button>
                <span className="fl-muted"> · {s.service}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {picked && (
        <section>
          <h3 className="fl-nocase">Where “{picked.length > 28 ? `${picked.slice(0, 27)}…` : picked}” travelled ({valueHits.length})</h3>
          <ul className="fl-list">
            {valueHits.map((i) => {
              const l = stepLabel(steps[i]);
              return (
                <li key={i}>
                  <button className={`fl-link${i === index ? " is-here" : ""}`} onClick={() => onJump(i)}>#{i + 1} {l.text}</button>
                </li>
              );
            })}
          </ul>
          <button className="fl-link" onClick={() => onNavigate({ view: "traces", value: picked })}>Find in other runs →</button>
        </section>
      )}

      {file && line && step.kind !== "event" && (
        <section>
          <h3>Source</h3>
          <SourceView file={file} line={line} end={(staticNode?.endLine as number | undefined) ?? line + 30} highlight={line} />
        </section>
      )}
    </aside>
  );
}

function CallDetail({ span, entering, color, picked, onPick, onNavigate, fold }: {
  span: TSpan;
  entering: boolean;
  color?: string;
  picked: string | null;
  onPick: (v: string) => void;
  onNavigate: (r: Route) => void;
  fold: (id: string) => string;
}) {
  return (
        <>
          <header>
            <span className="fl-chip" style={{ ["--kind" as string]: color }}>{entering ? "CALL" : "RETURN"}</span>
            <h2>{span.name}</h2>
            <div className="fl-muted">
              {span.service} · {fmtMs((span.end - span.start) * 1000)} · {span.status}
            </div>
            <div className="fl-actions">
              <button onClick={() => onNavigate({ view: "flow", node: fold(span.node), dir: "down" })}>Static flow</button>
              <button onClick={() => onNavigate({ view: "traces", node: fold(span.node) })}>Other runs</button>
            </div>
          </header>
          {entering ? (
            <section>
              <h3>Arguments</h3>
              <JsonTree value={span.input ?? {}} onPick={onPick} picked={picked} />
            </section>
          ) : (
            <>
              {span.error ? (
                <section className="fl-error-box">
                  <h3>Raised</h3>
                  <b>{span.error.type}</b>: {span.error.message}
                </section>
              ) : (
                <section>
                  <h3>{span.status === "yield" ? "Yielded" : "Returned"}</h3>
                  <JsonTree value={span.output ?? null} onPick={onPick} picked={picked} />
                </section>
              )}
              {span.mutated && (
                <section>
                  <h3>Changed arguments</h3>
                  {Object.entries(span.mutated).map(([arg, after]) => (
                    <div key={arg} className="fl-diff">
                      <div className="fl-diff-arg">{arg}</div>
                      {diff((span.input as Record<string, unknown>)?.[arg], after).map((d) => (
                        <div key={d.path} className="fl-diff-row">
                          <code>{d.path}</code>
                          <span className="fl-diff-before">{short(d.before, 60)}</span>→<span className="fl-diff-after">{short(d.after, 60)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </>
  );
}

function EventDetail({ step, picked, onPick }: { step: Extract<TStep, { kind: "event" }>; picked: string | null; onPick: (v: string) => void }) {
  const e = step.event;
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const edgeColor = EDGE_KINDS[e.type === "publish" ? "publishes" : e.type === "http" ? "http" : "writes"]?.color;
  return (
    <>
      <header>
        <span className="fl-chip" style={{ ["--kind" as string]: edgeColor }}>{EVENT_BADGE[e.type] ?? e.type}</span>
        <h2>{e.type === "db" ? `${e.op.toUpperCase()} ${e.targets.map((t) => t.node.replace(/^table:/, "")).join(", ")}` : e.op}</h2>
        <div className="fl-muted">{e.service} · {fmtMs(e.durationMs)}{step.span ? ` · inside ${step.span.name}` : ""}</div>
      </header>
      {e.error && (
        <section className="fl-error-box">
          <b>{e.error.type}</b>: {e.error.message}
        </section>
      )}
      {e.type === "db" && (
        <>
          <section>
            <h3>Statement</h3>
            <pre className="fl-sql">{String(d.statement ?? "")}</pre>
          </section>
          <section>
            <h3>Parameters</h3>
            <JsonTree value={d.params ?? null} onPick={onPick} picked={picked} />
          </section>
          {typeof d.rowcount === "number" && d.rowcount >= 0 && <p className="fl-muted">{d.rowcount} row(s) affected</p>}
        </>
      )}
      {e.type === "http" && (
        <dl className="fl-meta">
          <div><dt>Method</dt><dd>{String(d.method)}</dd></div>
          <div><dt>URL</dt><dd>{String(d.url)}</dd></div>
          <div><dt>Status</dt><dd>{String(d.status ?? "—")}</dd></div>
        </dl>
      )}
      {e.type === "publish" && (
        <>
          <dl className="fl-meta">
            <div><dt>Routing key</dt><dd>{String(d.routingKey)}</dd></div>
            {d.exchange ? <div><dt>Exchange</dt><dd>{String(d.exchange)}</dd></div> : null}
          </dl>
          <section>
            <h3>Message body</h3>
            <JsonTree value={d.body ?? null} onPick={onPick} picked={picked} />
          </section>
        </>
      )}
      {e.type === "storage" && (
        <dl className="fl-meta">
          <div><dt>Bucket</dt><dd>{String(d.bucket)}</dd></div>
          <div><dt>Key</dt><dd>{short(d.key, 200)}</dd></div>
        </dl>
      )}
    </>
  );
}
