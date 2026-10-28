import express from "express";
import orders from "./routes/orders";

const app = express();
app.use("/api/orders", orders);
app.listen(3000);
