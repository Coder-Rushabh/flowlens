export const quote = (sku: string, qty: number): number => (sku === "SHOE-1" ? 49 : 10) * qty;
