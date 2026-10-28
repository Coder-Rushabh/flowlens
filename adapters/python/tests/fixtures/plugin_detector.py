"""Example plugin: treat calls to a house-made ``notify("channel", ...)`` helper as publishes."""

from flowlens.scan.astutil import const_str, last_name
from flowlens.scan.context import Detector


class NotifyDetector(Detector):
    name = "notify"

    def analyze(self, ctx, scope):
        for call in scope.calls:
            if last_name(call.func) == "notify" and call.args and (channel := const_str(call.args[0])):
                topic = ctx.topic(f"notify:{channel}", "in-house")
                ctx.graph.add_edge(scope.fn.id, topic, "publishes", scope.fn.path, call.lineno, "notify")
