import { useEffect, useRef, useState } from "react";
import { editorLink, fetchSource, type SourceSlice } from "../api.ts";

interface Props {
  file: string;
  line: number;
  end?: number;
  highlight?: number;
}

export function SourceView({ file, line, end, highlight }: Props) {
  const [slice, setSlice] = useState<SourceSlice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetchSource(file, line, end)
      .then((s) => alive && setSlice(s))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [file, line, end]);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center" });
  }, [slice, highlight]);

  if (error) return <div className="fl-muted">Source unavailable: {error}</div>;
  if (!slice) return <div className="fl-muted">Loading source…</div>;
  const mark = highlight ?? slice.focus;
  return (
    <div className="fl-source">
      <div className="fl-source-head">
        <span title={slice.absPath}>
          {file}:{mark}
        </span>
        <a href={editorLink(slice.absPath, mark)}>Open in VS Code</a>
      </div>
      <pre>
        {slice.lines.map((text, i) => {
          const n = slice.from + i;
          const on = n === mark;
          return (
            <div key={n} ref={on ? focusRef : undefined} className={on ? "is-focus" : undefined}>
              <span className="ln">{n}</span>
              {text || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
