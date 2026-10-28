"""Zero-code-change tracing: put this folder and adapters/python on PYTHONPATH, set FLOWLENS_TRACE=1.

Python imports ``sitecustomize`` automatically at startup, so every process (web server, worker, CLI)
starts tracing itself before the application is imported.
"""

import os
import sys

if os.environ.get("FLOWLENS_TRACE", "").lower() in ("1", "true", "yes", "on"):
    try:
        import flowlens.trace

        flowlens.trace.install()
    except Exception as exc:  # never stop the app from starting
        print(f"[flowlens] tracer not installed: {exc!r}", file=sys.stderr)
