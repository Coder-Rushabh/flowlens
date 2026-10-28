# Runtime tracing

The tracer records each call to project code as a **span**: arguments in, value out, arguments it mutated, error, and timing. Library hooks add **events** to the current span (SQL, HTTP, publish, storage) and open **entry spans** for inbound requests and consumed messages. Records go to the collector (`flowlens ui`), which stores them in `<repo>/.flowlens/traces.db` (the newest 2000 runs are kept).

Span node ids are the static scanner's ids (`fn:<service>:<module>.<qualname>`, `route:…`, `topic:…`), so runs land on the same graph. **The service name the tracer uses must match the name in `flowlens.yaml`.**

## Python

```bash
export PYTHONPATH=<flowlens>/adapters/python
python -m flowlens.trace --service orders -m uvicorn app.main:app      # any module
python -m flowlens.trace --service jobs scripts/nightly.py             # or a script
```

These alternatives need no command changes:
- **sitecustomize:** set `PYTHONPATH=<flowlens>/adapters/python/bootstrap:<flowlens>/adapters/python` and `FLOWLENS_TRACE=1`. Every Python process traces itself, including uvicorn workers and Celery workers. `flowlens docker` uses this.
- **In code:** call `import flowlens.trace; flowlens.trace.install(service="orders")` early in your entry point.

| Python | Backend | Notes |
|---|---|---|
| 3.12+ | `sys.monitoring` | Library code is disabled per code object after its first call, so overhead is mostly in your own functions |
| 3.9–3.11 | `sys.setprofile` | Every call reaches the tracer: expect a noticeable slowdown. Exceptions are detected but their type is shown as `UnwoundError` |

## Node

```bash
FLOWLENS_SERVICE=api node --import file:///<flowlens>/adapters/node/register.mjs dist/server.js
```

Needs Node 22.15+ (`module.registerHooks`) and the `typescript` package, which resolves from the FlowLens repo.

- **Instrumented code:** files under `FLOWLENS_ROOT` that are outside `node_modules` are rewritten as they load. Only the functions the static scanner names are wrapped, using the same naming module, so IDs always match. Nested callbacks belong to their enclosing function.
- **Context:** `AsyncLocalStorage` carries the current span across `await`.
- **Bundled apps:** Next.js server bundles in `.next/` are not instrumented. Inbound requests and outgoing `fetch` calls are still recorded.

## Options (environment variables; Python also accepts `--option value`)

| Variable | Meaning | Default |
|---|---|---|
| `FLOWLENS_SERVICE` | service name, as in `flowlens.yaml` | root folder name |
| `FLOWLENS_ROOT` | service root; module names are computed from it | current directory |
| `FLOWLENS_COLLECTOR` | collector base URL; empty disables sending | `http://127.0.0.1:4870` |
| `FLOWLENS_OUT` | also append records to this JSONL file (`flowlens import` loads it) | — |
| `FLOWLENS_REDACT` | regex of keys whose values become `***` | password, secret, token, authorization, api key, cookie, credential |
| `FLOWLENS_EXCLUDE` | (Python) comma-separated globs not to trace | tests, venvs |
| `FLOWLENS_HOOKS_OFF` | (Python) libraries not to hook, e.g. `aio_pika,minio` | — |
| `FLOWLENS_BACKEND` | (Python) `auto`, `monitoring` or `profile` | `auto` |
| `FLOWLENS_QUIET` | no startup line | — |

## Containers

`flowlens docker` writes a compose override. It finds every service built from a scanned service's folder, plus workers that reuse that image. For Python services the override mounts the adapter and turns tracing on via sitecustomize. For Node services it adds `--import` to `NODE_OPTIONS`. Containers reach the collector at `host.docker.internal:4871`, so run `flowlens ui --ingest-host 0.0.0.0`. That port only accepts events; the UI and its source-code API stay on loopback.

## What is captured, and the limits

- Values are snapshots, capped at depth 4, 25 items and 400 characters per string. Data-shaped objects are expanded (dataclasses, pydantic and ORM rows; your own classes; plain JS objects). Library internals like connections and clients show as `<sqlalchemy.Connection>`.
- **Mutation diffs:** an argument whose snapshot differs at return is reported under "Changed arguments".
- **Queue hops:** a message's consumer span is a child of the publisher's span. When it starts after the publisher returned, the debugger places it after that return.
- **Not production tooling:** no sampling, and every traced call is recorded. Use it locally and in dev or staging.
- **Personal data:** snapshots contain real data, so `traces.db` stays on your machine. Redaction is by key name only.
