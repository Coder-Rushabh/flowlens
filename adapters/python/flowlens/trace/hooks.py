"""Library hooks: SQL, HTTP in/out, AMQP, object storage. Applied when the library is first imported.

Every hook adds an *event* to the current span, or opens an entry *span* (an inbound request or a
consumed message). Outbound HTTP and published messages carry a W3C ``traceparent`` so the receiving
service continues the same trace.
"""

from __future__ import annotations

import functools
import importlib.abc
import importlib.util
import json
import sys
from typing import Any, Callable

from ..scan.detectors.sql import analyze_sql
from .context import current, now, parse_traceparent
from .tracer import Tracer


def _body(raw: Any, snap: Callable[[Any], Any]) -> Any:
    if isinstance(raw, (bytes, bytearray)):
        try:
            return snap(json.loads(raw))
        except (ValueError, UnicodeDecodeError):
            return f"<{len(raw)} bytes>"
    return snap(raw)


def _safe(hook: Callable[..., Any]) -> Callable[..., Any]:
    """Run tracing side effects without ever breaking the app."""

    @functools.wraps(hook)
    def wrapper(*a: Any, **kw: Any) -> Any:
        try:
            return hook(*a, **kw)
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[flowlens] hook {hook.__name__} failed: {exc!r}", file=sys.stderr)
            return None

    return wrapper


# ------------------------------------------------------------------- SQL
def patch_sqlalchemy(t: Tracer, module: Any) -> None:
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    @event.listens_for(Engine, "before_cursor_execute")
    def before(conn, cursor, statement, parameters, context, executemany):
        conn.info.setdefault("_flowlens", []).append(now())

    @_safe
    def record(conn, statement, parameters, rowcount, error=None):
        stack = conn.info.get("_flowlens")
        start = stack.pop() if stack else now()
        if current.get() is None:
            return
        writes, reads = analyze_sql(statement)
        targets = [{"node": f"table:{t_}", "op": op} for t_, op in writes.items()]
        targets += [{"node": f"table:{t_}", "op": "select"} for t_ in sorted(reads) if t_ not in writes]
        op = next(iter(writes.values()), "select" if reads else "sql")
        detail = {"statement": statement[:3000], "params": t.snap(parameters), "rowcount": rowcount}
        t.event("db", op, targets, detail, start, error)

    @event.listens_for(Engine, "after_cursor_execute")
    def after(conn, cursor, statement, parameters, context, executemany):
        record(conn, statement, parameters, getattr(cursor, "rowcount", None))

    @event.listens_for(Engine, "handle_error")
    def failed(ctx):
        record(ctx.connection, ctx.statement or "", ctx.parameters, None, ctx.original_exception)


# --------------------------------------------------------------- HTTP out
def _http_event(t: Tracer, method: str, url: str, status: Any, start: float, error: BaseException | None = None):
    t.event("http", f"{method} {url}"[:300], [], {"method": method, "url": url[:1000], "status": status}, start, error)


def patch_httpx(t: Tracer, httpx: Any) -> None:
    def inject(request: Any) -> None:
        span = current.get()
        if span is not None:
            request.headers["traceparent"] = span.traceparent()

    orig_send = httpx.Client.send

    def send(self, request, *a, **kw):
        inject(request)
        start = now()
        try:
            resp = orig_send(self, request, *a, **kw)
        except Exception as exc:
            _safe(_http_event)(t, request.method, str(request.url), None, start, exc)
            raise
        _safe(_http_event)(t, request.method, str(request.url), resp.status_code, start)
        return resp

    orig_asend = httpx.AsyncClient.send

    async def asend(self, request, *a, **kw):
        inject(request)
        start = now()
        try:
            resp = await orig_asend(self, request, *a, **kw)
        except Exception as exc:
            _safe(_http_event)(t, request.method, str(request.url), None, start, exc)
            raise
        _safe(_http_event)(t, request.method, str(request.url), resp.status_code, start)
        return resp

    httpx.Client.send = send
    httpx.AsyncClient.send = asend


def patch_requests(t: Tracer, requests: Any) -> None:
    orig = requests.Session.send

    def send(self, request, **kw):
        span = current.get()
        if span is not None:
            request.headers["traceparent"] = span.traceparent()
        start = now()
        try:
            resp = orig(self, request, **kw)
        except Exception as exc:
            _safe(_http_event)(t, request.method, request.url, None, start, exc)
            raise
        _safe(_http_event)(t, request.method, request.url, resp.status_code, start)
        return resp

    requests.Session.send = send


# ---------------------------------------------------------------- HTTP in
def patch_starlette(t: Tracer, routing: Any) -> None:
    orig = routing.Route.handle

    async def handle(self, scope, receive, send):
        if scope.get("type") != "http":
            return await orig(self, scope, receive, send)
        headers = dict(scope.get("headers") or [])
        method = scope.get("method", "GET")
        status: dict[str, Any] = {}

        async def send_wrapper(message):
            if message.get("type") == "http.response.start":
                status["code"] = message.get("status")
            await send(message)

        query = scope.get("query_string", b"").decode("latin-1")
        span, token = t.start_span(
            f"route:{t.service}:{method} {self.path}", f"{method} {self.path}", "route",
            input=t.snap({"method": method, "path": scope.get("path"), "query": query or None,
                          "pathParams": scope.get("path_params") or None}),
            remote=parse_traceparent(headers.get(b"traceparent")),
        )
        try:
            await orig(self, scope, receive, send_wrapper)
        except BaseException as exc:
            t.end_span(span, token, {"status": status.get("code", 500)}, exc)
            raise
        t.end_span(span, token, {"status": status.get("code")})

    routing.Route.handle = handle


def patch_flask(t: Tracer, flask: Any) -> None:
    orig = flask.Flask.full_dispatch_request

    def full_dispatch_request(self):
        request = flask.request
        rule = request.url_rule.rule if request.url_rule is not None else request.path
        span, token = t.start_span(
            f"route:{t.service}:{request.method} {rule}", f"{request.method} {rule}", "route",
            input=t.snap({"method": request.method, "path": request.path, "query": request.query_string.decode() or None,
                          "pathParams": request.view_args or None}),
            remote=parse_traceparent(request.headers.get("traceparent")),
        )
        try:
            response = orig(self)
        except BaseException as exc:
            t.end_span(span, token, {"status": 500}, exc)
            raise
        t.end_span(span, token, {"status": getattr(response, "status_code", None)})
        return response

    flask.Flask.full_dispatch_request = full_dispatch_request


# -------------------------------------------------------------------- AMQP
def _publish_event(t: Tracer, key: str, body: Any, start: float, exchange: Any = None, error=None):
    t.event("publish", "publish", [{"node": f"topic:{key}", "op": "publish"}],
            {"routingKey": key, "exchange": str(exchange) if exchange else None, "body": _body(body, t.snap)}, start, error)


def patch_aio_pika(t: Tracer, aio_pika: Any) -> None:
    orig_publish = aio_pika.Exchange.publish

    async def publish(self, message, routing_key, *a, **kw):
        span = current.get()
        if span is not None:
            message.headers = {**(message.headers or {}), "traceparent": span.traceparent()}
        start = now()
        try:
            result = await orig_publish(self, message, routing_key, *a, **kw)
        except Exception as exc:
            _safe(_publish_event)(t, routing_key, message.body, start, getattr(self, "name", None), exc)
            raise
        _safe(_publish_event)(t, routing_key, message.body, start, getattr(self, "name", None))
        return result

    aio_pika.Exchange.publish = publish

    def open_consume(message: Any) -> tuple[Any, Any]:
        headers = getattr(message, "headers", None) or {}
        key = getattr(message, "routing_key", None) or "?"
        return t.start_span(
            f"topic:{key}", f"consume {key}", "consume",
            input=t.snap({"routingKey": key, "body": _body(message.body, t.snap)}),
            remote=parse_traceparent(headers.get("traceparent")), root=True,
        )

    # callback style: queue.consume(handler)
    orig_consume = aio_pika.Queue.consume

    async def consume(self, callback, *a, **kw):
        from aio_pika.queue import QueueIterator

        if isinstance(getattr(callback, "__self__", None), QueueIterator):
            # the iterator's own buffering callback; spans open in __anext__ instead
            return await orig_consume(self, callback, *a, **kw)

        async def traced(message):
            span, token = open_consume(message)
            try:
                result = await callback(message)
            except BaseException as exc:
                t.end_span(span, token, None, exc)
                raise
            t.end_span(span, token, None)
            return result

        return await orig_consume(self, traced, *a, **kw)

    aio_pika.Queue.consume = consume

    # iterator style: async for message in queue.iterator() — a message's span lasts until the next one
    from aio_pika.queue import QueueIterator

    orig_anext = QueueIterator.__anext__

    def close_current(it: Any) -> None:
        open_span = getattr(it, "_flowlens_span", None)
        if open_span is not None:
            it._flowlens_span = None
            t.end_span(*open_span)

    async def anext_(self):
        if getattr(self, "_flowlens_inner", False):  # aio_pika may re-enter __anext__ internally
            return await orig_anext(self)
        close_current(self)
        self._flowlens_inner = True
        try:
            message = await orig_anext(self)
        finally:
            self._flowlens_inner = False
        self._flowlens_span = open_consume(message)
        return message

    QueueIterator.__anext__ = anext_
    orig_close = QueueIterator.close

    async def close(self, *a, **kw):
        close_current(self)
        return await orig_close(self, *a, **kw)

    QueueIterator.close = close


def patch_pika(t: Tracer, pika: Any) -> None:
    from pika.adapters.blocking_connection import BlockingChannel

    orig_publish = BlockingChannel.basic_publish

    def basic_publish(self, exchange, routing_key, body, properties=None, *a, **kw):
        span = current.get()
        if span is not None:
            properties = properties or pika.BasicProperties()
            properties.headers = {**(properties.headers or {}), "traceparent": span.traceparent()}
        start = now()
        result = orig_publish(self, exchange, routing_key, body, properties, *a, **kw)
        _safe(_publish_event)(t, routing_key, body, start, exchange)
        return result

    orig_consume = BlockingChannel.basic_consume

    def basic_consume(self, queue, on_message_callback, *a, **kw):
        def traced(channel, method, properties, body):
            headers = getattr(properties, "headers", None) or {}
            key = getattr(method, "routing_key", "?")
            span, token = t.start_span(
                f"topic:{key}", f"consume {key}", "consume", input=t.snap({"routingKey": key, "body": _body(body, t.snap)}),
                remote=parse_traceparent(headers.get("traceparent")), root=True,
            )
            try:
                result = on_message_callback(channel, method, properties, body)
            except BaseException as exc:
                t.end_span(span, token, None, exc)
                raise
            t.end_span(span, token, None)
            return result

        return orig_consume(self, queue, traced, *a, **kw)

    BlockingChannel.basic_publish = basic_publish
    BlockingChannel.basic_consume = basic_consume


# ----------------------------------------------------------------- storage
_MINIO = {"put_object": "put", "fput_object": "put", "get_object": "get", "fget_object": "get", "remove_object": "delete",
          "stat_object": "stat", "copy_object": "copy", "presigned_get_object": "get"}
_S3 = {"PutObject": "put", "GetObject": "get", "DeleteObject": "delete", "CopyObject": "copy", "HeadObject": "stat",
       "UploadPart": "put", "CompleteMultipartUpload": "put"}
_WRITE_OPS = {"put", "delete", "copy"}


def _storage_event(t: Tracer, bucket: Any, key: Any, op: str, start: float, error=None):
    t.event("storage", op, [{"node": f"bucket:{bucket}", "op": op}], {"bucket": bucket, "key": t.snap(key)}, start, error)


def patch_minio(t: Tracer, minio: Any) -> None:
    for method, op in _MINIO.items():
        orig = getattr(minio.Minio, method, None)
        if orig is None:
            continue

        def make(orig=orig, op=op):
            def wrapper(self, bucket_name, object_name=None, *a, **kw):
                start = now()
                try:
                    result = orig(self, bucket_name, object_name, *a, **kw)
                except Exception as exc:
                    _safe(_storage_event)(t, bucket_name, object_name, op, start, exc)
                    raise
                _safe(_storage_event)(t, bucket_name, object_name, op, start)
                return result

            return wrapper

        setattr(minio.Minio, method, make())


def patch_botocore(t: Tracer, client_mod: Any) -> None:
    orig = client_mod.BaseClient._make_api_call

    def _make_api_call(self, operation_name, api_params):
        op = _S3.get(operation_name)
        if op is None:
            return orig(self, operation_name, api_params)
        start = now()
        try:
            result = orig(self, operation_name, api_params)
        except Exception as exc:
            _safe(_storage_event)(t, api_params.get("Bucket"), api_params.get("Key"), op, start, exc)
            raise
        _safe(_storage_event)(t, api_params.get("Bucket"), api_params.get("Key"), op, start)
        return result

    client_mod.BaseClient._make_api_call = _make_api_call


HOOKS: dict[str, Callable[[Tracer, Any], None]] = {
    "sqlalchemy": patch_sqlalchemy,
    "httpx": patch_httpx,
    "requests": patch_requests,
    "starlette.routing": patch_starlette,
    "flask": patch_flask,
    "aio_pika": patch_aio_pika,
    "pika": patch_pika,
    "minio": patch_minio,
    "botocore.client": patch_botocore,
}


class _PostImportFinder(importlib.abc.MetaPathFinder):
    """Applies a hook right after its module is imported for the first time."""

    def __init__(self, tracer: Tracer, pending: dict[str, Callable[[Tracer, Any], None]]):
        self.tracer = tracer
        self.pending = pending
        self._resolving: set[str] = set()

    def find_spec(self, fullname, path, target=None):
        if fullname not in self.pending or fullname in self._resolving:
            return None
        self._resolving.add(fullname)
        try:
            spec = importlib.util.find_spec(fullname)
        finally:
            self._resolving.discard(fullname)
        if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return None
        hook = self.pending.pop(fullname)
        loader = spec.loader
        tracer = self.tracer

        class Loader(importlib.abc.Loader):
            def create_module(self, spec):
                return loader.create_module(spec)

            def exec_module(self, module):
                loader.exec_module(module)
                apply(tracer, fullname, hook, module)

        spec.loader = Loader()
        return spec


def apply(tracer: Tracer, name: str, hook: Callable[[Tracer, Any], None], module: Any) -> None:
    try:
        hook(tracer, module)
    except Exception as exc:
        print(f"[flowlens] could not hook {name}: {exc!r}", file=sys.stderr)


def install_hooks(tracer: Tracer, disabled: set[str] | None = None) -> None:
    pending = {}
    for name, hook in HOOKS.items():
        if disabled and name.split(".")[0] in disabled:
            continue
        if name in sys.modules:
            apply(tracer, name, hook, sys.modules[name])
        else:
            pending[name] = hook
    if pending:
        sys.meta_path.insert(0, _PostImportFinder(tracer, pending))
