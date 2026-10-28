"""Consumes order events, records stock movements and archives a receipt."""

import json
import os

import boto3
import pika
from celery import Celery

from .db import get_connection

celery_app = Celery("inventory", broker=os.environ.get("AMQP_URL", "amqp://localhost"))
BINDINGS = ["order.placed", "order.cancelled"]
RECEIPTS_BUCKET = os.environ.get("RECEIPTS_BUCKET", "shop-receipts")


@celery_app.task(name="inventory.archive_receipt")
def archive_receipt(order_id: int, body: str) -> None:
    s3 = boto3.client("s3")
    s3.put_object(Bucket=RECEIPTS_BUCKET, Key=f"receipts/{order_id}.json", Body=body)


def on_message(channel, method, properties, body):
    event = json.loads(body)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO warehouse.movements (sku, delta) VALUES (%s, %s)",
            (event["sku"], -event.get("quantity", 0)),
        )
    archive_receipt.delay(event["id"], body.decode())


def main() -> None:
    connection = pika.BlockingConnection(pika.URLParameters(os.environ.get("AMQP_URL", "amqp://localhost")))
    channel = connection.channel()
    queue = channel.queue_declare(queue="inventory.orders", durable=True).method.queue
    for key in BINDINGS:
        channel.queue_bind(queue=queue, exchange="shop.events", routing_key=key)
    channel.basic_consume(queue=queue, on_message_callback=on_message)
    channel.start_consuming()


if __name__ == "__main__":
    main()
