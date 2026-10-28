# flowlens.yaml

Optional. Without it, FlowLens auto-detects services: each top-level folder (or one level deeper) that has a `pyproject.toml`, `setup.py`, `requirements*.txt` or `Pipfile` (Python) or a `package.json` (TypeScript). Run `flowlens init` to write the detected list, then edit it.

```yaml
version: 1
project: "shop"

services:
  - name: "orders"            # shown in the UI; must be unique
    root: "services/orders"   # relative to this file
    language: python          # python | typescript (phase 4)
    include: ["app/**/*.py"]  # optional, globs relative to root (default **/*.py)
    exclude: ["app/legacy/**"]
  - name: "tools"
    root: "tools"
    language: python
    enabled: false            # keep it listed but don't scan it

exclude: ["**/generated/**"]  # extra excludes for every service

detectors:                    # routes, orm, sql, messaging, storage, http
  sql: { enabled: false }

redact: ["password", "token", "secret", "authorization"]   # used by runtime tracing (phase 2)

python:
  executable: "py"            # default: auto-detect python / py / python3, or FLOWLENS_PYTHON

ui:
  port: 4870
```

The scanner always excludes tests (`**/tests/**`, `test_*.py`, `*_test.py`, `conftest.py`), migrations (`**/alembic/versions/**`, `**/migrations/**`), virtualenvs, `node_modules` and dot-folders.

Globs: `**` matches any number of folders, `*` matches within one path segment, and `?` matches one character.
