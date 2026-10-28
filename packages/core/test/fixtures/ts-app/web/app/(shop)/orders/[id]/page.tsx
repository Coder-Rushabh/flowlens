import { OrderCard } from "@/components/order-card";
import { ordersApi } from "@/lib/api";

export default function OrderPage({ params }: { params: { id: string } }) {
  const load = async () => ordersApi.get(params.id);
  void load();
  return <OrderCard id={params.id} />;
}
