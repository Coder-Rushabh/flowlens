"""Graph builder that collects the nodes and edges one service scan produces."""

from __future__ import annotations

from typing import Any

MAX_EVIDENCE = 25


class Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.http_calls: list[dict[str, Any]] = []
        self.warnings: list[str] = []

    def add_node(self, node_id: str, kind: str, name: str, **attrs: Any) -> dict[str, Any]:
        node = self.nodes.get(node_id)
        if node is None:
            node = {"id": node_id, "kind": kind, "name": name}
            self.nodes[node_id] = node
        for key, value in attrs.items():
            if value is not None and value != [] and key not in node:
                node[key] = value
        return node

    def add_edge(
        self,
        src: str,
        dst: str,
        kind: str,
        file: str | None = None,
        line: int | None = None,
        op: str | None = None,
    ) -> dict[str, Any] | None:
        if src == dst:
            return None
        key = (src, dst, kind)
        edge = self.edges.get(key)
        if edge is None:
            edge = {"from": src, "to": dst, "kind": kind, "origin": "static", "evidence": []}
            self.edges[key] = edge
        if file is not None and len(edge["evidence"]) < MAX_EVIDENCE:
            ev: dict[str, Any] = {"file": file, "line": line}
            if op:
                ev["op"] = op
            if ev not in edge["evidence"]:
                edge["evidence"].append(ev)
        if op:
            ops = edge.setdefault("ops", [])
            if op not in ops:
                ops.append(op)
        return edge

    def to_json(self) -> dict[str, Any]:
        return {
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges.values()),
            "httpCalls": self.http_calls,
            "warnings": self.warnings,
        }
