# FlowLens

See how data moves through a codebase: where it enters, which functions transform it, where it lands. Then step through a real run like a debugger, with the actual values at every step. Works on any repository: Python and TypeScript/JavaScript today, with more languages possible through the adapter interface.

```
page /orders ─▶ OrderPage ─▶ ordersApi.create ─HTTP─▶ POST /orders ─▶ place_order ─▶ INSERT orders
                                                                         └─▶ publish order.placed ─▶ inventory worker ─▶ UPDATE stock_levels
```

FlowLens has two halves that share one graph:

| | Static map | Runtime debugger |
|---|---|---|
| Source | parses your code (never runs it) | records real executions |
| Shows | everything that *can* happen | what *did* happen, with values |
| Views | System → Service → Module → Flow, Lineage | Runs list, step debugger, value lineage |
| Needs | nothing but the repo | the tracer attached to the running app |

Runtime edges are overlaid on the static views: solid means seen at runtime, dashed means static only.

## Quick start

Requirements: Node ≥ 22.18, plus Python ≥ 3.9 for scanning Python services.

```bash
cd D:/flowlens && npm install && npm run build      # once

npm run flowlens -- init D:/my-repo     # optional: writes flowlens.yaml (edit the service list)
npm run flowlens -- ui   D:/my-repo     # scans, opens http://127.0.0.1:4870, collects runtime events
```

### Record runs

**Docker Compose** (no code or image changes):

```bash
npm run flowlens -- docker D:/my-repo                     # writes .flowlens/docker-compose.flowlens.yml
npm run flowlens -- ui D:/my-repo --ingest-host 0.0.0.0   # containers send events to :4871
docker compose -f docker-compose.yml -f .flowlens/docker-compose.flowlens.yml up -d <services>
```

Undo it by running `up -d` again without the second `-f`.

**Local processes:**

```bash
# Python (3.9+; full fidelity on 3.12+)
PYTHONPATH=D:/flowlens/adapters/python python -m flowlens.trace --service orders -m uvicorn app.main:app

# Node (22.15+); .ts files work under Node's native type stripping
FLOWLENS_SERVICE=api node --import file:///D:/flowlens/adapters/node/register.mjs server.js
```

Then send some traffic and open **Runs**. See [docs/runtime.md](docs/runtime.md) for all options.

## Commands

| Command | What it does |
|---|---|
| `flowlens init [repo] [--force]` | Detects services and writes `flowlens.yaml` |
| `flowlens scan [repo] [--out FILE]` | Static scan → `<repo>/.flowlens/graph.json` |
| `flowlens ui [repo] [--port N] [--rescan] [--no-open] [--ingest-host H] [--ingest-port N]` | Explorer + collector (loopback only; the optional ingest listener accepts only events) |
| `flowlens docker [repo] [--collector URL]` | Compose override that traces every container built from a scanned service |
| `flowlens import FILE.jsonl [repo]` | Loads runs recorded offline with `FLOWLENS_OUT` |

`.flowlens/` (graph, `traces.db`, compose override) ignores itself in git.

## In the UI

- **Ctrl+K** search; **click** to inspect; **double-click** to drill in.
- **Flow / Lineage:** everything downstream of an entry point, or everything upstream that writes a table.
- **Runs → Debugger:**
  - **←/→** step; **Shift+→** step over; **Shift+←** step back over; **↑** step out; **Home/End**.
  - Each step shows arguments, return values, **changed arguments as a diff**, SQL with parameters, HTTP status, message bodies and the source.
  - The canvas follows the current node and lights the call stack.
  - **Play data flow** (or **Space**) animates the run: a packet carrying the real value travels each edge. Arguments go into a call, the result goes back to the caller, parameters go into a table and rows come out. A step with several targets sends one packet to each. A card under every visited node shows what came **in**, what went **out**, and which arguments it **changed**.
- **Play flow** on a static Flow view sends packets labeled with each edge's operation, one wave at a time. Every edge leaving the same node animates together, so splits are easy to see.
- **Value lineage:** click any value (an id, an email) to see every step it passed through in that run. **Find in other runs** searches all recorded runs.
- **Recent runs through here:** shown on any node in the static views.

## What it understands

| | Python | TypeScript / JavaScript |
|---|---|---|
| Entry points | FastAPI/Starlette (nested routers), Flask/Quart blueprints, `__main__`, APScheduler | Next.js app & pages routers (routes and pages), Express-style routers with `use()` prefixes, NestJS controllers, React Navigation screens |
| Calls | imports, re-exports, methods, `super()`, typed locals | imports, tsconfig `paths`, re-exports, object-literal APIs, class methods, JSX renders |
| Data | SQLAlchemy/SQLModel, Django ORM, raw SQL (CTE-aware) | Prisma (`@@map`), Supabase (`from`, `rpc`, `storage`, PostgREST URLs), raw SQL / `sql` templates |
| Messaging | pika, aio-pika, kombu, Kafka, Redis, Celery, Dramatiq | amqplib, kafkajs |
| Storage | boto3/S3, MinIO, GCS, Azure Blob | S3 v3 commands, MinIO |
| HTTP out | httpx, requests, aiohttp | fetch, axios and API-client wrappers, Next.js `rewrites()` |
| **Runtime** | functions (args, returns, mutations, errors), SQLAlchemy, httpx, requests, Starlette/FastAPI, Flask, aio-pika, pika, MinIO, boto3 | instrumented functions, http/https servers (Express route templates), fetch, http.request, pg, amqplib |

Outbound HTTP calls are matched to routes in the other scanned services. Matching handles path params, `{x:path}` / `[...slug]` catch-alls, Next.js rewrites and host hints. Runtime context propagates via W3C `traceparent` over HTTP and message headers, so one run spans every service it touches.

## Layout

```
packages/core     CLI, discovery, Python scan orchestration, TS scanner, merge, trace store (SQLite), server
packages/ui       explorer + debugger (React, React Flow, ELK)
adapters/python   `flowlens` package: static scanner + runtime tracer (stdlib only)
adapters/node     runtime tracer (register.mjs) + naming/SQL modules shared with the TS scanner
schema/           graph.schema.json
examples/shop           two-service static fixture (FastAPI + Flask)
examples/runtime-demo   runnable traced demo (FastAPI, SQLAlchemy, httpx, RabbitMQ)
docs/             config, runtime tracing, architecture and extension guide
```

## Develop

```bash
npm test           # core + TS scanner + Node tracer (node:test), Python scanner + tracer (unittest)
npm run typecheck
npm run dev:ui     # Vite on :5173 proxying /api to `flowlens ui --no-open`
```

The Python tracer's profile backend (3.9–3.11) is exercised by running `python -m unittest tests.test_trace` under such an interpreter. Its other variant is skipped on 3.12+.
