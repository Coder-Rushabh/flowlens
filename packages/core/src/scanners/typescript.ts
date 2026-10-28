// Static scanner for TypeScript / JavaScript services. Parses only (never runs or type-checks the code).
//
// Detects: functions and calls across modules (relative imports, tsconfig `paths`, re-exports, object-literal
// APIs, class methods, JSX component renders), Next.js app/pages routes and pages, Express-style routers
// (with mounted prefixes), NestJS controllers, outbound HTTP (fetch, axios and API-client wrappers),
// Prisma and raw SQL, AMQP (amqplib) and Kafka (kafkajs), S3 / MinIO.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { modulePath, namedFunctions, routeRegistration } from "../../../../adapters/node/naming.mjs";
import { analyzeSql, cteNames, PH } from "../../../../adapters/node/sql.mjs";
import type { EdgeKind, GraphEdge, GraphNode, HttpCall, PartialGraph } from "../types.ts";

export interface TsScanRequest {
  service: string;
  root: string; // absolute
  rootRel: string;
  repoRoot: string;
  include?: string[];
  exclude?: string[];
}

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "out", "coverage", ".turbo", ".vercel", ".git", "__tests__", "__mocks__", "e2e", "tests", "test", "mocks", "storybook-static"]);
const DEFAULT_EXCLUDE = [/\.(test|spec|stories)\.[cm]?[jt]sx?$/, /\.d\.[cm]?ts$/, /(^|\/)(jest|vitest|playwright|next|postcss|tailwind|eslint|webpack|vite)\.config\./];
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);
const CLIENT_NAME = /^(axios|api|apiClient|client|http|httpClient|request|instance|fetcher|\w*Api|\w*Client|\w*Http)$/i;
const PRISMA_READ = new Set(["findMany", "findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"]);
const PRISMA_WRITE: Record<string, string> = { create: "insert", createMany: "insert", update: "update", updateMany: "update", upsert: "upsert", delete: "delete", deleteMany: "delete" };
const S3_COMMANDS: Record<string, [string, boolean]> = { PutObjectCommand: ["put", true], GetObjectCommand: ["get", false], DeleteObjectCommand: ["delete", true], CopyObjectCommand: ["copy", true], HeadObjectCommand: ["stat", false] };
const MINIO_OPS: Record<string, [string, boolean]> = { putObject: ["put", true], fPutObject: ["put", true], getObject: ["get", false], fGetObject: ["get", false], removeObject: ["delete", true], statObject: ["stat", false], presignedGetObject: ["get", false] };
const SUPABASE = /supabase|^sb$/i;
const SUPABASE_WRITE: Record<string, string> = { insert: "insert", upsert: "upsert", update: "update", delete: "delete" };
const SUPABASE_STORAGE: Record<string, [string, boolean]> = { upload: ["upload", true], update: ["upload", true], move: ["move", true], copy: ["copy", true], remove: ["delete", true], download: ["download", false], list: ["list", false], getPublicUrl: ["url", false], createSignedUrl: ["url", false], createSignedUrls: ["url", false] };
const REST_OPS: Record<string, string> = { POST: "insert", PATCH: "update", PUT: "upsert", DELETE: "delete" };

/** Methods chained after a call: x.from('t').select().eq() → ["select", "eq"]. */
function chainMethods(call: ts.CallExpression): string[] {
  const out: string[] = [];
  let n: ts.Node = call;
  while (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && ts.isCallExpression(n.parent.parent)) {
    out.push(n.parent.name.text);
    n = n.parent.parent;
  }
  return out;
}

interface TsFunction {
  id: string;
  qual: string;
  node: ts.Node;
  module: TsModule;
  cls?: string;
}

interface Binding {
  spec: string;
  name: string; // "default" | "*" | exported name
}

interface TsModule {
  rel: string; // relative to service root
  repoRel: string;
  path: string; // module path used in ids
  sf: ts.SourceFile;
  imports: Map<string, Binding>;
  exports: Map<string, string>; // exported name -> local name
  reexports: Map<string, Binding>;
  starExports: string[];
  functions: TsFunction[];
  byQual: Map<string, TsFunction>;
  consts: Map<string, ts.Expression>;
}

type Target = { fn: TsFunction } | { module: TsModule; local: string } | null;

export function globToRegex(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (g.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (g[i] === "*") re += "[^/]*";
    else if (g[i] === "?") re += "[^/]";
    else re += g[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function readTsconfigPaths(root: string): { base: string; paths: [RegExp, string[]][] } {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const { config } = ts.readConfigFile(file, ts.sys.readFile);
    const opts = config?.compilerOptions ?? {};
    const base = resolve(root, opts.baseUrl ?? ".");
    const paths = Object.entries((opts.paths ?? {}) as Record<string, string[]>).map(
      ([k, v]) => [new RegExp(`^${k.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace("*", "(.*)")}$`), v] as [RegExp, string[]],
    );
    return { base, paths };
  }
  return { base: root, paths: [] };
}

class Project {
  modules = new Map<string, TsModule>(); // abs path -> module
  warnings: string[] = [];
  private tsconfig: { base: string; paths: [RegExp, string[]][] };
  readonly req: TsScanRequest;

  constructor(req: TsScanRequest) {
    this.req = req;
    this.tsconfig = readTsconfigPaths(req.root);
  }

  load() {
    const include = (this.req.include?.length ? this.req.include : ["**/*"]).map(globToRegex);
    const exclude = (this.req.exclude ?? []).map(globToRegex);
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        const abs = join(dir, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(abs);
          continue;
        }
        if (!EXTS.some((e) => name.endsWith(e))) continue;
        const rel = relative(this.req.root, abs).replace(/\\/g, "/");
        if (DEFAULT_EXCLUDE.some((r) => r.test(rel)) || !include.some((r) => r.test(rel)) || exclude.some((r) => r.test(rel))) continue;
        if (st.size > 1_500_000) {
          this.warnings.push(`${rel}: skipped, larger than 1.5MB`);
          continue;
        }
        this.parse(abs, rel);
      }
    };
    walk(this.req.root);
  }

  private parse(abs: string, rel: string) {
    const text = readFileSync(abs, "utf8");
    const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
    const mod: TsModule = {
      rel,
      repoRel: relative(this.req.repoRoot, abs).replace(/\\/g, "/"),
      path: modulePath(rel),
      sf,
      imports: new Map(),
      exports: new Map(),
      reexports: new Map(),
      starExports: [],
      functions: [],
      byQual: new Map(),
      consts: new Map(),
    };
    for (const { node, qual, cls } of namedFunctions(ts, sf) as { node: ts.Node; qual: string; cls?: string }[]) {
      if (mod.byQual.has(qual)) continue;
      const fn: TsFunction = { id: `fn:${this.req.service}:${mod.path}.${qual}`, qual, node, module: mod, cls };
      mod.functions.push(fn);
      mod.byQual.set(qual, fn);
    }
    this.indexModule(mod);
    this.modules.set(abs, mod);
  }

  private indexModule(mod: TsModule) {
    const isExported = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    for (const st of mod.sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const clause = st.importClause;
        if (clause?.name) mod.imports.set(clause.name.text, { spec, name: "default" });
        const nb = clause?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) mod.imports.set(nb.name.text, { spec, name: "*" });
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) mod.imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
      } else if (ts.isExportDeclaration(st)) {
        const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        if (!st.exportClause && spec) mod.starExports.push(spec);
        else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            const local = (el.propertyName ?? el.name).text;
            if (spec) mod.reexports.set(el.name.text, { spec, name: local });
            else mod.exports.set(el.name.text, local);
          }
        }
      } else if (ts.isExportAssignment(st)) {
        if (ts.isIdentifier(st.expression)) mod.exports.set("default", st.expression.text);
        else mod.exports.set("default", "default");
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
        if (isExported(st)) mod.exports.set(isDefault(st) ? "default" : st.name.text, st.name.text);
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && isDefault(st)) {
        mod.exports.set("default", "default");
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          if (d.initializer) {
            mod.consts.set(d.name.text, d.initializer);
            // const x = require("./y")  /  const { a } = require("./y")
          }
          if (isExported(st)) mod.exports.set(d.name.text, d.name.text);
        }
        for (const d of st.declarationList.declarations) {
          const init = d.initializer;
          if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) {
            const spec = init.arguments[0].text;
            if (ts.isIdentifier(d.name)) mod.imports.set(d.name.text, { spec, name: "*" });
            else if (ts.isObjectBindingPattern(d.name)) {
              for (const el of d.name.elements) if (ts.isIdentifier(el.name)) mod.imports.set(el.name.text, { spec, name: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text });
            }
          }
        }
      }
    }
    // CommonJS: module.exports = { a, b } / exports.x = …
    for (const fn of mod.functions) {
      if (fn.qual.startsWith("exports.")) mod.exports.set(fn.qual.slice(8), fn.qual);
    }
  }

  resolveSpec(from: TsModule, spec: string): TsModule | null {
    const fromDir = dirname(from.sf.fileName);
    const candidates: string[] = [];
    if (spec.startsWith(".")) candidates.push(resolve(fromDir, spec));
    else {
      for (const [re, targets] of this.tsconfig.paths) {
        const m = spec.match(re);
        if (m) for (const t of targets) candidates.push(resolve(this.tsconfig.base, t.replace("*", m[1] ?? "")));
      }
      if (!candidates.length && !spec.startsWith("@") && this.tsconfig.base !== this.req.root) candidates.push(resolve(this.tsconfig.base, spec));
    }
    for (const base of candidates) {
      const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
      for (const c of [base, ...EXTS.map((e) => stripped + e), ...EXTS.map((e) => join(base, `index${e}`))]) {
        const m = this.modules.get(c);
        if (m) return m;
      }
    }
    return null;
  }

  /** What an exported name of a module refers to. */
  exported(mod: TsModule, name: string, depth = 0): Target {
    if (depth > 8) return null;
    const local = mod.exports.get(name);
    if (local) return this.local(mod, local, depth + 1);
    const re = mod.reexports.get(name);
    if (re) {
      const target = this.resolveSpec(mod, re.spec);
      return target ? this.exported(target, re.name, depth + 1) : null;
    }
    for (const spec of mod.starExports) {
      const target = this.resolveSpec(mod, spec);
      const hit = target && this.exported(target, name, depth + 1);
      if (hit) return hit;
    }
    if (mod.byQual.has(name)) return { fn: mod.byQual.get(name)! };
    return null;
  }

  /** What a module-local name refers to: a function, or a value in some module (object, class, router…). */
  local(mod: TsModule, name: string, depth = 0): Target {
    if (depth > 8) return null;
    const fn = mod.byQual.get(name);
    if (fn) return { fn };
    const imp = mod.imports.get(name);
    if (imp) {
      const target = this.resolveSpec(mod, imp.spec);
      if (!target) return null;
      if (imp.name === "*") return { module: target, local: "*" };
      return this.exported(target, imp.name, depth + 1) ?? { module: target, local: imp.name };
    }
    return { module: mod, local: name };
  }

  /** Resolve `a`, `a.b`, `this.b` to a project function. */
  callee(fn: TsFunction, expr: ts.Expression): TsFunction | null {
    const mod = fn.module;
    if (ts.isIdentifier(expr)) {
      const t = this.local(mod, expr.text);
      return t && "fn" in t ? t.fn : null;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const prop = expr.name.text;
      const base = expr.expression;
      if (base.kind === ts.SyntaxKind.ThisKeyword && fn.cls) return mod.byQual.get(`${fn.cls}.${prop}`) ?? null;
      if (ts.isIdentifier(base)) {
        const t = this.local(mod, base.text);
        if (!t) return null;
        if ("module" in t) {
          if (t.local === "*") {
            const e = this.exported(t.module, prop);
            return e && "fn" in e ? e.fn : null;
          }
          return t.module.byQual.get(`${t.local}.${prop}`) ?? null;
        }
        // object exported as a function? (`default.x`) — not resolvable
        return t.fn.module.byQual.get(`${t.fn.qual}.${prop}`) ?? null;
      }
    }
    return null;
  }

  /** The module + local name an identifier ultimately refers to (for routers and similar values). */
  valueRef(mod: TsModule, expr: ts.Expression): string | null {
    if (!ts.isIdentifier(expr)) return null;
    const t = this.local(mod, expr.text);
    if (!t) return null;
    return "fn" in t ? t.fn.id : `${t.module.path}#${t.local}`;
  }
}

// ------------------------------------------------------------------ helpers
const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function stringOf(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

/** Render a URL / SQL template: literal parts kept, holes become `{expr}` (or a placeholder). */
function templateOf(expr: ts.Expression | undefined, sf: ts.SourceFile, hole?: string, mod?: TsModule, depth = 0): string | null {
  if (!expr) return null;
  const s = stringOf(expr);
  if (s !== null) return s;
  const render = (e: ts.Expression) => {
    if (depth < 2 && mod && ts.isIdentifier(e)) {
      const init = mod.consts.get(e.text);
      const v = init ? templateOf(init, sf, hole, mod, depth + 1) : null;
      if (v !== null) return v;
    }
    return hole ?? `{${e.getText(sf).replace(/\s+/g, " ").slice(0, 60)}}`;
  };
  if (ts.isTemplateExpression(expr)) {
    return expr.head.text + expr.templateSpans.map((sp) => render(sp.expression) + sp.literal.text).join("");
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = templateOf(expr.left, sf, hole, mod, depth + 1);
    const r = templateOf(expr.right, sf, hole, mod, depth + 1);
    if (l === null && r === null) return null;
    return (l ?? render(expr.left)) + (r ?? render(expr.right));
  }
  if (ts.isIdentifier(expr) && mod && depth < 2) {
    const init = mod.consts.get(expr.text);
    return init ? templateOf(init, sf, hole, mod, depth + 1) : null;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return templateOf(expr.expression, sf, hole, mod, depth);
  return null;
}

function objProp(obj: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** Next.js app/pages segment rules: (group) and @slot vanish, [id] -> {id}, [...x]/[[...x]] -> {x}. */
function nextPath(dirs: string[]): string {
  const segs = dirs
    .filter((d) => !/^\(.*\)$/.test(d) && !d.startsWith("@"))
    .map((d) => d.replace(/^\[\[?\.\.\.(.+?)\]?\]$/, "{...$1}").replace(/^\[(.+)\]$/, "{$1}"));
  return `/${segs.join("/")}`.replace(/\/+$/, "") || "/";
}

interface Rewrite {
  source: RegExp;
  dest: string; // with $1 for the captured tail
}

/**
 * Next.js `rewrites()` from next.config.*: `{ source: "/api/v1/x/:path*", destination: \`${backend}/api/v1/x/:path*\` }`
 * with `const backend = process.env.X || "http://svc:8000"`. Calls through a rewrite are re-targeted at its
 * destination, so the URL carries the real backend host when matched to routes.
 */
function nextRewrites(root: string): Rewrite[] {
  const file = ["next.config.ts", "next.config.mjs", "next.config.js"].map((f) => join(root, f)).find(existsSync);
  if (!file) return [];
  const text = readFileSync(file, "utf8");
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*?(?:\|\||\?\?)\s*["'`]([^"'`]+)["'`]/g)) vars.set(m[1], m[2]);
  const out: Rewrite[] = [];
  for (const m of text.matchAll(/source:\s*["'`]([^"'`]+)["'`]\s*,\s*destination:\s*["'`]([^"'`]+)["'`]/g)) {
    const source = m[1];
    const dest = m[2].replace(/\$\{(\w+)\}/g, (_, v) => vars.get(v) ?? `{${v}}`);
    const tail = /\/:\w+\*$/.test(source);
    const pattern = source.replace(/\/:\w+\*$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+");
    out.push({ source: new RegExp(`^${pattern}${tail ? "(/.*)?" : ""}$`), dest: dest.replace(/\/:\w+\*$/, tail ? "$1" : "") });
  }
  return out;
}

function applyRewrites(url: string, rewrites: Rewrite[]): string {
  if (!url.startsWith("/")) return url;
  const [path, query] = url.split("?");
  for (const r of rewrites) {
    const m = path.match(r.source);
    if (m) return r.dest.replace("$1", m[1] ?? "") + (query ? `?${query}` : "");
  }
  return url;
}

const joinPath = (...parts: string[]) => `/${parts.join("/").split("/").filter(Boolean).join("/")}`.replace(/\/+$/, "") || "/";

// --------------------------------------------------------------------- scan
export function scanTypescript(req: TsScanRequest): PartialGraph {
  const started = Date.now();
  const project = new Project(req);
  project.load();
  const svc = req.service;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, Omit<GraphEdge, "id">>();
  const httpCalls: HttpCall[] = [];

  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const addEdge = (from: string, to: string, kind: EdgeKind, file: string, line: number, op?: string) => {
    if (from === to) return;
    const key = `${from}|${kind}|${to}`;
    const e = edges.get(key) ?? { from, to, kind, origin: "static" as const, evidence: [] };
    if (e.evidence.length < 25 && !e.evidence.some((x) => x.file === file && x.line === line)) e.evidence.push({ file, line, ...(op ? { op } : {}) });
    if (op) {
      e.ops ??= [];
      if (!e.ops.includes(op)) e.ops.push(op);
    }
    edges.set(key, e);
  };
  const table = (name: string) => addNode({ id: `table:${name}`, kind: "table", name, schema: name.includes(".") ? name.split(".")[0] : undefined, table: name.split(".").pop() });
  const topic = (key: string, transport = "broker") => addNode({ id: `topic:${key}`, kind: "topic", name: key, transport, pattern: /[*#]/.test(key) || undefined });
  const bucket = (name: string) => addNode({ id: `bucket:${name}`, kind: "bucket", name });

  const allFns = [...project.modules.values()].flatMap((m) => m.functions);
  const fnNodes = new Set(allFns.map((f) => f.node));
  for (const fn of allFns) {
    const n = fn.node as ts.FunctionLikeDeclaration;
    addNode({
      id: fn.id, kind: "function", name: fn.qual, service: svc, module: fn.module.path, qualname: `${fn.module.path}.${fn.qual}`,
      cls: fn.cls, file: fn.module.repoRel, line: lineOf(fn.module.sf, n), endLine: fn.module.sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
      isAsync: n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || undefined,
      params: n.parameters?.map((p) => p.name.getText(fn.module.sf).slice(0, 40)),
    });
  }

  // Prisma model -> table (@@map) from schema.prisma, when present
  const prismaTables = new Map<string, string>();
  for (const p of ["prisma/schema.prisma", "schema.prisma"]) {
    const file = join(req.root, p);
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
      const map = m[2].match(/@@map\(\s*"([^"]+)"\s*\)/);
      prismaTables.set(m[1][0].toLowerCase() + m[1].slice(1), map ? map[1] : m[1]);
    }
  }

  // ---------------------------------------------------- routes and entries
  const routers = new Map<string, string>(); // router value ref -> mount prefix
  const mounts: { child: string; parent: string; prefix: string }[] = [];
  const pendingRoutes: { router: string | null; method: string; path: string; handlers: string[]; file: string; line: number }[] = [];

  for (const mod of project.modules.values()) {
    const file = mod.repoRel;
    // Next.js app router
    const app = mod.rel.match(/^(?:src\/)?app\/(.*?)(route|page)\.[cm]?[jt]sx?$/);
    if (app) {
      const path = nextPath(app[1].split("/").filter(Boolean));
      if (app[2] === "route") {
        for (const fn of mod.functions) {
          if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(fn.qual) && mod.exports.has(fn.qual)) {
            const id = addNode({ id: `route:${svc}:${fn.qual} ${path}`, kind: "route", name: `${fn.qual} ${path}`, service: svc, method: fn.qual, path, file, line: lineOf(mod.sf, fn.node), handler: fn.id });
            addEdge(id, fn.id, "handles", file, lineOf(mod.sf, fn.node));
          }
        }
      } else {
        const target = project.exported(mod, "default");
        if (target && "fn" in target) {
          const id = addNode({ id: `entry:${svc}:page ${path}`, kind: "entry", name: `page ${path}`, service: svc, trigger: "page", file, line: lineOf(mod.sf, target.fn.node) });
          addEdge(id, target.fn.id, "handles", file, lineOf(mod.sf, target.fn.node));
        }
      }
    }
    // Next.js pages router
    const pages = mod.rel.match(/^(?:src\/)?pages\/(.*?)\.[cm]?[jt]sx?$/);
    if (pages && !/(^|\/)_(app|document|error)$/.test(pages[1])) {
      const dirs = pages[1].split("/").filter((d) => d !== "index");
      const target = project.exported(mod, "default");
      if (target && "fn" in target) {
        const isApi = dirs[0] === "api";
        const path = nextPath(dirs);
        const id = isApi
          ? addNode({ id: `route:${svc}:ANY ${path}`, kind: "route", name: `ANY ${path}`, service: svc, method: "ANY", path, file, handler: target.fn.id })
          : addNode({ id: `entry:${svc}:page ${path}`, kind: "entry", name: `page ${path}`, service: svc, trigger: "page", file });
        addEdge(id, target.fn.id, "handles", file, lineOf(mod.sf, target.fn.node));
      }
    }

    // Express-style registrations and mounts, NestJS controllers
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const callee = node.initializer.expression.getText(mod.sf);
        if (/(^|\.)Router$/.test(callee) || /^(express|fastify|new Hono|Hono|koa|new Koa|new Router)/.test(callee) || callee === "express") {
          routers.set(`${mod.path}#${node.name.text}`, "");
        }
      }
      if (ts.isCallExpression(node)) {
        const reg = routeRegistration(ts, node) as { method: string; path: string; handlers: ts.Expression[] } | null;
        if (reg && ts.isPropertyAccessExpression(node.expression)) {
          const handlers: string[] = [];
          let n = 0;
          for (const h of reg.handlers) {
            if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) {
              const qual = `<${reg.method} ${reg.path}>${n++ ? `#${n}` : ""}`;
              const fn = mod.byQual.get(qual);
              if (fn) handlers.push(fn.id);
            } else {
              const enclosing = allFns.find((f) => f.module === mod && f.node.pos <= node.pos && node.end <= f.node.end);
              const target = enclosing ? project.callee(enclosing, h) : (() => {
                const t = ts.isIdentifier(h) ? project.local(mod, h.text) : null;
                return t && "fn" in t ? t.fn : null;
              })();
              if (target) handlers.push(target.id);
            }
          }
          const routerRef = project.valueRef(mod, node.expression.expression) ?? null;
          pendingRoutes.push({ router: routerRef, method: reg.method, path: reg.path, handlers: handlers.slice(-1), file, line: lineOf(mod.sf, node) });
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "use" && node.arguments.length >= 2) {
          const prefix = stringOf(node.arguments[0]);
          const child = project.valueRef(mod, node.arguments[node.arguments.length - 1]);
          const parent = project.valueRef(mod, node.expression.expression);
          if (prefix?.startsWith("/") && child && parent) mounts.push({ child, parent, prefix });
        }
      }
      if (ts.isClassDeclaration(node) && node.name) {
        const decos = (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined) ?? [];
        const ctrl = decos.find((d) => ts.isCallExpression(d.expression) && d.expression.expression.getText(mod.sf) === "Controller");
        if (ctrl && ts.isCallExpression(ctrl.expression)) {
          const prefix = stringOf(ctrl.expression.arguments[0]) ?? "";
          for (const m of node.members) {
            if (!ts.isMethodDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) continue;
            for (const d of (ts.canHaveDecorators(m) ? ts.getDecorators(m) : undefined) ?? []) {
              if (!ts.isCallExpression(d.expression)) continue;
              const verb = d.expression.expression.getText(mod.sf);
              if (!/^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.test(verb)) continue;
              const path = joinPath(prefix, stringOf(d.expression.arguments[0]) ?? "");
              const fn = mod.byQual.get(`${node.name.text}.${m.name.text}`);
              const method = verb === "All" ? "ANY" : verb.toUpperCase();
              if (!fn) continue;
              const id = addNode({ id: `route:${svc}:${method} ${path}`, kind: "route", name: `${method} ${path}`, service: svc, method, path, file, line: lineOf(mod.sf, m), handler: fn.id });
              addEdge(id, fn.id, "handles", file, lineOf(mod.sf, m));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.sf);
  }
  const parentOf = new Map(mounts.map((m) => [m.child, m]));
  const prefixOf = (ref: string | null, seen = new Set<string>()): string => {
    if (!ref || seen.has(ref)) return "";
    seen.add(ref);
    const m = parentOf.get(ref);
    return m ? joinPath(prefixOf(m.parent, seen), m.prefix) : "";
  };
  for (const r of pendingRoutes) {
    const path = joinPath(prefixOf(r.router), r.path);
    const id = addNode({ id: `route:${svc}:${r.method} ${path}`, kind: "route", name: `${r.method} ${path}`, service: svc, method: r.method, path, file: r.file, line: r.line, handler: r.handlers[0] });
    for (const h of r.handlers) addEdge(id, h, "handles", r.file, r.line);
  }

  // -------------------------------------------------------- function bodies
  for (const fn of allFns) {
    const mod = fn.module;
    const sf = mod.sf;
    const file = mod.repoRel;
    const strings: { text: string; line: number }[] = [];
    const amqpBindings: string[] = [];
    let consumes = false;

    const visit = (node: ts.Node) => {
      if (node !== fn.node && fnNodes.has(node)) return; // another named function
      const line = () => lineOf(sf, node);

      if (ts.isCallExpression(node)) {
        const callee = project.callee(fn, node.expression);
        if (callee) addEdge(fn.id, callee.id, "calls", file, line());
        const expr = node.expression;
        const method = ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : "";
        const recv = ts.isPropertyAccessExpression(expr) ? expr.expression : undefined;
        const recvName = recv ? (ts.isIdentifier(recv) ? recv.text : ts.isPropertyAccessExpression(recv) ? recv.name.text : "") : "";

        // Supabase: supabase.from('t').select(), supabase.storage.from('b').upload(), supabase.rpc('fn')
        if (recv && (method === "from" || method === "rpc") && SUPABASE.test(recv.getText(sf).split(".")[0])) {
          const name = stringOf(node.arguments[0]);
          const chain = chainMethods(node);
          if (name && method === "rpc") {
            const id = addNode({ id: `ext:supabase rpc ${name}`, kind: "external", name: `rpc ${name}`, label: "database function" });
            addEdge(fn.id, id, "calls", file, line(), "rpc");
          } else if (name && recvName === "storage") {
            const op = chain.find((m) => SUPABASE_STORAGE[m]);
            if (op && SUPABASE_STORAGE[op][1]) addEdge(fn.id, bucket(name), "writes", file, line(), SUPABASE_STORAGE[op][0]);
            else addEdge(bucket(name), fn.id, "reads", file, line(), op ? SUPABASE_STORAGE[op][0] : "read");
          } else if (name) {
            const op = chain.find((m) => SUPABASE_WRITE[m]);
            if (op) addEdge(fn.id, table(name), "writes", file, line(), SUPABASE_WRITE[op]);
            if (!op || chain.includes("select")) addEdge(table(name), fn.id, "reads", file, line(), "select");
          }
        }

        // HTTP out
        if (ts.isIdentifier(expr) && expr.text === "fetch") {
          const url = templateOf(node.arguments[0], sf, undefined, mod);
          const m = (stringOf(objProp(node.arguments[1], "method")) ?? "GET").toUpperCase();
          const rest = url?.match(/\/rest\/v1\/(\w+)/);
          const store = url?.match(/\/storage\/v1\/object\/(?:public\/|sign\/)?([^/?]+)/);
          if (rest && !/^rpc$/.test(rest[1])) {
            if (m === "GET") addEdge(table(rest[1]), fn.id, "reads", file, line(), "select");
            else addEdge(fn.id, table(rest[1]), "writes", file, line(), REST_OPS[m] ?? m.toLowerCase());
          } else if (store) {
            const name = store[1].replace(/^\{(.*)\}$/, "$1");
            if (m === "GET") addEdge(bucket(name), fn.id, "reads", file, line(), "download");
            else addEdge(fn.id, bucket(name), "writes", file, line(), m === "DELETE" ? "delete" : "upload");
          } else if (url && (url.startsWith("/") || url.startsWith("http") || url.startsWith("{"))) {
            httpCalls.push({ from: fn.id, method: m, url, file, line: line() });
          }
        } else if (recv && HTTP_VERBS.has(method) && !routeRegistration(ts, node)) {
          const imported = ts.isIdentifier(recv) ? mod.imports.get(recv.text) : undefined;
          if (CLIENT_NAME.test(recvName) || imported?.spec === "axios") {
            const urlArg = method === "request" ? objProp(node.arguments[0], "url") : node.arguments[0];
            const url = templateOf(urlArg, sf, undefined, mod);
            const m = method === "request" ? stringOf(objProp(node.arguments[0], "method")) ?? "GET" : method;
            if (url && (url.startsWith("/") || url.startsWith("http") || url.startsWith("{"))) {
              httpCalls.push({ from: fn.id, method: m.toUpperCase(), url, file, line: line() });
            }
          }
        }

        // Prisma: prisma.user.findMany()
        if (recv && ts.isPropertyAccessExpression(recv) && /prisma|^db$|^tx$/i.test(recv.expression.getText(sf).split(".").pop() ?? "")) {
          const model = recv.name.text;
          const tableName = prismaTables.get(model) ?? model;
          if (PRISMA_READ.has(method)) addEdge(table(tableName), fn.id, "reads", file, line(), "select");
          else if (PRISMA_WRITE[method]) addEdge(fn.id, table(tableName), "writes", file, line(), PRISMA_WRITE[method]);
        }

        // AMQP (amqplib) / Kafka (kafkajs)
        if (recv && /ch|chan|channel/i.test(recvName)) {
          if (method === "publish") {
            const key = stringOf(node.arguments[1]);
            if (key) addEdge(fn.id, topic(key), "publishes", file, line(), "publish");
          } else if (method === "sendToQueue") {
            const q = stringOf(node.arguments[0]);
            if (q) addEdge(fn.id, topic(q, "queue"), "publishes", file, line(), "publish");
          } else if (method === "bindQueue") {
            const key = stringOf(node.arguments[2]);
            if (key) amqpBindings.push(key);
          } else if (method === "consume") consumes = true;
        }
        if (recv && /producer/i.test(recvName) && method === "send") {
          const t = stringOf(objProp(node.arguments[0], "topic"));
          if (t) addEdge(fn.id, topic(t, "kafka"), "publishes", file, line(), "publish");
        }
        if (recv && /consumer/i.test(recvName) && method === "subscribe") {
          const one = stringOf(objProp(node.arguments[0], "topic"));
          const many = objProp(node.arguments[0], "topics");
          const keys = one ? [one] : many && ts.isArrayLiteralExpression(many) ? many.elements.map((e) => stringOf(e)).filter((s): s is string => !!s) : [];
          for (const k of keys) amqpBindings.push(k);
          if (keys.length) consumes = true;
        }

        // MinIO
        if (recv && MINIO_OPS[method] && /minio|client|storage|s3/i.test(recvName)) {
          const name = templateOf(node.arguments[0], sf, undefined, mod) ?? "object-storage";
          const [op, write] = MINIO_OPS[method];
          if (write) addEdge(fn.id, bucket(name), "writes", file, line(), op);
          else addEdge(bucket(name), fn.id, "reads", file, line(), op);
        }
      }

      // S3 v3: new PutObjectCommand({ Bucket })
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && S3_COMMANDS[node.expression.text]) {
        const [op, write] = S3_COMMANDS[node.expression.text];
        const b = objProp(node.arguments?.[0], "Bucket");
        const name = (b && templateOf(b, sf, undefined, mod)) || (b ? b.getText(sf).split(".").pop()! : "object-storage");
        if (write) addEdge(fn.id, bucket(name), "writes", file, lineOf(sf, node), op);
        else addEdge(bucket(name), fn.id, "reads", file, lineOf(sf, node), op);
      }

      // JSX renders count as calls: <LotTable /> → LotTable
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        // React Navigation: <Stack.Screen name="Home" component={HomeScreen} /> is an entry point
        if (ts.isPropertyAccessExpression(tag) && tag.name.text === "Screen") {
          const attr = (n: string) => node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === n)?.initializer;
          const nameInit = attr("name");
          const comp = attr("component");
          const screen = nameInit && (ts.isStringLiteral(nameInit) ? nameInit.text : ts.isJsxExpression(nameInit) && nameInit.expression ? stringOf(nameInit.expression) : undefined);
          const target = comp && ts.isJsxExpression(comp) && comp.expression ? project.callee(fn, comp.expression) : null;
          if (screen && target) {
            const id = addNode({ id: `entry:${svc}:screen ${screen}`, kind: "entry", name: `screen ${screen}`, service: svc, trigger: "screen", file, line: lineOf(sf, node) });
            addEdge(id, target.id, "handles", file, lineOf(sf, node));
          }
        }
        if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
          const target = project.callee(fn, tag);
          if (target) addEdge(fn.id, target.id, "calls", file, lineOf(sf, node), "render");
        } else if (ts.isPropertyAccessExpression(tag)) {
          const target = project.callee(fn, tag);
          if (target) addEdge(fn.id, target.id, "calls", file, lineOf(sf, node), "render");
        }
      }

      // SQL in literals (incl. sql`…` tagged templates)
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push({ text: node.text, line: lineOf(sf, node) });
      else if (ts.isTemplateExpression(node)) {
        strings.push({ text: templateOf(node, sf, PH) ?? "", line: lineOf(sf, node) });
        return; // its spans' literals are covered
      }
      ts.forEachChild(node, visit);
    };
    const body = (fn.node as ts.FunctionLikeDeclaration).body;
    if (body) visit(body);

    const ctes = new Set<string>();
    for (const s of strings) for (const c of cteNames(s.text)) ctes.add(c);
    for (const s of strings) {
      if (s.text.length < 12) continue;
      const { writes, reads } = analyzeSql(s.text, ctes) as { writes: Record<string, string>; reads: Set<string> };
      for (const [t, op] of Object.entries(writes)) addEdge(fn.id, table(t), "writes", file, s.line, op);
      for (const t of reads) addEdge(table(t), fn.id, "reads", file, s.line, "select");
    }
    if (consumes) for (const key of amqpBindings) addEdge(topic(key), fn.id, "consumes", file, lineOf(sf, fn.node), "subscribe");
  }

  const rewrites = nextRewrites(req.root);
  if (rewrites.length) for (const c of httpCalls) c.url = applyRewrites(c.url, rewrites);

  return {
    service: {
      name: svc,
      language: "typescript",
      root: req.rootRel,
      stats: { modules: project.modules.size, functions: allFns.length, nodes: nodes.size, edges: edges.size, ms: Date.now() - started },
    },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    httpCalls,
    warnings: project.warnings,
  };
}
