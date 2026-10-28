import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";

export interface ServiceConfig {
  name: string;
  root: string; // relative to the repo root
  language: string;
  include?: string[];
  exclude?: string[];
  enabled?: boolean;
}

export interface FlowlensConfig {
  version: 1;
  project: string;
  services: ServiceConfig[];
  exclude?: string[];
  python?: { executable?: string };
  detectors?: Record<string, Record<string, unknown>>;
  redact?: string[];
  ui?: { port?: number };
}

export const CONFIG_FILE = "flowlens.yaml";
export const DEFAULT_REDACT = ["password", "passwd", "secret", "token", "authorization", "api_key", "apikey", "cookie"];

const PY_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt"];
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "venv", ".venv", "env", "__pycache__", "site-packages", "vendor", "target", "out",
]);
const NON_SERVICE = /^(?:.*[-_])?(?:templates?|tests?|test-utils|e2e|examples?|samples?|docs?|fixtures?)$/i;

function detectLanguage(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  if (entries.some((f) => PY_MARKERS.includes(f) || /^requirements.*\.txt$/.test(f))) return "python";
  if (entries.includes("package.json")) return "typescript";
  return null;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name) && !/[;:]/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

const CODE_FILE = /\.(?:py|[cm]?[jt]sx?)$/;
const TOOL_FILE = /(?:^|[.-])(?:config|rc|setup|conftest|noxfile|tasks|manage)\.|^\./;

/** Source files sitting directly in dir, ignoring tool configs (babel.config.js, setup.py…). */
function hasOwnCode(dir: string): boolean {
  try {
    if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).workspaces) return false;
  } catch {}
  try {
    return readdirSync(dir).some((f) => CODE_FILE.test(f) && !TOOL_FILE.test(f));
  } catch {
    return false;
  }
}

/** Find services: top-level folders (or one level deeper) that carry a language marker file. */
export function discoverServices(repoRoot: string): ServiceConfig[] {
  const found: ServiceConfig[] = [];
  for (const name of subdirs(repoRoot)) {
    const language = detectLanguage(join(repoRoot, name));
    if (language) {
      found.push({ name, root: name, language, ...(NON_SERVICE.test(name) ? { enabled: false } : {}) });
      continue;
    }
    for (const inner of subdirs(join(repoRoot, name))) {
      const lang = detectLanguage(join(repoRoot, name, inner));
      if (lang) {
        const disabled = NON_SERVICE.test(name) || NON_SERVICE.test(inner);
        found.push({ name: inner, root: `${name}/${inner}`, language: lang, ...(disabled ? { enabled: false } : {}) });
      }
    }
  }
  // The root is a service too when it is one (e.g. an app with a side tool in a subfolder),
  // not just a workspace shell around the others.
  const language = detectLanguage(repoRoot);
  if (language && (found.length === 0 || hasOwnCode(repoRoot))) {
    const nested = found.map((s) => `${s.root}/**`);
    found.unshift({ name: basename(repoRoot), root: ".", language, ...(nested.length ? { exclude: nested } : {}) });
  }
  const seen = new Map<string, number>();
  for (const svc of found) {
    const n = seen.get(svc.name) ?? 0;
    seen.set(svc.name, n + 1);
    if (n > 0) svc.name = svc.root.replace(/[\\/]/g, "-");
  }
  return found;
}

export function defaultConfig(repoRoot: string): FlowlensConfig {
  return { version: 1, project: basename(repoRoot), services: discoverServices(repoRoot), redact: DEFAULT_REDACT };
}

export function loadConfig(repoRoot: string): { config: FlowlensConfig; fromFile: boolean } {
  const file = join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) return { config: defaultConfig(repoRoot), fromFile: false };
  const raw = parse(readFileSync(file, "utf8")) ?? {};
  if (!Array.isArray(raw.services)) throw new Error(`${file}: "services" must be a list`);
  for (const [i, svc] of raw.services.entries()) {
    if (!svc?.name || !svc?.root || !svc?.language) {
      throw new Error(`${file}: services[${i}] needs name, root and language`);
    }
  }
  return {
    config: { version: 1, project: raw.project ?? basename(repoRoot), redact: DEFAULT_REDACT, ...raw },
    fromFile: true,
  };
}

const q = (s: string) => JSON.stringify(s);

/** flowlens.yaml text with comments, for `flowlens init`. */
export function renderConfig(config: FlowlensConfig): string {
  const lines = [
    "# FlowLens configuration (reference: docs/config.md in the FlowLens repo).",
    "version: 1",
    `project: ${q(config.project)}`,
    "",
    "# One entry per deployable unit. root is relative to this file.",
    "# include/exclude are globs relative to the service root (** = any depth).",
    "services:",
  ];
  for (const svc of config.services) {
    lines.push(`  - name: ${q(svc.name)}`, `    root: ${q(svc.root)}`, `    language: ${svc.language}`);
    if (svc.enabled === false) lines.push("    enabled: false  # looks like tooling/tests; set true to scan");
    if (svc.include) lines.push(`    include: [${svc.include.map(q).join(", ")}]`);
    if (svc.exclude) lines.push(`    exclude: [${svc.exclude.map(q).join(", ")}]`);
  }
  lines.push(
    "",
    "# Extra excludes for every service (tests, migrations and venvs are excluded by default).",
    "exclude: []",
    "",
    "# Per-detector options. Disable one with `enabled: false`.",
    "# Detectors: routes, orm, sql, messaging, storage, http",
    "detectors: {}",
    "",
    "# Keys whose values are masked in runtime traces (phase 2).",
    `redact: [${(config.redact ?? DEFAULT_REDACT).map(q).join(", ")}]`,
    "",
    "# python:",
    "#   executable: python   # interpreter used to run the scanner (default: auto-detect)",
    "",
  );
  return lines.join("\n");
}
