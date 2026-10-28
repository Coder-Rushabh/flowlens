import { useState } from "react";

interface Props {
  value: unknown;
  onPick?: (value: string) => void;
  picked?: string | null;
  depth?: number;
  name?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/** Collapsible JSON view. Clicking a leaf value traces it (value lineage). */
export function JsonTree({ value, onPick, picked, depth = 0, name }: Props) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined ? <span className="jt-key">{name}: </span> : null;

  if (!isObj(value)) {
    const text = value === undefined ? "—" : JSON.stringify(value);
    const raw = value === null || value === undefined ? "" : String(value);
    const cls = `jt-leaf jt-${value === null ? "null" : typeof value}${picked && raw === picked ? " is-picked" : ""}`;
    return (
      <div className="jt-row">
        {label}
        {onPick && raw.length > 1 ? (
          <button className={cls} onClick={() => onPick(raw)} title="Trace this value through the run">
            {text}
          </button>
        ) : (
          <span className={cls}>{text}</span>
        )}
      </div>
    );
  }

  const entries = Object.entries(value).filter(([k]) => k !== "__type__");
  const type = typeof value.__type__ === "string" ? value.__type__ : Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  if (!entries.length) {
    return (
      <div className="jt-row">
        {label}
        <span className="jt-muted">{Array.isArray(value) ? "[]" : typeof value.__type__ === "string" ? `${value.__type__} {}` : "{}"}</span>
      </div>
    );
  }
  return (
    <div className="jt-node">
      <button className="jt-toggle" onClick={() => setOpen(!open)}>
        <span className="jt-caret">{open ? "▾" : "▸"}</span>
        {label}
        <span className="jt-muted">{type}</span>
      </button>
      {open && (
        <div className="jt-children">
          {entries.map(([k, v]) => (
            <JsonTree key={k} name={k} value={v} onPick={onPick} picked={picked} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
