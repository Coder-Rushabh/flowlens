"""Built-in detectors. Each one maps a family of frameworks onto FlowLens sources, sinks and edges."""

from .http_client import HttpClientDetector
from .messaging import MessagingDetector
from .orm import OrmDetector
from .routes import RoutesDetector
from .sql import SqlDetector
from .storage import StorageDetector

BUILTIN = {
    d.name: d
    for d in (RoutesDetector, OrmDetector, SqlDetector, MessagingDetector, StorageDetector, HttpClientDetector)
}
