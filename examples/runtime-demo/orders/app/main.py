from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel

from . import service

app = FastAPI(title="orders")
router = APIRouter(prefix="/orders")


class NewOrder(BaseModel):
    sku: str
    quantity: int
    email: str
    coupon: str | None = None


@router.post("")
async def create_order(body: NewOrder):
    """Price it, reserve stock in inventory, store it, announce it."""
    try:
        return await service.place_order(body.sku, body.quantity, body.email, body.coupon)
    except service.OutOfStock:
        raise HTTPException(409, "out of stock")
    except KeyError as exc:
        raise HTTPException(400, str(exc))


@router.post("/{order_id}/cancel")
def cancel(order_id: int):
    return service.cancel_order(order_id)


app.include_router(router)
