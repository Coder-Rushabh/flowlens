import { useEffect, useState } from "react";
import { clearTraces, fetchTraces, searchValue, type SearchHit } from "../api.ts";
import type { Route } from "../graph/views.ts";
import { fmtAgo, fmtMs, type TraceSummary } from "../runtime/model.ts";

interface Props {
  onNavigate: (r: Route) => void;
  node?: string;
  initialValue?: string;
}

/** Live list of recorded runs, plus a value search across all of them. */
export function TraceList({ onNavigate, node, initialValue }: Props) {
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [errors, setErrors] = useState(false);
  const [value, setValue] = useState(initialValue ?? "");
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    if (initialValue) searchValue(initialValue).then(setHits);
  }, [initialValue]);

  useEffect(() => {
    let alive = true;
    const load = () => fetchTraces({ q, errors, node, limit: 300 }).then((t) => alive && setTraces(t)).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [q, errors, node]);

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) searchValue(value.trim()).then(setHits);
  };

  return (
    <div className="fl-traces">
      {node && (
        <p className="fl-muted">
          Runs that passed through <b>{node.slice(node.indexOf(":") + 1)}</b> ·{" "}
          <button className="fl-link" onClick={() => onNavigate({ view: "traces" })}>show all</button>
        </p>
      )}
      <div className="fl-traces-bar">
        <input className="fl-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter runs by entry point, function or service" />
        <label><input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> Errors only</label>
        <button onClick={() => clearTraces().then(() => setTraces([]))} title="Delete all recorded traces">Clear</button>
      </div>

      <form className="fl-traces-bar" onSubmit={runSearch}>
        <input className="fl-filter" value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="Find a value across all runs (an id, an email, a SKU…)" />
        <button type="submit">Find value</button>
        {hits && <button type="button" className="fl-link" onClick={() => setHits(null)}>clear</button>}
      </form>

      {hits && (
        <section className="fl-hits">
          <h3>{hits.length} place{hits.length === 1 ? "" : "s"} where “{value}” appeared</h3>
          <ul className="fl-list">
            {hits.map((h, i) => (
              <li key={i}>
                <button className="fl-link" onClick={() => onNavigate({ view: "trace", id: h.trace, focus: value })}>
                  {h.name ?? `${h.type} ${h.op}`}
                </button>
                <span className="fl-muted"> · {h.service} · in {h.where} · {fmtAgo(h.start)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {traces === null ? (
        <p className="fl-muted">Loading…</p>
      ) : traces.length === 0 ? (
        <div className="fl-empty fl-pad">
          <p><b>No runs recorded yet.</b> Start a service with the tracer and send it a request:</p>
          <pre>{`# local process (Python)
PYTHONPATH=<flowlens>/adapters/python \\
  python -m flowlens.trace --service <name> -m uvicorn app.main:app

# docker compose
flowlens docker <repo>      # then follow the printed steps`}</pre>
          <p>Runs appear here live.</p>
        </div>
      ) : (
        <table className="fl-table">
          <thead>
            <tr><th>Entry point</th><th>Services</th><th>Duration</th><th>Steps</th><th>When</th></tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.trace} onClick={() => onNavigate({ view: "trace", id: t.trace })} className={t.errors ? "has-error" : undefined}>
                <td>
                  <span className="fl-item-label">{t.rootName}</span>
                  {t.errors > 0 && <span className="fl-tag err">{t.errors} error{t.errors > 1 ? "s" : ""}</span>}
                </td>
                <td>{t.services.map((s) => <span key={s} className="fl-tag">{s}</span>)}</td>
                <td className="num">{fmtMs((t.end - t.start) * 1000)}</td>
                <td className="num">{t.spans + t.events}</td>
                <td className="fl-muted">{fmtAgo(t.start)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
