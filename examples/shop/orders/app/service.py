from sqlalchemy import select
from sqlalchemy.orm import Session

from .clients import reserve_stock
from .events import publish_event
from .models import AuditEntry, Order


def price_for(sku: str, quantity: int) -> float:
    return round(9.99 * quantity, 2)


def place_order(db: Session, sku: str, quantity: int) -> Order:
    if not reserve_stock(sku, quantity):
        raise ValueError("out of stock")
    order = Order(sku=sku, quantity=quantity, total=price_for(sku, quantity))
    db.add(order)
    db.add(AuditEntry(message=f"order for {sku}"))
    db.commit()
    publish_event("order.placed", {"id": order.id, "sku": sku, "quantity": quantity})
    return order


def cancel_order(db: Session, order_id: int) -> None:
    order = db.scalars(select(Order).where(Order.id == order_id)).one()
    order.status = "cancelled"
    db.commit()
    publish_event("order.cancelled", {"id": order_id})
