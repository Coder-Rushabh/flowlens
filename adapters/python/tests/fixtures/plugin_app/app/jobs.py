def notify(channel, message):
    print(channel, message)


def nightly_report():
    notify("ops-alerts", "report ready")
