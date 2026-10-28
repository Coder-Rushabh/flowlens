# Architecture

```
 repo ──▶ static scanners (python: subprocess, ts/js: in-process) ──▶ partial graphs ──▶ merge ──▶ graph.json ─┐
                                                                                                            ├─▶ UI
 running services ──▶ runtime tracers (python, node) ──▶ POST /api/events ──▶ trace store (SQLite) ─────────┘
```

**Why it stays generic:** the UI, merge step and trace store only know a small vocabulary ([schema](../schema/graph.schema.json)). Each language adapter maps its frameworks onto that vocabulary:

- **Node kinds:** `route`, `entry`, `function`, `table`, `topic`, `bucket`, `external`, `service`
- **Edge kinds:** `handles`, `calls`, `reads`, `writes`, `publishes`, `consumes`, `routes`, `http`. Edges point the way data moves, so a read is `table → function`.
- **Runtime records:** `span` (one finished call or entry) and `event` (SQL, HTTP, publish, storage inside a span)

Static and runtime data join on **node ids**: `fn:<service>:<module>.<qualname>`, `route:<service>:<METHOD> <path>`, `topic:<key>`, `table:<schema.table>`. Each tracer computes them the same way its scanner does. For JS/TS both use [naming.mjs](../adapters/node/naming.mjs).

## Static pipeline

1. **Discover** ([config.ts](../packages/core/src/config.ts)): Reads `flowlens.yaml`, or detects services by marker files.
2. **Scan per service** ([scan.ts](../packages/core/src/scan.ts)):
   - **Python:** runs `python -m flowlens.scan` (stdlib `ast`; JSON in/out).
   - **TS/JS:** runs [scanners/typescript.ts](../packages/core/src/scanners/typescript.ts) (TypeScript compiler API, parse only).
3. **Merge** ([merge.ts](../packages/core/src/merge.ts)):
   - Shared tables, topics and buckets collapse to one node each; unqualified tables fold into their single schema-qualified twin.
   - Routing keys flow into matching wildcard bindings.
   - Outbound HTTP calls are matched to routes, by path template (greedy params included), segment alignment, method, and host/env hints. Unmatched calls become `external` nodes.
4. **Views** ([views.ts](../packages/ui/src/graph/views.ts)): Each zoom level is a projection of the same graph. Architecture views use fixed columns (inputs │ code │ storage │ outside); flows use ELK.

## Runtime pipeline

1. **Tracers:**
   - **Python** ([trace/](../adapters/python/flowlens/trace)): `sys.monitoring`, or `sys.setprofile` before 3.12, with post-import library hooks.
   - **Node** ([register.mjs](../adapters/node/register.mjs)): load-time source transform of named functions, `AsyncLocalStorage` for context, and library hooks.
   - **Both:** spans are emitted when they finish, batched off the hot path, and sent with W3C `traceparent` on outgoing HTTP and messages.
2. **Store** ([store.ts](../packages/core/src/store.ts)): spans, events, per-trace summaries, and aggregated runtime edges. Children usually arrive before their parents, so edges are derived from whichever side arrives second.
3. **Debugger** ([runtime/model.ts](../packages/ui/src/runtime/model.ts)):
   - The span tree is flattened into steps: enter → events and children in time order → exit. Async continuations come after the parent's exit.
   - Value lineage scans step payloads for a picked value. Cross-run search is a SQL `LIKE` over stored payloads.

## Extending

### A Python detector (no fork needed)

```python
# my_detectors.py, in your repo
from flowlens.scan.context import Detector

class GrpcDetector(Detector):
    name = "grpc"
    def index(self, ctx, mod): ...          # every module first (find servicers, routers, models…)
    def analyze(self, ctx, scope):          # then every function body
        for call in scope.calls: ...        # scope: calls, assigns, strings, attr_stores, resolve(), class_of(), values_of()
            # ctx.graph.add_edge(scope.fn.id, ctx.topic("x"), "publishes", scope.fn.path, call.lineno, "publish")
```

```yaml
# flowlens.yaml
detectors:
  plugins: ["my_detectors.py:GrpcDetector"]   # path relative to the repo root, or "package.module:Class"
```

A plugin that fails to load becomes a scan warning; it never stops the scan.

### A language

Write two pieces:
- **A scanner** that emits a partial graph (`{service, nodes, edges, httpCalls, warnings}`), wired into `scanService()`.
- **A tracer** that POSTs `span` / `event` records to `/api/events` (see `SpanRecord` / `EventRecord` in [store.ts](../packages/core/src/store.ts)).

Use the same node-id rules in both, and propagate `traceparent`.

## Known limits

- **Static dynamic dispatch:** dependency injection, callbacks stored in dicts, and `getattr` aren't resolved statically. Runtime edges (`origin: runtime`) fill these gaps once a run exercises them.
- **Computed names:** names built at runtime are skipped. `auth.{table}` is dropped and `{schema}.users` becomes `users`. HTTP hosts held in generic variables (`base_url`) show per calling service.
- **Python 3.11 and earlier:** exceptions are flagged but untyped, and tracing has noticeable overhead.
- **Node:** only unbundled code is instrumented (not `.next/` bundles), and there are no browser-side traces.

## Status

| Phase | Deliverable | Status |
|---|---|---|
| 0–1 | schema, config, Python static scanner, explorer (system → service → module → flow, lineage) | done |
| 2 | Python runtime tracer, collector, trace store, step debugger with values, diffs and SQL | done |
| 3 | cross-service stitching over HTTP and AMQP (`traceparent`) | done |
| 4 | TypeScript/JavaScript scanner (Next.js, Express, NestJS, Prisma, axios/fetch, rewrites) and Node runtime tracer | done |
| 5 | value lineage (in-run and cross-run), runtime overlay on static views, Python detector plugins, `flowlens docker` | done |
| next | browser-side tracing, Kafka/Celery runtime hooks, sampling for shared environments, TS detector plugins | ideas |
