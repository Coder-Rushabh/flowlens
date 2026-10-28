PRICES = {"SHOE-1": 49.0, "SANDAL-2": 19.5}


def unit_price(sku: str) -> float:
    if sku not in PRICES:
        raise KeyError(f"no price for {sku}")
    return PRICES[sku]


def quote(sku: str, quantity: int, coupon: str | None = None) -> dict:
    subtotal = unit_price(sku) * quantity
    discount = 0.1 * subtotal if coupon == "WELCOME10" else 0.0
    return {"subtotal": subtotal, "discount": discount, "total": round(subtotal - discount, 2)}
