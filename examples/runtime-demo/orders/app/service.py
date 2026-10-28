from .clients import reserve_stock
from .events import publish_event
from .models import Order, SessionLocal
from .pricing import quote


class OutOfStock(Exception):
    pass


async def place_order(sku: str, quantity: int, email: str, coupon: str | None = None) -> dict:
    price = quote(sku, quantity, coupon)
    if not await reserve_stock(sku, quantity):
        raise OutOfStock(sku)
    with SessionLocal() as db:
        order = Order(sku=sku, quantity=quantity, total=price["total"], customer_email=email)
        db.add(order)
        db.commit()
        db.refresh(order)
        result = {"id": order.id, "sku": sku, "quantity": quantity, "total": order.total, "email": email}
    await publish_event("order.placed", result)
    return result


def cancel_order(order_id: int) -> dict:
    with SessionLocal() as db:
        order = db.get(Order, order_id)
        order.status = "cancelled"
        db.commit()
        return {"id": order.id, "status": order.status}
