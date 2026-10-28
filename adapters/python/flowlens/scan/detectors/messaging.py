"""Message brokers: AMQP (pika / aio-pika / kombu), Kafka, Redis pub/sub, Celery and Dramatiq tasks."""

from __future__ import annotations

import ast
import re

from ..astutil import attr_chain, const_str, kwarg, last_name, receiver_name
from ..context import Detector, ScanContext
from ..project import FunctionInfo, ModuleInfo, Scope

PUBLISH_NAME = re.compile(r"(^|_)(publish|emit|produce|send_event|send_message|enqueue)", re.I)
KEY_KWARGS = ("routing_key", "topic", "event_type", "event", "subject", "channel", "queue", "key")
TASK_DECORATORS = {"task", "shared_task", "actor", "periodic_task"}
KEY_SHAPE = re.compile(r"^[\w.:*#/-]{2,120}$")


class MessagingDetector(Detector):
    name = "messaging"

    def __init__(self) -> None:
        self.tasks: dict[str, str] = {}  # function qualname -> task name
        self.bindings: dict[str, list[tuple[str, FunctionInfo, int]]] = {}  # module -> (key, binder fn, line)
        self.handlers: dict[str, list[FunctionInfo]] = {}  # module -> consumer callbacks

    def index(self, ctx: ScanContext, mod: ModuleInfo) -> None:
        for fn in mod.functions:
            for dec in fn.node.decorator_list:
                call = dec if isinstance(dec, ast.Call) else None
                name = last_name(call.func if call else dec)
                if name not in TASK_DECORATORS:
                    continue
                task_name = (const_str(kwarg(call, "name", "actor_name")) if call else None) or fn.qualname
                self.tasks[fn.qualname] = task_name
                topic = ctx.topic(f"task:{task_name}", "task-queue")
                ctx.graph.add_edge(topic, fn.id, "consumes", fn.path, fn.node.lineno)

    def _keys(self, scope: Scope, expr: ast.AST | None) -> list[str]:
        out = []
        for value in scope.values_of(expr):
            if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
                out.extend(s for e in value.elts if (s := const_str(e)) is not None)
            elif (s := const_str(value)) is not None:
                out.append(s)
        return [k for k in out if KEY_SHAPE.match(k)]

    def analyze(self, ctx: ScanContext, scope: Scope) -> None:
        fn = scope.fn
        mod = fn.module.name
        for call in scope.calls:
            name = last_name(call.func)
            if not name:
                continue
            line = call.lineno
            if name in ("delay", "apply_async", "send") and isinstance(call.func, ast.Attribute):
                target = self._function(scope, call.func.value)
                if target is not None and target.qualname in self.tasks:
                    topic = ctx.topic(f"task:{self.tasks[target.qualname]}", "task-queue")
                    ctx.graph.add_edge(fn.id, topic, "publishes", fn.path, line, "enqueue")
                    continue
            if name in ("bind", "queue_bind"):
                for key in self._keys(scope, kwarg(call, "routing_key", "binding_key")):
                    self.bindings.setdefault(mod, []).append((key, fn, line))
            elif name in ("subscribe", "psubscribe"):
                exprs = list(call.args) + [kw.value for kw in call.keywords if kw.arg in ("topics", "channels")]
                for expr in exprs:
                    for key in self._keys(scope, expr):
                        self.bindings.setdefault(mod, []).append((key, fn, line))
            elif name in ("consume", "basic_consume"):
                cb = kwarg(call, "on_message_callback", "callback")
                if cb is None and call.args:
                    cb = call.args[1] if name == "basic_consume" and len(call.args) > 1 else call.args[0]
                handler = self._function(scope, cb)
                self.handlers.setdefault(mod, []).append(handler or fn)
            elif name == "iterator" and receiver_name(call.func) and "queue" in (receiver_name(call.func) or "").lower():
                self.handlers.setdefault(mod, []).append(fn)
            elif name == "KafkaConsumer" or name == "AIOKafkaConsumer":
                for arg in call.args:
                    for key in self._keys(scope, arg):
                        self.bindings.setdefault(mod, []).append((key, fn, line))
                self.handlers.setdefault(mod, []).append(fn)
            elif name == "send_task" and call.args:
                for key in self._keys(scope, call.args[0]):
                    ctx.graph.add_edge(fn.id, ctx.topic(f"task:{key}", "task-queue"), "publishes", fn.path, line, "enqueue")
            elif PUBLISH_NAME.search(name) or (name in ("send", "send_and_wait") and "producer" in (receiver_name(call.func) or "").lower()):
                key_expr = kwarg(call, *KEY_KWARGS)
                keys = self._keys(scope, key_expr) if key_expr is not None else []
                if not keys and call.args:
                    keys = self._keys(scope, call.args[0])
                for key in keys:
                    if " " in key:
                        continue
                    ctx.graph.add_edge(fn.id, ctx.topic(key, "broker"), "publishes", fn.path, line, "publish")

    @staticmethod
    def _function(scope: Scope, expr: ast.AST | None) -> FunctionInfo | None:
        if expr is None:
            return None
        chain = attr_chain(expr)
        if chain and chain[0] in ("self", "cls") and len(chain) == 2 and scope.fn.cls is not None:
            return scope.project.find_method(scope.fn.cls, chain[1])
        target = scope.resolve(expr)
        return target if isinstance(target, FunctionInfo) else None

    def finish(self, ctx: ScanContext) -> None:
        for mod, bindings in self.bindings.items():
            handlers = self.handlers.get(mod) or []
            for key, binder, line in bindings:
                topic = ctx.topic(key, "broker")
                for handler in handlers or [binder]:
                    ctx.graph.add_edge(topic, handler.id, "consumes", binder.path, line, "subscribe")
