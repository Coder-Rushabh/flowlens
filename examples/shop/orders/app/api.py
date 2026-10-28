from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from . import service
from .db import get_db

router = APIRouter(prefix="/orders", tags=["orders"])


@router.post("")
def create_order(sku: str, quantity: int, db: Session = Depends(get_db)):
    """Place an order: reserve stock, persist, announce."""
    return service.place_order(db, sku, quantity)


@router.delete("/{order_id}")
def delete_order(order_id: int, db: Session = Depends(get_db)):
    service.cancel_order(db, order_id)
