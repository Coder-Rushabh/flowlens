"""Consumes order events and records stock movements (iterator style, like many production consumers)."""

import asyncio
import json
import os

import aio_pika
from sqlalchemy import text

from .db import engine, init_db

BINDINGS = ["order.placed", "order.cancelled"]


def record_movement(event: dict) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO movements (sku, delta, reason) VALUES (:sku, :delta, :reason)"),
            {"sku": event["sku"], "delta": -event["quantity"], "reason": f"order {event['id']}"},
        )
        conn.execute(
            text("UPDATE stock_levels SET on_hand = on_hand - :qty, reserved = reserved - :qty WHERE sku = :sku"),
            {"sku": event["sku"], "qty": event["quantity"]},
        )


async def handle(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    event = json.loads(message.body)
    record_movement(event)
    await message.ack()


async def consume() -> None:
    init_db()
    connection = await aio_pika.connect_robust(os.environ.get("AMQP_URL", "amqp://guest:guest@rabbitmq/"))
    channel = await connection.channel()
    exchange = await channel.declare_exchange("shop.events", aio_pika.ExchangeType.TOPIC, durable=True)
    queue = await channel.declare_queue("inventory.orders", durable=True)
    for key in BINDINGS:
        await queue.bind(exchange, routing_key=key)
    async with queue.iterator() as messages:
        async for message in messages:
            await handle(message)


if __name__ == "__main__":
    asyncio.run(consume())
