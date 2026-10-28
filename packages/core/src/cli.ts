import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, defaultConfig, loadConfig, renderConfig, type FlowlensConfig } from "./config.ts";
import { findComposeFile, planDocker } from "./docker.ts";
import { graphPath, OUTPUT_DIR, scanRepo, writeGraph } from "./scan.ts";
import { parseRecords, startServer } from "./server.ts";
import { TraceStore } from "./store.ts";
import type { FlowGraph } from "./types.ts";

const HELP = `FlowLens — see how data moves through a codebase.

Usage:
  flowlens init   [repo] [--force]         Detect services and write flowlens.yaml
  flowlens scan   [repo] [--out FILE]      Scan and write <repo>/.flowlens/graph.json
  flowlens ui     [repo] [--port N] [--rescan] [--no-open] [--ingest-host HOST] [--ingest-port N]
                                           Open the explorer and collect runtime traces
  flowlens import FILE.jsonl [repo]        Load traces recorded with FLOWLENS_OUT
  flowlens docker [repo] [--collector URL] Write a compose override that traces your containers

repo defaults to the current directory.

Runtime tracing (Python):
  python -m flowlens.trace --service NAME -m uvicorn app.main:app      (PYTHONPATH=<flowlens>/adapters/python)
  or set FLOWLENS_TRACE=1 with PYTHONPATH=<flowlens>/adapters/python/bootstrap:<flowlens>/adapters/python`;

interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = ["out", "port", "ingest-host", "ingest-port", "collector"];

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (VALUE_FLAGS.includes(k) && argv[i + 1] !== undefined) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { cmd: pos.shift() ?? "help", pos, flags };
}

const log = (msg: string) => console.log(msg);

async function scan(repo: string): Promise<FlowGraph> {
  const { config, fromFile } = loadConfig(repo);
  log(`Scanning ${config.project} (${config.services.length} services${fromFile ? "" : ", auto-detected — run `flowlens init` to customise"})`);
  const started = Date.now();
  const graph = await scanRepo(repo, config, log);
  const fns = graph.nodes.filter((n) => n.kind === "function").length;
  log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${graph.nodes.length} nodes (${fns} functions), ${graph.edges.length} edges, ${graph.warnings.length} warnings`);
  return graph;
}

export function openStore(repo: string): TraceStore {
  mkdirSync(join(repo, OUTPUT_DIR), { recursive: true });
  writeFileSync(join(repo, OUTPUT_DIR, ".gitignore"), "*\n");
  return new TraceStore(join(repo, OUTPUT_DIR, "traces.db"));
}

/** Runtime files are relative to the service root; the UI wants them relative to the repo. */
export function fileResolver(config: FlowlensConfig) {
  const roots = new Map(config.services.map((s) => [s.name, s.root.replace(/\\/g, "/").replace(/\/$/, "")]));
  return (service: string, file: string) => {
    const root = roots.get(service);
    return root && root !== "." ? `${root}/${file}` : file;
  };
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const repoArg = cmd === "import" ? pos[1] : pos[0];
  const repo = resolve(repoArg ?? ".");
  if (!["help", "--help"].includes(cmd) && !existsSync(repo)) throw new Error(`repo not found: ${repo}`);

  switch (cmd) {
    case "init": {
      const file = join(repo, CONFIG_FILE);
      if (existsSync(file) && !flags.force) throw new Error(`${CONFIG_FILE} already exists (use --force to overwrite)`);
      const config = defaultConfig(repo);
      writeFileSync(file, renderConfig(config));
      log(`Wrote ${file} with ${config.services.length} services:`);
      for (const s of config.services) log(`  ${s.enabled === false ? "-" : "+"} ${s.name} (${s.language}, ${s.root})`);
      return;
    }
    case "scan": {
      const graph = await scan(repo);
      const out = typeof flags.out === "string" ? resolve(flags.out) : writeGraph(repo, graph);
      if (typeof flags.out === "string") writeFileSync(out, JSON.stringify(graph));
      log(`Graph: ${out}`);
      return;
    }
    case "import": {
      const file = pos[0];
      if (!file || !existsSync(file)) throw new Error("usage: flowlens import FILE.jsonl [repo]");
      const store = openStore(repo);
      const n = store.ingest(parseRecords(readFileSync(file, "utf8")), fileResolver(loadConfig(repo).config));
      log(`Imported ${n} records into ${join(repo, OUTPUT_DIR, "traces.db")}`);
      store.close();
      return;
    }
    case "docker": {
      const composeFile = findComposeFile(repo);
      if (!composeFile) throw new Error(`no docker-compose.yml / compose.yml in ${repo}`);
      const { config } = loadConfig(repo);
      const port = Number(config.ui?.port ?? 4870) + 1;
      const collector = typeof flags.collector === "string" ? flags.collector : `http://host.docker.internal:${port}`;
      const plan = planDocker(repo, config, composeFile, collector);
      mkdirSync(join(repo, OUTPUT_DIR), { recursive: true });
      writeFileSync(join(repo, OUTPUT_DIR, ".gitignore"), "*\n");
      const out = join(repo, OUTPUT_DIR, "docker-compose.flowlens.yml");
      writeFileSync(out, plan.override);
      log(`Wrote ${out}`);
      for (const m of plan.matched) log(`  + ${m.compose.padEnd(42)} traced as ${m.service} (root ${m.workdir})`);
      if (plan.unmatched.length) log(`  not matched to a scanned service: ${plan.unmatched.join(", ")}`);
      log(`\n1. flowlens ui ${repoArg ?? "."} --ingest-host 0.0.0.0     (containers send events to port ${port})`);
      log(`2. docker compose -f ${composeFile} -f ${out} up -d <services>`);
      return;
    }
    case "ui": {
      const file = graphPath(repo);
      let graph: FlowGraph =
        !flags.rescan && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : await scan(repo);
      if (flags.rescan || !existsSync(file)) writeGraph(repo, graph);
      const { config } = loadConfig(repo);
      const port = Number(flags.port ?? config.ui?.port ?? 4870);
      const store = openStore(repo);
      const ingestHost = typeof flags["ingest-host"] === "string" ? flags["ingest-host"] : undefined;
      const ingestPort = flags["ingest-port"] ? Number(flags["ingest-port"]) : port + 1;
      const { url } = await startServer({
        repoRoot: repo,
        port,
        store,
        resolveFile: fileResolver(config),
        ingestHost,
        ingestPort,
        getGraph: () => graph,
        rescan: async () => {
          graph = await scan(repo);
          writeGraph(repo, graph);
          return graph;
        },
      });
      log(`FlowLens UI: ${url}  (Ctrl+C to stop)`);
      log(`Collecting runtime events at ${url}/api/events${ingestHost ? ` and http://${ingestHost}:${ingestPort}/api/events` : ""}`);
      if (!flags["no-open"]) openBrowser(url);
      return;
    }
    default:
      log(HELP);
  }
}

main().catch((e: Error) => {
  console.error(`flowlens: ${e.message}`);
  process.exit(1);
});
