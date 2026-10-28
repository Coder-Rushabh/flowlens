import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { FlowlensConfig } from "./config.ts";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PYTHON_ADAPTER } from "./scan.ts";

const NODE_ADAPTER = resolve(PYTHON_ADAPTER, "../node");
const TYPESCRIPT_DIR = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));

interface ComposeService {
  build?: string | { context?: string; dockerfile?: string };
  image?: string;
  environment?: Record<string, unknown> | string[];
}

export interface DockerPlan {
  override: string;
  matched: { compose: string; service: string; workdir: string }[];
  unmatched: string[];
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export function findComposeFile(repoRoot: string): string | null {
  return COMPOSE_FILES.map((f) => join(repoRoot, f)).find((f) => existsSync(f)) ?? null;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";

function dockerfileFacts(file: string): { workdir: string; pythonpath?: string } {
  if (!existsSync(file)) return { workdir: "/app" };
  let workdir = "/app";
  let pythonpath: string | undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const wd = line.match(/^\s*WORKDIR\s+(\S+)/i);
    if (wd) workdir = wd[1];
    const pp = line.match(/^\s*ENV\s+PYTHONPATH[=\s]+"?([^"\s]+)"?/i);
    if (pp) pythonpath = pp[1];
  }
  return { workdir, pythonpath };
}

function envValue(env: ComposeService["environment"], key: string): string | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return env.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1);
  const v = env[key];
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * A compose override that mounts the Python adapter into every container built from a scanned
 * Python service (and every container reusing that image), and turns tracing on via sitecustomize.
 */
export function planDocker(repoRoot: string, config: FlowlensConfig, composeFile: string, collector: string): DockerPlan {
  const compose = parse(readFileSync(composeFile, "utf8")) as { services?: Record<string, ComposeService> };
  const composeDir = resolve(composeFile, "..");
  const byRoot = new Map(
    config.services
      .filter((s) => ["python", "typescript", "javascript"].includes(s.language) && s.enabled !== false)
      .map((s) => [norm(s.root), s]),
  );
  type Target = { service: string; language: string; workdir: string; pythonpath?: string };
  const built = new Map<string, Target>(); // image -> service
  const matched: DockerPlan["matched"] = [];
  const unmatched: string[] = [];
  const services: Record<string, unknown> = {};
  const entries = Object.entries(compose.services ?? {});
  const host = (p: string) => p.replace(/\\/g, "/");

  const emit = (name: string, svc: ComposeService, target: Target) => {
    const common = {
      FLOWLENS_SERVICE: target.service,
      FLOWLENS_ROOT: target.workdir,
      FLOWLENS_COLLECTOR: collector,
    };
    if (target.language === "python") {
      const existing = envValue(svc.environment, "PYTHONPATH") ?? target.pythonpath;
      services[name] = {
        volumes: [`${host(PYTHON_ADAPTER)}:/flowlens:ro`],
        environment: { FLOWLENS_TRACE: "1", ...common, PYTHONPATH: ["/flowlens/bootstrap", "/flowlens", existing ?? target.workdir].join(":") },
        extra_hosts: ["host.docker.internal:host-gateway"],
      };
    } else {
      // Node: preload the tracer; it needs the typescript package for its source transform
      const existing = envValue(svc.environment, "NODE_OPTIONS");
      services[name] = {
        volumes: [`${host(NODE_ADAPTER)}:/flowlens-node:ro`, `${host(TYPESCRIPT_DIR)}:/flowlens-node/node_modules/typescript:ro`],
        environment: { ...common, NODE_OPTIONS: [existing, "--import=file:///flowlens-node/register.mjs"].filter(Boolean).join(" ") },
        extra_hosts: ["host.docker.internal:host-gateway"],
      };
    }
    matched.push({ compose: name, service: target.service, workdir: target.workdir });
  };

  for (const [name, svc] of entries) {
    if (!svc?.build) continue;
    const ctx = typeof svc.build === "string" ? svc.build : svc.build.context ?? ".";
    const ctxAbs = resolve(composeDir, ctx);
    const flow = byRoot.get(norm(relative(repoRoot, ctxAbs)));
    if (!flow) continue;
    const dockerfile = typeof svc.build === "object" && svc.build.dockerfile ? svc.build.dockerfile : "Dockerfile";
    const facts = dockerfileFacts(join(ctxAbs, dockerfile));
    const target = { service: flow.name, language: flow.language, ...facts };
    if (svc.image) built.set(svc.image, target);
    emit(name, svc, target);
  }
  for (const [name, svc] of entries) {
    if (services[name] || !svc) continue;
    const target = svc.image ? built.get(svc.image) : undefined;
    if (target) emit(name, svc, target);
    else if (!svc.build && !svc.image?.includes("/")) continue; // third-party images (postgres, redis…)
    else unmatched.push(name);
  }

  const header = [
    "# Generated by `flowlens docker`. Enables FlowLens runtime tracing without changing any image.",
    `# Run:  docker compose -f ${relative(repoRoot, composeFile).replace(/\\/g, "/")} -f .flowlens/docker-compose.flowlens.yml up -d`,
    "# Undo: run the same services again without the second -f.",
    "",
  ].join("\n");
  return { override: header + stringify({ services }), matched, unmatched };
}
