import os

import httpx

INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://inventory:8000")


async def reserve_stock(sku: str, quantity: int) -> bool:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(f"{INVENTORY_URL}/stock/{sku}/reserve", json={"quantity": quantity})
    return response.status_code == 200
