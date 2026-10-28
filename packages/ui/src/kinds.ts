// Visual vocabulary. Colors are CSS variables defined in styles.css (light + dark).

export const NODE_KINDS: Record<string, { chip: string; color: string; title: string }> = {
  route: { chip: "ROUTE", color: "var(--k-route)", title: "HTTP entry point" },
  routes: { chip: "ROUTES", color: "var(--k-route)", title: "HTTP entry points" },
  entry: { chip: "ENTRY", color: "var(--k-entry)", title: "Entry point (CLI, job)" },
  function: { chip: "FN", color: "var(--k-function)", title: "Function" },
  module: { chip: "MODULE", color: "var(--k-module)", title: "Module" },
  service: { chip: "SERVICE", color: "var(--k-service)", title: "Service" },
  table: { chip: "TABLE", color: "var(--k-table)", title: "Database table" },
  schema: { chip: "SCHEMA", color: "var(--k-table)", title: "Database schema" },
  topic: { chip: "TOPIC", color: "var(--k-topic)", title: "Message topic / queue" },
  bucket: { chip: "BUCKET", color: "var(--k-bucket)", title: "Object storage" },
  external: { chip: "EXTERNAL", color: "var(--k-external)", title: "External system" },
};

export const EDGE_KINDS: Record<string, { color: string; dashed?: boolean; title: string }> = {
  handles: { color: "var(--k-route)", title: "receives request" },
  calls: { color: "var(--e-calls)", title: "calls" },
  reads: { color: "var(--k-table)", dashed: true, title: "reads" },
  writes: { color: "var(--e-writes)", title: "writes" },
  publishes: { color: "var(--k-topic)", title: "publishes" },
  consumes: { color: "var(--k-topic)", dashed: true, title: "consumes" },
  routes: { color: "var(--k-topic)", dashed: true, title: "routed to" },
  http: { color: "var(--k-bucket)", title: "HTTP call" },
};
