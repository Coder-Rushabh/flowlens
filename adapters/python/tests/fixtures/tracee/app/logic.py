import asyncio


class Cart:
    def __init__(self, owner):
        self.owner = owner
        self.items = []

    def add(self, sku, qty=1):
        self.items.append({"sku": sku, "qty": qty})
        return len(self.items)


def numbers(n):
    for i in range(n):
        yield i * 10


def checkout(cart, password="hunter2"):
    total = sum(price(item["sku"]) * item["qty"] for item in cart.items)
    cart.items.clear()
    return {"owner": cart.owner, "total": total}


def price(sku):
    if sku == "bad":
        raise ValueError("unknown sku")
    return 5


async def fetch(x):
    await asyncio.sleep(0)
    return await double(x)


async def double(x):
    await asyncio.sleep(0)
    return x * 2


async def failing():
    await asyncio.sleep(0)
    raise RuntimeError("boom")


async def guarded():
    try:
        await failing()
    except RuntimeError:
        return "recovered"


def run():
    cart = Cart("ana")
    cart.add("A", 2)
    list(numbers(2))
    result = checkout(cart)
    try:
        price("bad")
    except ValueError:
        pass
    asyncio.run(fetch(21))
    asyncio.run(guarded())
    return result
