import { Router } from "express";
import { cancelOrder, getOrder } from "../services/orders";

const router = Router();

router.get("/:id", async (req, res) => {
  res.json(await getOrder(req.params.id));
});

router.post("/:id/cancel", async (req, res) => {
  res.json(await cancelOrder(req.params.id));
});

export default router;
