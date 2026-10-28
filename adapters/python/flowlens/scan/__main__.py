"""``python -m flowlens.scan`` — reads a scan request (JSON) on stdin, writes a partial graph (JSON) to stdout.

Request: {"service": str, "root": abs path, "repoRoot": abs path, "rootRel": str,
          "include": [glob], "exclude": [glob], "detectors": {name: {...options}}}
"""

from __future__ import annotations

import json
import sys

from .engine import scan


def main() -> int:
    raw = sys.stdin.read() if len(sys.argv) < 2 else open(sys.argv[1], encoding="utf-8").read()
    result = scan(json.loads(raw))
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
