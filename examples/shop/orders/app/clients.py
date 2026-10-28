import os

import httpx

INVENTORY_URL = os.environ.get("INVENTORY_SERVICE_URL", "http://inventory:5000")


def reserve_stock(sku: str, quantity: int) -> bool:
    with httpx.Client(timeout=5.0) as client:
        response = client.post(f"{INVENTORY_URL}/stock/{sku}/reserve", json={"quantity": quantity})
    return response.status_code == 200
