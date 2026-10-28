import axios from "axios";

export const api = axios.create({ baseURL: "" });

export const ordersApi = {
  get: (id: string) => api.get(`/api/orders/${id}`),
  cancel: (id: string) => api.post(`/api/orders/${id}/cancel`, {}),
};
