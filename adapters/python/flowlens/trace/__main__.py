"""``python -m flowlens.trace [options] (-m module | script.py) [args...]``

Examples:
  python -m flowlens.trace --service orders -m uvicorn app.main:app --port 8000
  python -m flowlens.trace --service inventory -m inventory.worker
"""

from __future__ import annotations

import os
import runpy
import sys

USAGE = __doc__


def main() -> None:
    argv = sys.argv[1:]
    options: dict[str, str] = {}
    while argv and argv[0].startswith("--"):
        flag = argv.pop(0)[2:]
        if "=" in flag:
            key, value = flag.split("=", 1)
        else:
            key, value = flag, argv.pop(0) if argv else ""
        options[key.replace("-", "_")] = value
    if not argv:
        print(USAGE, file=sys.stderr)
        sys.exit(2)

    from . import install

    install(**options)
    if argv[0] == "-m":
        if len(argv) < 2:
            print(USAGE, file=sys.stderr)
            sys.exit(2)
        sys.argv = argv[1:]
        sys.path.insert(0, os.getcwd())
        runpy.run_module(argv[1], run_name="__main__", alter_sys=True)
    else:
        sys.argv = argv
        sys.path.insert(0, os.path.dirname(os.path.abspath(argv[0])))
        runpy.run_path(argv[0], run_name="__main__")


if __name__ == "__main__":
    main()
