import { createServer } from "node:http";

const stock = { "SHOE-1": 10 };

export function reserve(sku, qty) {
  if ((stock[sku] ?? 0) < qty) return false;
  stock[sku] -= qty;
  return true;
}

async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

export const handlers = {
  reserveRoute: async (req, res, sku) => {
    const body = await readJson(req);
    const ok = reserve(sku, body.quantity);
    res.writeHead(ok ? 200 : 409, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
  },
};

const server = createServer((req, res) => {
  const m = req.url.match(/^\/stock\/([^/]+)\/reserve$/);
  if (req.method === "POST" && m) return handlers.reserveRoute(req, res, m[1]);
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.PORT), () => console.log("ready"));
