from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from .db import engine, init_db

app = FastAPI(title="inventory")
init_db()


class Reservation(BaseModel):
    quantity: int


def available(conn, sku: str) -> int:
    row = conn.execute(text("SELECT on_hand - reserved FROM stock_levels WHERE sku = :sku"), {"sku": sku}).first()
    return row[0] if row else 0


@app.post("/stock/{sku}/reserve")
def reserve(sku: str, body: Reservation):
    with engine.begin() as conn:
        if available(conn, sku) < body.quantity:
            raise HTTPException(409, "insufficient stock")
        conn.execute(
            text("UPDATE stock_levels SET reserved = reserved + :qty WHERE sku = :sku"),
            {"sku": sku, "qty": body.quantity},
        )
    return {"sku": sku, "reserved": body.quantity}
