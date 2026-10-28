import json
import os

import aio_pika


async def publish_event(event_type: str, payload: dict) -> None:
    connection = await aio_pika.connect_robust(os.environ.get("AMQP_URL", "amqp://guest:guest@rabbitmq/"))
    async with connection:
        channel = await connection.channel()
        exchange = await channel.declare_exchange("shop.events", aio_pika.ExchangeType.TOPIC, durable=True)
        await exchange.publish(aio_pika.Message(json.dumps(payload).encode()), routing_key=event_type)
