"""Index a Python service: modules, imports, functions, classes, and name resolution."""

from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass, field
from typing import Union

from .astutil import attr_chain, docstring_node, iter_toplevel, walk_body

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "env", ".tox", ".nox",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", "dist", "build", ".eggs",
}


_TEST_FILE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test)\.py$")
_TEST_DEF = re.compile(r"^\s*(async\s+)?def test_|^\s*class Test\w*[(:]|^import pytest|^from pytest", re.M)


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Glob with ``**`` (any depth), ``*`` (one segment) and ``?``, matched against posix paths."""
    p = pattern.replace("\\", "/")
    out, i = [], 0
    while i < len(p):
        if p.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif p.startswith("**", i):
            out.append(".*")
            i += 2
        elif p[i] == "*":
            out.append("[^/]*")
            i += 1
        elif p[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(p[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


@dataclass(eq=False)
class ClassInfo:
    qualname: str
    name: str
    module: "ModuleInfo"
    node: ast.ClassDef
    methods: dict[str, "FunctionInfo"] = field(default_factory=dict)


@dataclass(eq=False)
class FunctionInfo:
    id: str
    qualname: str
    name: str
    module: "ModuleInfo"
    node: Union[ast.FunctionDef, ast.AsyncFunctionDef]
    cls: ClassInfo | None = None
    local_imports: dict[str, str] = field(default_factory=dict)

    @property
    def path(self) -> str:
        return self.module.path

    @property
    def display(self) -> str:
        return f"{self.cls.name}.{self.name}" if self.cls else self.name


@dataclass(eq=False)
class ModuleInfo:
    name: str
    path: str  # relative to the repository root, posix
    tree: ast.Module
    is_package: bool
    imports: dict[str, str] = field(default_factory=dict)
    all_imports: dict[str, str] = field(default_factory=dict)
    star_imports: list[str] = field(default_factory=list)
    defs: dict[str, Union[FunctionInfo, ClassInfo]] = field(default_factory=dict)
    assigns: dict[str, ast.expr] = field(default_factory=dict)
    functions: list[FunctionInfo] = field(default_factory=list)
    classes: list[ClassInfo] = field(default_factory=list)


Symbol = Union[ModuleInfo, FunctionInfo, ClassInfo]


class Project:
    def __init__(self, service: str, root: str, repo_root: str, include: list[str], exclude: list[str]):
        self.service = service
        self.root = os.path.abspath(root)
        self.repo_root = os.path.abspath(repo_root)
        self.include = [glob_to_regex(g) for g in (include or ["**/*.py"])]
        self.exclude = [glob_to_regex(g) for g in exclude or []]
        self.modules: dict[str, ModuleInfo] = {}
        self.functions: list[FunctionInfo] = []
        self.warnings: list[str] = []
        self._suffix: dict[str, list[ModuleInfo]] = {}

    # ---------------------------------------------------------------- loading
    def load(self) -> None:
        for abs_path, rel in self._files():
            try:
                with open(abs_path, encoding="utf-8-sig", errors="replace") as fh:
                    source = fh.read()
                tree = ast.parse(source, filename=abs_path)
            except (SyntaxError, ValueError) as exc:
                self.warnings.append(f"{rel}: skipped, cannot parse ({exc.__class__.__name__}: {exc})")
                continue
            if _TEST_FILE.search(rel) and _TEST_DEF.search(source):
                continue  # a pytest/unittest module
            parts = rel[:-3].split("/")
            is_package = parts[-1] == "__init__"
            if is_package:
                parts = parts[:-1]
            name = ".".join(parts) or os.path.basename(self.root)
            repo_rel = os.path.relpath(abs_path, self.repo_root).replace("\\", "/")
            self.modules[name] = ModuleInfo(name=name, path=repo_rel, tree=tree, is_package=is_package)
        for mod in self.modules.values():
            parts = mod.name.split(".")
            for i in range(1, max(len(parts) - 1, 1)):
                self._suffix.setdefault(".".join(parts[i:]), []).append(mod)
        for mod in self.modules.values():
            self._index_module(mod)

    def _files(self):
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
            for fname in sorted(filenames):
                if not fname.endswith(".py"):
                    continue
                abs_path = os.path.join(dirpath, fname)
                rel = os.path.relpath(abs_path, self.root).replace("\\", "/")
                if not any(r.match(rel) for r in self.include):
                    continue
                if any(r.match(rel) for r in self.exclude):
                    continue
                yield abs_path, rel

    def _index_module(self, mod: ModuleInfo) -> None:
        for stmt in iter_toplevel(mod.tree.body):
            if isinstance(stmt, (ast.Import, ast.ImportFrom)):
                self._add_imports(mod, stmt, mod.imports)
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                fn = self._make_function(mod, stmt, None)
                mod.defs[stmt.name] = fn
            elif isinstance(stmt, ast.ClassDef):
                cls = ClassInfo(qualname=f"{mod.name}.{stmt.name}", name=stmt.name, module=mod, node=stmt)
                mod.defs[stmt.name] = cls
                mod.classes.append(cls)
                for sub in iter_toplevel(stmt.body):
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        cls.methods[sub.name] = self._make_function(mod, sub, cls)
            elif isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    if isinstance(target, ast.Name):
                        mod.assigns[target.id] = stmt.value
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                mod.assigns[stmt.target.id] = stmt.value
        for node in ast.walk(mod.tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self._add_imports(mod, node, mod.all_imports)
        mod.all_imports.update(mod.imports)

    def _make_function(self, mod: ModuleInfo, node, cls: ClassInfo | None) -> FunctionInfo:
        qual = f"{cls.qualname}.{node.name}" if cls else f"{mod.name}.{node.name}"
        fn = FunctionInfo(id=f"fn:{self.service}:{qual}", qualname=qual, name=node.name, module=mod, node=node, cls=cls)
        for sub in walk_body(node):
            if isinstance(sub, (ast.Import, ast.ImportFrom)):
                self._add_imports(mod, sub, fn.local_imports)
        mod.functions.append(fn)
        self.functions.append(fn)
        return fn

    def _add_imports(self, mod: ModuleInfo, stmt, into: dict[str, str]) -> None:
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                if alias.asname:
                    into[alias.asname] = alias.name
                else:
                    top = alias.name.split(".")[0]
                    into.setdefault(top, top)
            return
        source = self._relative(mod, stmt.level, stmt.module) if stmt.level else (stmt.module or "")
        for alias in stmt.names:
            if alias.name == "*":
                if source not in mod.star_imports:
                    mod.star_imports.append(source)
                continue
            into[alias.asname or alias.name] = f"{source}.{alias.name}" if source else alias.name

    @staticmethod
    def _relative(mod: ModuleInfo, level: int, module: str | None) -> str:
        parts = mod.name.split(".")
        if not mod.is_package:
            parts = parts[:-1]
        if level > 1:
            parts = parts[: max(len(parts) - (level - 1), 0)]
        base = ".".join(parts)
        if module:
            return f"{base}.{module}" if base else module
        return base

    # ------------------------------------------------------------- resolution
    def find_module(self, name: str) -> ModuleInfo | None:
        mod = self.modules.get(name)
        if mod is not None:
            return mod
        candidates = self._suffix.get(name)
        if candidates and len(candidates) == 1:
            return candidates[0]
        return None

    def resolve(self, qual: str | None, depth: int = 0) -> Symbol | None:
        """Resolve a dotted name to the module, function or class it refers to (following re-exports)."""
        if not qual or depth > 10:
            return None
        mod = self.find_module(qual)
        if mod is not None:
            return mod
        head, _, attr = qual.rpartition(".")
        if not head:
            return None
        parent = self.resolve(head, depth + 1)
        if isinstance(parent, ModuleInfo):
            if attr in parent.defs:
                return parent.defs[attr]
            if attr in parent.imports:
                return self.resolve(parent.imports[attr], depth + 1)
            for star in parent.star_imports:
                found = self.resolve(f"{star}.{attr}", depth + 1)
                if found is not None:
                    return found
            return None
        if isinstance(parent, ClassInfo):
            return self.find_method(parent, attr)
        return None

    def canonical(self, qual: str, depth: int = 0) -> str:
        """Canonical dotted name for any symbol, including plain variables (routers, tables, constants)."""
        head, _, attr = qual.rpartition(".")
        if not head or depth > 10:
            return qual
        mod = self.find_module(head)
        if mod is None:
            canon_head = self.canonical(head, depth + 1)
            if canon_head != head:
                return self.canonical(f"{canon_head}.{attr}", depth + 1)
            return qual
        if attr in mod.imports and attr not in mod.defs and attr not in mod.assigns:
            return self.canonical(mod.imports[attr], depth + 1)
        return f"{mod.name}.{attr}"

    def module_value(self, qual: str) -> ast.expr | None:
        """The value expression of a module-level variable, e.g. a constant list of routing keys."""
        canon = self.canonical(qual)
        head, _, attr = canon.rpartition(".")
        mod = self.find_module(head) if head else None
        return mod.assigns.get(attr) if mod else None

    def qualify_in(self, expr: ast.AST | None, mod: ModuleInfo, imports: dict[str, str]) -> str | None:
        parts = attr_chain(expr)
        if not parts:
            return None
        first = parts[0]
        if first in imports:
            base = imports[first]
        elif first in mod.defs or first in mod.assigns:
            base = f"{mod.name}.{first}"
        else:
            return None
        return ".".join([base, *parts[1:]])

    def bases(self, cls: ClassInfo) -> list[ClassInfo]:
        out = []
        for base in cls.node.bases:
            target = self.resolve(self.qualify_in(base, cls.module, cls.module.imports))
            if isinstance(target, ClassInfo) and target is not cls:
                out.append(target)
        return out

    def find_method(self, cls: ClassInfo, name: str, depth: int = 0) -> FunctionInfo | None:
        if name in cls.methods:
            return cls.methods[name]
        if depth > 8:
            return None
        for base in self.bases(cls):
            found = self.find_method(base, name, depth + 1)
            if found is not None:
                return found
        return None


class Scope:
    """Everything a detector needs to know about one function body."""

    def __init__(self, project: Project, fn: FunctionInfo):
        self.project = project
        self.fn = fn
        self.mod = fn.module
        self.imports = {**fn.module.imports, **fn.local_imports}
        self.params: set[str] = set()
        self.annotations: dict[str, ast.expr] = {}
        self.assigns: dict[str, list[ast.expr]] = {}
        self.for_iters: dict[str, ast.expr] = {}
        self.calls: list[ast.Call] = []
        self.attr_stores: list[tuple[str, str, int]] = []
        self.strings: list[tuple[str, int]] = []
        self.names_loaded: dict[str, int] = {}
        self._build()

    def _build(self) -> None:
        args = self.fn.node.args
        for a in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]:
            if a is None:
                continue
            self.params.add(a.arg)
            if a.annotation is not None:
                self.annotations[a.arg] = a.annotation
        skip: set[int] = set()
        doc = docstring_node(self.fn.node.body)
        if doc is not None:
            skip.add(id(doc))
        for node in walk_body(self.fn.node):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    self._assign_target(target, node.value, node.lineno)
            elif isinstance(node, ast.AnnAssign):
                if isinstance(node.target, ast.Name):
                    self.annotations[node.target.id] = node.annotation
                if node.value is not None:
                    self._assign_target(node.target, node.value, node.lineno)
            elif isinstance(node, ast.AugAssign):
                if isinstance(node.target, ast.Attribute) and isinstance(node.target.value, ast.Name):
                    self.attr_stores.append((node.target.value.id, node.target.attr, node.lineno))
            elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
                self.assigns.setdefault(node.target.id, []).append(node.value)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if isinstance(item.optional_vars, ast.Name):
                        self.assigns.setdefault(item.optional_vars.id, []).append(item.context_expr)
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                if isinstance(node.target, ast.Name):
                    self.for_iters[node.target.id] = node.iter
            elif isinstance(node, ast.Call):
                self.calls.append(node)
            elif isinstance(node, ast.Expr) and isinstance(node.value, (ast.Constant, ast.JoinedStr)):
                skip.add(id(node.value))  # bare string statements are comments, not data
            elif isinstance(node, ast.JoinedStr):
                for v in node.values:
                    skip.add(id(v))
                if id(node) not in skip:
                    text = "".join(str(v.value) if isinstance(v, ast.Constant) else "__fl__" for v in node.values)
                    self.strings.append((text, node.lineno))
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
                self.strings.append((node.value, node.lineno))
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                self.names_loaded.setdefault(node.id, node.lineno)

    def _assign_target(self, target: ast.expr, value: ast.expr, line: int) -> None:
        if isinstance(target, ast.Name):
            self.assigns.setdefault(target.id, []).append(value)
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            self.attr_stores.append((target.value.id, target.attr, line))

    # -------------------------------------------------------------- resolving
    def is_local(self, name: str) -> bool:
        return name in self.assigns or name in self.params or name in self.for_iters

    def qualify(self, expr: ast.AST | None) -> str | None:
        parts = attr_chain(expr)
        if not parts or self.is_local(parts[0]):
            return None
        return self.project.qualify_in(expr, self.mod, self.imports)

    def resolve(self, expr: ast.AST | None) -> Symbol | None:
        return self.project.resolve(self.qualify(expr))

    def resolve_callee(self, call: ast.Call) -> FunctionInfo | None:
        func = call.func
        project = self.project
        if isinstance(func, ast.Attribute):
            base = func.value
            if isinstance(base, ast.Name) and base.id in ("self", "cls") and self.fn.cls is not None:
                return project.find_method(self.fn.cls, func.attr)
            if (
                isinstance(base, ast.Call)
                and isinstance(base.func, ast.Name)
                and base.func.id == "super"
                and self.fn.cls is not None
            ):
                for parent in project.bases(self.fn.cls):
                    found = project.find_method(parent, func.attr)
                    if found is not None:
                        return found
                return None
            if isinstance(base, ast.Name) and self.is_local(base.id):
                cls = self.class_of(base.id)
                return project.find_method(cls, func.attr) if cls else None
            if isinstance(base, (ast.Call, ast.Await)):
                cls = self.class_from_value(base)
                if cls is not None:
                    return project.find_method(cls, func.attr)
        target = self.resolve(func)
        if isinstance(target, ClassInfo):
            return project.find_method(target, "__init__")
        if isinstance(target, FunctionInfo):
            return target
        return None

    def class_of(self, name: str) -> ClassInfo | None:
        if name in self.annotations:
            cls = self.class_from_annotation(self.annotations[name], self.mod, self.imports)
            if cls is not None:
                return cls
        for value in self.assigns.get(name, []):
            cls = self.class_from_value(value)
            if cls is not None:
                return cls
        return None

    def class_from_value(self, value: ast.AST) -> ClassInfo | None:
        if isinstance(value, ast.Await):
            value = value.value
        if not isinstance(value, ast.Call):
            return None
        target = self.resolve(value.func)
        if isinstance(target, ClassInfo):
            return target
        if isinstance(target, FunctionInfo) and target.node.returns is not None:
            return self.class_from_annotation(target.node.returns, target.module, target.module.imports)
        return None

    def class_from_annotation(self, ann: ast.AST, mod: ModuleInfo, imports: dict[str, str], depth: int = 0) -> ClassInfo | None:
        if depth > 4 or ann is None:
            return None
        if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
            try:
                ann = ast.parse(ann.value, mode="eval").body
            except SyntaxError:
                return None
        if isinstance(ann, ast.BinOp):
            return self.class_from_annotation(ann.left, mod, imports, depth + 1) or self.class_from_annotation(
                ann.right, mod, imports, depth + 1
            )
        if isinstance(ann, ast.Subscript):
            inner = ann.slice
            elts = inner.elts if isinstance(inner, ast.Tuple) else [inner]
            for e in elts:
                found = self.class_from_annotation(e, mod, imports, depth + 1)
                if found is not None:
                    return found
            return None
        target = self.project.resolve(self.project.qualify_in(ann, mod, imports))
        return target if isinstance(target, ClassInfo) else None

    def values_of(self, expr: ast.AST | None, depth: int = 0) -> list[ast.expr]:
        """Possible concrete values for an expression: follows local assignments, loop vars and module constants."""
        if expr is None or depth > 4:
            return []
        if isinstance(expr, ast.Name):
            if expr.id in self.for_iters:
                it = self.values_of(self.for_iters[expr.id], depth + 1)
                out: list[ast.expr] = []
                for v in it:
                    if isinstance(v, (ast.List, ast.Tuple, ast.Set)):
                        out.extend(v.elts)
                return out
            if expr.id in self.assigns:
                out = []
                for v in self.assigns[expr.id]:
                    out.extend(self.values_of(v, depth + 1) or [v])
                return out
            if expr.id in self.params:
                return []
        if isinstance(expr, (ast.Name, ast.Attribute)):
            qual = self.qualify(expr)
            if qual:
                value = self.project.module_value(qual)
                if value is not None:
                    return [value]
        return [expr]
