import { PrismaClient } from "@prisma/client";
import { pool } from "../db";

const prisma = new PrismaClient();

export async function getOrder(id: string) {
  return prisma.order.findUnique({ where: { id } });
}

export async function cancelOrder(id: string) {
  await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id]);
  await prisma.auditLog.create({ data: { message: `cancel ${id}` } });
  return { id, status: "cancelled" };
}
