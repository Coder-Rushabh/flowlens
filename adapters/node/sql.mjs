// SQL table extraction (port of adapters/python/flowlens/scan/detectors/sql.py — keep them in sync).
// Used by the TypeScript static scanner and the Node runtime tracer.

export const PH = "__fl__"; // placeholder for template-literal holes

const IDENT = String.raw`((?:[A-Za-z_"\x60\[][\w$"\x60\]]*)(?:\.[A-Za-z_"\x60\[][\w$"\x60\]]*)?)`;
const STARTS = /^\s*(select|with|insert|update|delete|merge|truncate)\b/i;
const WRITE_PATTERNS = [
  [new RegExp(String.raw`\binsert\s+(?:ignore\s+)?into\s+` + IDENT, "gi"), "insert"],
  [new RegExp(String.raw`\bupdate\s+(?:only\s+)?` + IDENT + String.raw`(?:\s+(?:as\s+)?\w+)?\s+set\b`, "gi"), "update"],
  [new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?` + IDENT, "gi"), "delete"],
  [new RegExp(String.raw`\bmerge\s+into\s+` + IDENT, "gi"), "upsert"],
  [new RegExp(String.raw`\btruncate\s+(?:table\s+)?` + IDENT, "gi"), "delete"],
];
const READ_PATTERN = new RegExp(String.raw`\b(from|join)\s+` + IDENT + String.raw`(\s*\()?`, "gi");
const CTE_PATTERN = /(?:^\s*|\bwith\s+(?:recursive\s+)?|,\s*)(\w+)\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi;
const FUNC_CONTEXT = /\b(extract|substring|trim|overlay|position)\s*\([^()]*$/i;
const NOT_TABLES = new Set([
  "select", "lateral", "unnest", "values", "only", "dual", "set", "the", "a", "an", "this", "that", "where",
  "generate_series", "jsonb_array_elements", "jsonb_each", "json_each", "json_array_elements", "jsonb_to_recordset",
]);

function normalize(text) {
  return text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").split(/\s+/).filter(Boolean).join(" ");
}

function clean(raw) {
  const name = raw.replace(/["`[\]]/g, "").toLowerCase();
  let parts = name.split(".").filter(Boolean);
  if (!parts.length || parts[parts.length - 1].includes(PH)) return null;
  parts = parts.filter((p) => !p.includes(PH));
  const out = parts.join(".");
  if (!out || NOT_TABLES.has(out) || NOT_TABLES.has(parts[parts.length - 1]) || !/^[a-z_]/.test(out)) return null;
  return out;
}

export function cteNames(text) {
  return new Set([...normalize(text).matchAll(CTE_PATTERN)].map((m) => m[1].toLowerCase()));
}

/** @returns {{writes: Record<string, string>, reads: Set<string>}} */
export function analyzeSql(input, extraCtes) {
  const text = normalize(input);
  const lowered = text.toLowerCase();
  const empty = { writes: {}, reads: new Set() };
  if (!STARTS.test(text) && !/^\s*(\w+\s+as\s*\(|\)\s*,)/.test(lowered)) return empty;
  if (/^(select|with)/.test(lowered) && !` ${lowered} `.includes(" from ")) return empty;
  const writes = {};
  for (const [pattern, op] of WRITE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const name = clean(m[1]);
      if (name && !(name in writes)) writes[name] = op;
    }
  }
  const ctes = new Set([...cteNames(text), ...(extraCtes ?? [])]);
  const reads = new Set();
  for (const m of text.matchAll(READ_PATTERN)) {
    if (m[3]) continue;
    const before = lowered.slice(0, m.index).trimEnd();
    if (m[1].toLowerCase() === "from" && (before.endsWith("delete") || before.endsWith("distinct"))) continue;
    if (FUNC_CONTEXT.test(lowered.slice(Math.max(0, m.index - 80), m.index))) continue;
    const name = clean(m[2]);
    if (name && !ctes.has(name)) reads.add(name);
  }
  return { writes, reads };
}
