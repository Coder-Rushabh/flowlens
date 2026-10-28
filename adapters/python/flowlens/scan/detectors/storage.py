"""Object storage: S3 / boto3, MinIO, Google Cloud Storage, Azure Blob."""

from __future__ import annotations

import ast

from ..astutil import attr_chain, const_str, env_lookup, kwarg, last_name
from ..context import Detector, ScanContext
from ..project import Scope

WRITE_OPS = {"put_object": "put", "fput_object": "put", "upload_file": "put", "upload_fileobj": "put",
             "upload_blob": "put", "upload_from_filename": "put", "upload_from_string": "put",
             "copy_object": "copy", "remove_object": "delete", "delete_object": "delete", "remove_objects": "delete"}
READ_OPS = {"get_object": "get", "fget_object": "get", "download_file": "get", "download_fileobj": "get",
            "download_blob": "get", "download_as_bytes": "get", "presigned_get_object": "get",
            "generate_presigned_url": "get", "stat_object": "stat", "list_objects": "list", "list_objects_v2": "list"}


class StorageDetector(Detector):
    name = "storage"

    def _buckets(self, scope: Scope, call: ast.Call) -> list[str]:
        expr = kwarg(call, "Bucket", "bucket", "bucket_name", "container")
        if expr is None and call.args:
            expr = call.args[0]
        names = []
        for value in scope.values_of(expr) if expr is not None else []:
            s = const_str(value)
            if s:
                names.append(s)
                continue
            env = env_lookup(value)
            if env and (env[1] or env[0]):
                names.append(env[1] or env[0])
                continue
            chain = attr_chain(value)
            if chain and len(chain) > 1:
                names.append(chain[-1])
        return names or ["object-storage"]

    def analyze(self, ctx: ScanContext, scope: Scope) -> None:
        fn = scope.fn
        for call in scope.calls:
            name = last_name(call.func)
            if not isinstance(call.func, ast.Attribute) or name not in WRITE_OPS and name not in READ_OPS:
                continue
            for bucket in self._buckets(scope, call):
                node = ctx.bucket(bucket)
                if name in WRITE_OPS:
                    ctx.graph.add_edge(fn.id, node, "writes", fn.path, call.lineno, WRITE_OPS[name])
                else:
                    ctx.graph.add_edge(node, fn.id, "reads", fn.path, call.lineno, READ_OPS[name])
