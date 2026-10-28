// Span bookkeeping, value snapshots and the event sink for the Node tracer.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

const DEFAULT_REDACT = "pass(word|wd)?|secret|token|authorization|api[_-]?key|cookie|credential|private[_-]?key";
const OPAQUE = /^(IncomingMessage|ServerResponse|Socket|TLSSocket|Server|Agent|ClientRequest|Client|Pool|PoolClient|Connection|ChannelModel|Channel|ConfirmChannel|EventEmitter|Readable|Writable|Duplex|Transform|PrismaClient|Knex|Sequelize|Logger)$/;

export function parseTraceparent(value) {
  const m = typeof value === "string" && value.trim().toLowerCase().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  return m ? [m[1], m[2]] : null;
}

export function createRuntime(cfg) {
  const als = new AsyncLocalStorage();
  const redact = cfg.redact ? new RegExp(cfg.redact, "i") : new RegExp(DEFAULT_REDACT, "i");
  const wall0 = Date.now() / 1000;
  const perf0 = performance.now();
  const now = () => wall0 + (performance.now() - perf0) / 1000;
  let seq = 0;
  let busy = false;
  let warned = false;
  const queue = [];
  const fetchImpl = globalThis.fetch; // captured before any patching
  const collector = cfg.collector ? `${cfg.collector.replace(/\/$/, "")}/api/events` : null;

  // ------------------------------------------------------------------ snapshots
  function snap(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value ?? null;
    const t = typeof value;
    if (t === "boolean" || t === "number") return Number.isFinite(value) || t === "boolean" ? value : String(value);
    if (t === "string") return value.length > 400 ? `${value.slice(0, 400)}…(+${value.length - 400})` : value;
    if (t === "bigint") return `${value}n`;
    if (t === "function") return `<fn ${value.name || "anonymous"}>`;
    if (t === "symbol") return value.toString();
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `<${value.byteLength} bytes>`;
    if (value instanceof Error) return { __type__: value.name, message: value.message };
    if (typeof value.then === "function") return "<Promise>";
    if (seen.has(value)) return "<circular>";
    if (depth >= 4) return Array.isArray(value) ? `<Array(${value.length})>` : `<${value.constructor?.name ?? "Object"}>`;
    seen.add(value);
    if (Array.isArray(value) || value instanceof Set) {
      const arr = [...value];
      const out = arr.slice(0, 25).map((v) => snap(v, depth + 1, seen));
      if (arr.length > 25) out.push(`…+${arr.length - 25} more`);
      return out;
    }
    const name = value.constructor?.name;
    if (value instanceof Map) return snap(Object.fromEntries([...value].slice(0, 25).map(([k, v]) => [String(k), v])), depth, seen);
    const plain = !name || name === "Object";
    if (!plain && OPAQUE.test(name)) return `<${name}>`;
    const keys = Object.keys(value).filter((k) => !k.startsWith("_"));
    if (!plain && keys.length > 40) return `<${name}>`;
    const out = plain ? {} : { __type__: name };
    for (const k of keys.slice(0, 25)) {
      let v;
      try {
        v = value[k];
      } catch {
        v = "<unreadable>";
      }
      out[k] = redact.test(k) ? "***" : snap(v, depth + 1, seen);
    }
    if (keys.length > 25) out["…"] = `+${keys.length - 25} more`;
    return out;
  }

  // ------------------------------------------------------------------- sink
  function put(record) {
    queue.push(record);
    if (queue.length >= 300) flush();
  }

  function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    const body = JSON.stringify(batch);
    if (cfg.out) {
      try {
        appendFileSync(cfg.out, batch.map((r) => JSON.stringify(r)).join("\n") + "\n");
      } catch (e) {
        warn(`cannot write ${cfg.out}: ${e.message}`);
      }
    }
    if (collector && fetchImpl) {
      fetchImpl(collector, { method: "POST", headers: { "content-type": "application/json" }, body }).catch((e) =>
        warn(`collector ${collector} unreachable (${e.cause?.code ?? e.message}); dropping events`),
      );
    }
  }

  function warn(msg) {
    if (!warned) {
      warned = true;
      process.stderr.write(`[flowlens] ${msg}\n`);
    }
  }

  setInterval(flush, 250).unref();
  process.on("beforeExit", flush);
  process.on("exit", () => {
    // last synchronous chance: file sink only
    if (cfg.out && queue.length) {
      try {
        appendFileSync(cfg.out, queue.splice(0).map((r) => JSON.stringify(r)).join("\n") + "\n");
      } catch {}
    }
  });

  // ------------------------------------------------------------------ spans
  const id = (n) => randomBytes(n).toString("hex");

  function newSpan(node, name, kind, { remote, root } = {}) {
    const parent = root ? null : als.getStore() ?? null;
    return {
      trace: parent ? parent.trace : remote ? remote[0] : id(16),
      id: id(8),
      parent: parent ? parent.id : remote ? remote[1] : null,
      node, name, kind,
      start: now(),
      seq: ++seq,
      input: null,
      args: null,
      file: undefined,
      line: undefined,
    };
  }

  function emitSpan(span, output, error, extra = {}) {
    const record = {
      kind: "span", service: cfg.service, trace: span.trace, span: span.id, parent: span.parent, node: span.node,
      name: span.name, type: span.kind, start: span.start, end: now(), seq: span.seq, endSeq: ++seq,
      input: span.input, output: error ? null : output, status: error ? "error" : "ok", pid: process.pid, ...extra,
    };
    if (span.file) Object.assign(record, { file: span.file, line: span.line });
    if (error) record.error = { type: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) };
    put(record);
  }

  /** Called by instrumented functions: run `fn` as a span. */
  function run(nodeId, name, file, line, names, args, fn) {
    if (busy) return fn();
    busy = true;
    let span;
    try {
      span = newSpan(nodeId, name, "function");
      span.file = file;
      span.line = line;
      const input = {};
      const live = {};
      const list = args ? Array.from(args) : [];
      list.forEach((v, i) => {
        const key = names?.[i] ?? `arg${i}`;
        input[key] = redact.test(key) ? "***" : snap(v);
        if (v && typeof v === "object" && !ArrayBuffer.isView(v)) live[key] = v;
      });
      span.input = input;
      span.args = live;
    } finally {
      busy = false;
    }
    const finish = (value, error) => {
      busy = true;
      try {
        let mutated;
        for (const [k, v] of Object.entries(span.args)) {
          const after = snap(v);
          if (JSON.stringify(after) !== JSON.stringify(span.input[k])) (mutated ??= {})[k] = after;
        }
        emitSpan(span, error ? null : snap(value), error, mutated ? { mutated } : {});
      } finally {
        busy = false;
      }
    };
    let result;
    try {
      result = als.run(span, fn);
    } catch (e) {
      finish(undefined, e);
      throw e;
    }
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          finish(v);
          return v;
        },
        (e) => {
          finish(undefined, e);
          throw e;
        },
      );
    }
    finish(result);
    return result;
  }

  /** Entry spans opened by hooks (requests, messages). Returns the span; run the work with `als.run(span, …)`. */
  function startSpan(node, name, kind, input, opts) {
    const span = newSpan(node, name, kind, opts);
    span.input = input;
    return span;
  }

  function endSpan(span, output, error) {
    emitSpan(span, output, error);
  }

  function event(type, op, targets, detail, start, error) {
    const span = als.getStore();
    if (!span) return;
    const record = {
      kind: "event", service: cfg.service, trace: span.trace, span: span.id, type, op, targets,
      ts: start, durationMs: Math.round((now() - start) * 1e6) / 1e3, seq: ++seq, detail, pid: process.pid,
    };
    if (error) record.error = { type: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) };
    put(record);
  }

  const traceparent = () => {
    const s = als.getStore();
    return s ? `00-${s.trace}-${s.id}-01` : null;
  };

  return { als, run, startSpan, endSpan, event, snap, now, traceparent, flush, cfg, fetchImpl, collector };
}
