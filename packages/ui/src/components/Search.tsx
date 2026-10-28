import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "../../../core/src/types.ts";
import { defaultAction, type GraphIndex, type Route } from "../graph/views.ts";
import { NODE_KINDS } from "../kinds.ts";

const RANK: Record<string, number> = { route: 0, entry: 1, table: 2, topic: 3, function: 4, service: 5, bucket: 6, external: 7 };

export function Search({ ix, onNavigate }: { ix: GraphIndex; onNavigate: (r: Route) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && document.activeElement?.tagName !== "INPUT")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: [number, GraphNode][] = [];
    for (const n of ix.graph.nodes) {
      const hay = `${n.name} ${n.service ?? ""} ${n.module ?? ""} ${n.kind}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const name = n.name.toLowerCase();
      const score = (name === terms[0] ? 0 : name.startsWith(terms[0]) ? 1 : name.includes(terms[0]) ? 2 : 3) * 10 + (RANK[n.kind] ?? 9);
      hits.push([score, n]);
    }
    return hits.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length).slice(0, 40).map(([, n]) => n);
  }, [ix, q]);

  const pick = (n: GraphNode) => {
    onNavigate(defaultAction(n));
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
  };

  return (
    <div className="fl-search">
      <input
        ref={inputRef}
        value={q}
        placeholder="Search functions, routes, tables, topics…  (Ctrl+K)"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && results[active]) pick(results[active]);
          else if (e.key === "Escape") inputRef.current?.blur();
          else return;
          e.preventDefault();
        }}
      />
      {open && results.length > 0 && (
        <ul className="fl-results">
          {results.map((n, i) => (
            <li key={n.id}>
              <button className={i === active ? "is-active" : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(n)}
                onMouseEnter={() => setActive(i)} style={{ ["--kind" as string]: NODE_KINDS[n.kind]?.color }}>
                <span className="fl-chip">{NODE_KINDS[n.kind]?.chip}</span>
                <span className="fl-item-label">{n.name}</span>
                <span className="fl-item-sub">{n.kind === "function" ? `${n.service} · ${n.module}` : n.service ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
