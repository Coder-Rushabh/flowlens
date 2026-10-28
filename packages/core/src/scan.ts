import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowlensConfig, ServiceConfig } from "./config.ts";
import { mergeGraphs } from "./merge.ts";
import { scanTypescript } from "./scanners/typescript.ts";
import type { FlowGraph, PartialGraph, ServiceInfo } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PYTHON_ADAPTER = resolve(here, "../../../adapters/python");

export const OUTPUT_DIR = ".flowlens";
export const graphPath = (repoRoot: string) => join(repoRoot, OUTPUT_DIR, "graph.json");

type Log = (msg: string) => void;

export function findPython(config: FlowlensConfig): string {
  const candidates = [
    config.python?.executable,
    process.env.FLOWLENS_PYTHON,
    ...(process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]),
  ].filter((c): c is string => Boolean(c));
  for (const exe of candidates) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && /^Python 3\./.test(`${r.stdout}${r.stderr}`.trim())) return exe;
  }
  throw new Error(
    `No Python 3 interpreter found (tried ${candidates.join(", ")}). Set python.executable in flowlens.yaml or FLOWLENS_PYTHON.`,
  );
}

function runPython(python: string, request: object): Promise<PartialGraph> {
  return new Promise((resolvePromise, reject) => {
    const env = {
      ...process.env,
      PYTHONPATH: [PYTHON_ADAPTER, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const child = spawn(python, ["-m", "flowlens.scan"], { cwd: PYTHON_ADAPTER, env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString("utf8").trim().split("\n").slice(-6).join("\n")));
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch (e) {
        reject(new Error(`scanner returned invalid JSON: ${(e as Error).message}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function scanService(
  repoRoot: string,
  config: FlowlensConfig,
  svc: ServiceConfig,
  python: () => string,
): Promise<PartialGraph | ServiceInfo> {
  const base: ServiceInfo = { name: svc.name, language: svc.language, root: svc.root, status: "skipped" };
  if (svc.enabled === false) return { ...base, message: "disabled (enabled: false)" };
  const root = resolve(repoRoot, svc.root);
  if (!existsSync(root)) return { ...base, status: "failed", message: `root not found: ${svc.root}` };
  if (svc.language === "typescript" || svc.language === "javascript") {
    try {
      return scanTypescript({
        service: svc.name, root, rootRel: svc.root, repoRoot, include: svc.include,
        exclude: [...(config.exclude ?? []), ...(svc.exclude ?? [])],
      });
    } catch (e) {
      return { ...base, status: "failed", message: (e as Error).stack ?? String(e) };
    }
  }
  if (svc.language !== "python") return { ...base, message: `no ${svc.language} scanner` };
  try {
    return await runPython(python(), {
      service: svc.name,
      root,
      rootRel: svc.root,
      repoRoot,
      include: svc.include ?? [],
      exclude: [...(config.exclude ?? []), ...(svc.exclude ?? [])],
      detectors: config.detectors ?? {},
    });
  } catch (e) {
    return { ...base, status: "failed", message: (e as Error).message };
  }
}

export async function scanRepo(repoRoot: string, config: FlowlensConfig, log: Log = () => {}): Promise<FlowGraph> {
  let python: string | undefined;
  const getPython = () => (python ??= findPython(config));
  const results: (PartialGraph | ServiceInfo)[] = new Array(config.services.length);
  let next = 0;
  const worker = async () => {
    while (next < config.services.length) {
      const i = next++;
      const svc = config.services[i];
      const res = await scanService(repoRoot, config, svc, getPython);
      results[i] = res;
      if ("nodes" in res) {
        const s = res.service.stats ?? {};
        log(`  ✓ ${svc.name.padEnd(40)} ${String(s.functions ?? 0).padStart(5)} functions  ${s.ms ?? "?"} ms`);
      } else {
        log(`  ${res.status === "failed" ? "✗" : "-"} ${svc.name.padEnd(40)} ${res.status}: ${res.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, config.services.length) }, worker));
  const partials = results.filter((r): r is PartialGraph => "nodes" in r);
  const others = results.filter((r): r is ServiceInfo => !("nodes" in r));
  return mergeGraphs(config.project, repoRoot, partials, others);
}

export function writeGraph(repoRoot: string, graph: FlowGraph): string {
  const dir = join(repoRoot, OUTPUT_DIR);
  mkdirSync(dir, { recursive: true });
  // keep generated output out of the host repo's git status
  writeFileSync(join(dir, ".gitignore"), "*\n");
  const file = graphPath(repoRoot);
  writeFileSync(file, JSON.stringify(graph));
  return file;
}
