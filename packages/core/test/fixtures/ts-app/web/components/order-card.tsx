import { ordersApi } from "../lib/api";

export function OrderCard({ id }: { id: string }) {
  const cancel = () => ordersApi.cancel(id);
  return <button onClick={cancel}>cancel {id}</button>;
}
