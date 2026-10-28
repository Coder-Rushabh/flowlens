"""ORM data access: SQLAlchemy / SQLModel models and sessions, Django models and managers."""

from __future__ import annotations

import ast

from ..astutil import attr_chain, const_str, kwarg, last_name
from ..context import Detector, ScanContext
from ..project import ClassInfo, ModuleInfo, Scope

SA_READ = {"select", "query", "get", "get_one", "join", "outerjoin", "select_from", "exists", "with_entities"}
SA_WRITE = {"insert": "insert", "update": "update", "delete": "delete", "bulk_insert_mappings": "insert",
            "bulk_update_mappings": "update"}
SESSION_PERSIST = {"add": "insert", "add_all": "insert", "merge": "upsert", "bulk_save_objects": "upsert"}
DJANGO_READ = {"filter", "get", "all", "exclude", "values", "values_list", "first", "last", "count", "exists",
               "aggregate", "annotate", "select_related", "prefetch_related", "order_by", "in_bulk", "iterator",
               "only", "defer", "distinct", "raw"}
DJANGO_WRITE = {"create": "insert", "bulk_create": "insert", "get_or_create": "upsert", "update_or_create": "upsert",
                "update": "update", "bulk_update": "update", "delete": "delete"}


class OrmDetector(Detector):
    name = "orm"

    def __init__(self) -> None:
        self.models: dict[str, str] = {}  # class qualname -> table
        self.django: set[str] = set()  # class qualnames that are Django models
        self.table_vars: dict[str, str] = {}  # module var qualname -> table

    # ------------------------------------------------------------------ index
    def index(self, ctx: ScanContext, mod: ModuleInfo) -> None:
        for cls in mod.classes:
            table = self._sqlalchemy_table(cls) or self._django_table(ctx, cls, mod)
            if table:
                self.models[cls.qualname] = table.lower()
        for name, value in mod.assigns.items():
            if isinstance(value, ast.Call) and last_name(value.func) == "Table" and value.args:
                table = const_str(value.args[0])
                if table:
                    schema = const_str(kwarg(value, "schema"))
                    self.table_vars[f"{mod.name}.{name}"] = (f"{schema}.{table}" if schema else table).lower()

    @staticmethod
    def _sqlalchemy_table(cls: ClassInfo) -> str | None:
        table = schema = None
        for stmt in cls.node.body:
            if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
                continue
            target = stmt.targets[0].id
            if target == "__tablename__":
                table = const_str(stmt.value)
            elif target == "__table_args__":
                args = stmt.value
                if isinstance(args, ast.Tuple) and args.elts:
                    args = args.elts[-1]
                if isinstance(args, ast.Dict):
                    for k, v in zip(args.keys, args.values):
                        if const_str(k) == "schema":
                            schema = const_str(v)
        if table is None:
            # SQLModel: class Hero(SQLModel, table=True) -> "hero"
            for kw in cls.node.keywords:
                if kw.arg == "table" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                    table = cls.name.lower()
        if table is None:
            return None
        return f"{schema}.{table}" if schema else table

    def _django_table(self, ctx: ScanContext, cls: ClassInfo, mod: ModuleInfo) -> str | None:
        is_model = any((attr_chain(b) or [""])[-1] == "Model" and "django" in str(mod.imports.get((attr_chain(b) or [""])[0], ""))
                       for b in cls.node.bases)
        if not is_model:
            return None
        self.django.add(cls.qualname)
        for stmt in cls.node.body:
            if isinstance(stmt, ast.ClassDef) and stmt.name == "Meta":
                for sub in stmt.body:
                    if isinstance(sub, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "db_table" for t in sub.targets):
                        if (value := const_str(sub.value)):
                            return value
        parts = mod.name.split(".")
        app = parts[-2] if parts[-1] == "models" and len(parts) > 1 else parts[-1]
        return f"{app}_{cls.name.lower()}"

    # ---------------------------------------------------------------- analyze
    def _tables_in(self, scope: Scope, expr: ast.AST | None) -> set[str]:
        out: set[str] = set()
        if expr is None:
            return out
        for node in ast.walk(expr):
            if not isinstance(node, (ast.Name, ast.Attribute)):
                continue
            qual = scope.qualify(node)
            if not qual:
                continue
            target = scope.project.resolve(qual)
            if isinstance(target, ClassInfo) and target.qualname in self.models:
                out.add(self.models[target.qualname])
                continue
            canon = scope.project.canonical(qual)
            if canon in self.table_vars:
                out.add(self.table_vars[canon])
        return out

    def _var_tables(self, scope: Scope, name: str, depth: int = 0) -> tuple[set[str], bool]:
        """Tables a local variable holds rows of, and whether it was constructed (new row) here."""
        if depth > 3:
            return set(), False
        cls = scope.class_of(name)
        if cls is not None and cls.qualname in self.models:
            constructed = any(isinstance(v, ast.Call) and scope.resolve(v.func) is cls for v in scope.assigns.get(name, []))
            return {self.models[cls.qualname]}, constructed
        tables: set[str] = set()
        for value in scope.assigns.get(name, []):
            for node in ast.walk(value):
                if isinstance(node, ast.Call) and last_name(node.func) in SA_READ | DJANGO_READ:
                    tables |= self._tables_in(scope, node)
        if not tables and name in scope.for_iters:
            it = scope.for_iters[name]
            if isinstance(it, ast.Name):
                tables, _ = self._var_tables(scope, it.id, depth + 1)
            else:
                tables = self._tables_in(scope, it)
        return tables, False

    def analyze(self, ctx: ScanContext, scope: Scope) -> None:
        fn = scope.fn
        graph = ctx.graph

        def write(table: str, op: str, line: int) -> None:
            graph.add_edge(fn.id, ctx.table(table), "writes", fn.path, line, op)

        def read(table: str, line: int) -> None:
            graph.add_edge(ctx.table(table), fn.id, "reads", fn.path, line, "select")

        for call in scope.calls:
            name = last_name(call.func)
            if name is None:
                continue
            line = call.lineno
            # Django manager: Model.objects.<op>(...)
            chain = attr_chain(call.func)
            if chain and len(chain) >= 3 and chain[-2] == "objects":
                target = scope.resolve(ast.Name(id=chain[0], ctx=ast.Load())) if len(chain) == 3 else None
                if isinstance(target, ClassInfo) and target.qualname in self.models:
                    table = self.models[target.qualname]
                    if name in DJANGO_WRITE:
                        write(table, DJANGO_WRITE[name], line)
                    elif name in DJANGO_READ:
                        read(table, line)
                    continue
            if name in SESSION_PERSIST and call.args:
                for arg in call.args[:1]:
                    items = arg.elts if isinstance(arg, (ast.List, ast.Tuple)) else [arg]
                    for item in items:
                        if isinstance(item, ast.Call):
                            for t in self._tables_in(scope, item.func):
                                write(t, SESSION_PERSIST[name], line)
                        elif isinstance(item, ast.Name):
                            tables, constructed = self._var_tables(scope, item.id)
                            for t in tables:
                                write(t, "insert" if constructed else SESSION_PERSIST[name], line)
                continue
            if name in ("save", "delete") and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name):
                # obj.save() / obj.delete() on a model instance (Django / active-record style)
                tables, constructed = self._var_tables(scope, call.func.value.id)
                if tables:
                    for t in tables:
                        write(t, "delete" if name == "delete" else ("insert" if constructed else "update"), line)
                    continue
            if name == "delete" and call.args and isinstance(call.args[0], ast.Name):
                tables, _ = self._var_tables(scope, call.args[0].id)
                for t in tables:
                    write(t, "delete", line)
                if tables:
                    continue
            if name in SA_WRITE:
                # insert(Model) / update(Model) / delete(Model) and Model.__table__.insert()
                target = call.args[0] if call.args else (call.func.value if isinstance(call.func, ast.Attribute) else None)
                for t in self._tables_in(scope, target):
                    write(t, SA_WRITE[name], line)
                continue
            if name in SA_READ:
                for arg in call.args:
                    for t in self._tables_in(scope, arg):
                        read(t, line)

        stored: set[tuple[str, int]] = set()
        for var, _attr, line in scope.attr_stores:
            if var in ("self", "cls"):
                continue
            tables, constructed = self._var_tables(scope, var)
            if constructed:
                continue  # covered by the add()/save() that persists it
            for t in tables:
                if (t, line) not in stored:
                    stored.add((t, line))
                    write(t, "update", line)
