import json
import os

import pika

EXCHANGE = "shop.events"


def publish_event(event_type: str, payload: dict) -> None:
    connection = pika.BlockingConnection(pika.URLParameters(os.environ.get("AMQP_URL", "amqp://localhost")))
    channel = connection.channel()
    channel.basic_publish(exchange=EXCHANGE, routing_key=event_type, body=json.dumps(payload))
    connection.close()
