// FlowLens runtime tracer for Node.js.  node --import <flowlens>/adapters/node/register.mjs app.js
//
// Environment:
//   FLOWLENS_SERVICE    service name (must match flowlens.yaml; default: root folder name)
//   FLOWLENS_ROOT       service root (default: cwd); only files under it (outside node_modules) are instrumented
//   FLOWLENS_COLLECTOR  collector base URL (default http://127.0.0.1:4870; empty disables)
//   FLOWLENS_OUT        also append records to this JSONL file
//   FLOWLENS_REDACT     regex of keys whose values are masked
//   FLOWLENS_QUIET=1    no startup line

import Module, { createRequire, registerHooks } from "node:module";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, parseTraceparent } from "./runtime.mjs";
import { analyzeSql } from "./sql.mjs";
import { instrument } from "./transform.mjs";

const env = process.env;
const root = resolve(env.FLOWLENS_ROOT || process.cwd());
const cfg = {
  service: env.FLOWLENS_SERVICE || basename(root),
  collector: env.FLOWLENS_COLLECTOR ?? "http://127.0.0.1:4870",
  out: env.FLOWLENS_OUT || null,
  redact: env.FLOWLENS_REDACT || null,
};
const rt = createRuntime(cfg);
globalThis.__flowlens = rt;
const svc = cfg.service;

// ---------------------------------------------------------- instrumentation
const rootPrefix = root.endsWith(sep) ? root : root + sep;
const SKIP = /[\\/](node_modules|\.next|dist[\\/]flowlens)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/;

if (typeof registerHooks !== "function") {
  process.stderr.write("[flowlens] module.registerHooks needs Node >= 22.15; only library hooks are active\n");
} else {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      const format = result.format;
      if (!["module", "commonjs", "module-typescript", "commonjs-typescript"].includes(format) || result.source == null) return result;
      const file = fileURLToPath(url);
      if (!file.startsWith(rootPrefix) || SKIP.test(file)) return result;
      try {
        const code = instrument(String(result.source), {
          fileName: file,
          rel: relative(root, file).replace(/\\/g, "/"),
          service: svc,
          typescript: format.endsWith("-typescript"),
        });
        if (code === null) return result;
        return { ...result, format: format.replace("-typescript", ""), source: code, shortCircuit: true };
      } catch (e) {
        process.stderr.write(`[flowlens] could not instrument ${file}: ${e.message}\n`);
        return result;
      }
    },
  });
}

// ----------------------------------------------------------------- HTTP in
const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");

for (const proto of [http.Server.prototype, https.Server.prototype]) {
  const origEmit = proto.emit;
  proto.emit = function (type, req, res) {
    if (type !== "request" || !req?.method) return origEmit.apply(this, arguments);
    const [path, query] = String(req.url ?? "/").split("?");
    const span = rt.startSpan(`route:${svc}:${req.method} ${path}`, `${req.method} ${path}`, "route",
      { method: req.method, path, query: query ?? null }, { remote: parseTraceparent(req.headers?.traceparent), root: true });
    res.once("finish", () => {
      // Express sets req.route; use the template so the span lands on the static route node
      const template = req.route?.path ? `${req.baseUrl ?? ""}${req.route.path}` : null;
      if (template) {
        span.node = `route:${svc}:${req.method} ${template}`;
        span.name = `${req.method} ${template}`;
      }
      rt.endSpan(span, { status: res.statusCode }, res.statusCode >= 500 ? new Error(`HTTP ${res.statusCode}`) : null);
    });
    return rt.als.run(span, () => origEmit.apply(this, arguments));
  };
}

// ---------------------------------------------------------------- HTTP out
const isCollector = (url) => rt.collector && String(url).startsWith(rt.collector.replace(/\/api\/events$/, ""));

if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    if (isCollector(url)) return origFetch(input, init);
    const method = (init?.method ?? input?.method ?? "GET").toUpperCase();
    const tp = rt.traceparent();
    if (tp) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("traceparent", tp);
      init = { ...init, headers };
    }
    const start = rt.now();
    try {
      const res = await origFetch(input, init);
      rt.event("http", `${method} ${url}`.slice(0, 300), [], { method, url: String(url).slice(0, 1000), status: res.status }, start);
      return res;
    } catch (e) {
      rt.event("http", `${method} ${url}`.slice(0, 300), [], { method, url: String(url).slice(0, 1000), status: null }, start, e);
      throw e;
    }
  };
}

for (const [mod, scheme] of [[http, "http"], [https, "https"]]) {
  const origRequest = mod.request;
  mod.request = function (...args) {
    const opts = typeof args[0] === "string" || args[0] instanceof URL ? new URL(args[0]) : args[0] ?? {};
    const host = opts.hostname ?? opts.host ?? "localhost";
    const url = opts.href ?? `${scheme}://${host}${opts.port ? `:${opts.port}` : ""}${opts.path ?? opts.pathname ?? "/"}`;
    const req = origRequest.apply(this, args);
    if (isCollector(url) || !rt.als.getStore()) return req;
    const tp = rt.traceparent();
    if (tp && !req.headersSent) {
      try {
        req.setHeader("traceparent", tp);
      } catch {}
    }
    const method = (opts.method ?? "GET").toUpperCase();
    const start = rt.now();
    req.once("response", (res) => rt.event("http", `${method} ${url}`.slice(0, 300), [], { method, url, status: res.statusCode }, start));
    req.once("error", (e) => rt.event("http", `${method} ${url}`.slice(0, 300), [], { method, url, status: null }, start, e));
    return req;
  };
  mod.get = function (...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

// ------------------------------------------------- pg / amqplib (on require)
function sqlTargets(text) {
  const { writes, reads } = analyzeSql(String(text ?? ""));
  const targets = Object.entries(writes).map(([t, op]) => ({ node: `table:${t}`, op }));
  for (const t of reads) if (!(t in writes)) targets.push({ node: `table:${t}`, op: "select" });
  return { targets, op: Object.values(writes)[0] ?? (reads.size ? "select" : "sql") };
}

function patchPg(pg) {
  const Client = pg?.Client;
  if (!Client || Client.prototype.__flowlens) return;
  Client.prototype.__flowlens = true;
  const orig = Client.prototype.query;
  Client.prototype.query = function (config, values, callback) {
    const text = typeof config === "string" ? config : config?.text;
    const params = Array.isArray(values) ? values : config?.values;
    if (!rt.als.getStore() || !text) return orig.apply(this, arguments);
    const start = rt.now();
    const { targets, op } = sqlTargets(text);
    const record = (result, error) =>
      rt.event("db", op, targets, { statement: String(text).slice(0, 3000), params: rt.snap(params ?? null), rowcount: result?.rowCount ?? null }, start, error);
    const cb = typeof values === "function" ? values : typeof callback === "function" ? callback : null;
    if (cb) {
      const wrapped = (err, res) => {
        record(res, err);
        return cb(err, res);
      };
      return typeof values === "function" ? orig.call(this, config, wrapped) : orig.call(this, config, values, wrapped);
    }
    const out = orig.apply(this, arguments);
    if (out && typeof out.then === "function") out.then((r) => record(r), (e) => record(null, e));
    return out;
  };
}

function patchAmqpChannel(ch) {
  const proto = Object.getPrototypeOf(ch);
  if (!proto || proto.__flowlens) return;
  proto.__flowlens = true;
  const body = (content) => {
    try {
      return rt.snap(JSON.parse(content.toString()));
    } catch {
      return `<${content?.length ?? 0} bytes>`;
    }
  };
  const origPublish = proto.publish;
  proto.publish = function (exchange, key, content, options = {}) {
    const tp = rt.traceparent();
    if (tp) options = { ...options, headers: { ...(options.headers ?? {}), traceparent: tp } };
    const start = rt.now();
    const out = origPublish.call(this, exchange, key, content, options);
    rt.event("publish", "publish", [{ node: `topic:${key}`, op: "publish" }], { routingKey: key, exchange, body: body(content) }, start);
    return out;
  };
  const origSend = proto.sendToQueue;
  proto.sendToQueue = function (queue, content, options = {}) {
    const tp = rt.traceparent();
    if (tp) options = { ...options, headers: { ...(options.headers ?? {}), traceparent: tp } };
    const start = rt.now();
    const out = origSend.call(this, queue, content, options);
    rt.event("publish", "publish", [{ node: `topic:${queue}`, op: "publish" }], { routingKey: queue, body: body(content) }, start);
    return out;
  };
  const origConsume = proto.consume;
  proto.consume = function (queue, onMessage, options) {
    const traced = (msg) => {
      if (!msg) return onMessage(msg);
      const key = msg.fields?.routingKey ?? queue;
      const span = rt.startSpan(`topic:${key}`, `consume ${key}`, "consume", { routingKey: key, body: body(msg.content) },
        { remote: parseTraceparent(msg.properties?.headers?.traceparent), root: true });
      let out;
      try {
        out = rt.als.run(span, () => onMessage(msg));
      } catch (e) {
        rt.endSpan(span, null, e);
        throw e;
      }
      if (out instanceof Promise) out.then(() => rt.endSpan(span, null), (e) => rt.endSpan(span, null, e));
      else rt.endSpan(span, null);
      return out;
    };
    return origConsume.call(this, queue, traced, options);
  };
}

function patchAmqplib(amqp) {
  if (!amqp?.connect || amqp.__flowlens) return;
  amqp.__flowlens = true;
  const origConnect = amqp.connect;
  amqp.connect = async function (...args) {
    const conn = await origConnect.apply(this, args);
    for (const m of ["createChannel", "createConfirmChannel"]) {
      const orig = conn[m]?.bind(conn);
      if (orig) {
        conn[m] = async (...a) => {
          const ch = await orig(...a);
          patchAmqpChannel(ch);
          return ch;
        };
      }
    }
    return conn;
  };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const exports = origLoad.apply(this, arguments);
  try {
    if (request === "pg") patchPg(exports);
    else if (request === "amqplib") patchAmqplib(exports);
  } catch (e) {
    process.stderr.write(`[flowlens] could not hook ${request}: ${e.message}\n`);
  }
  return exports;
};

if (!env.FLOWLENS_QUIET) {
  process.stderr.write(`[flowlens] tracing service=${svc} root=${root} -> ${cfg.collector || cfg.out}\n`);
}
