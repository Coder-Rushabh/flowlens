import { createServer } from "node:http";
import { quote } from "./pricing.ts";

interface Order {
  sku: string;
  quantity: number;
  total?: number;
}

export async function placeOrder(order: Order): Promise<Order> {
  order.total = quote(order.sku, order.quantity);
  const res = await fetch(`${process.env.INVENTORY_URL}/stock/${order.sku}/reserve`, {
    method: "POST",
    body: JSON.stringify({ quantity: order.quantity }),
  });
  if (!res.ok) throw new Error("out of stock");
  return order;
}

const server = createServer(async (req, res) => {
  try {
    const out = await placeOrder({ sku: req.url === "/big" ? "SHOE-1" : "SHOE-1", quantity: req.url === "/big" ? 50 : 2 });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(409);
    res.end(String(e));
  }
});
server.listen(Number(process.env.PORT), () => console.log("ready"));
