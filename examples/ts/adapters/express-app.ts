// Express 5: mount the endpoint before express.json(), so the SDK sees the raw body.
// #region express
import express from "express";
import { serve } from "@clevix/flow/express";
import { flow, hello } from "./functions.ts";

const app = express();

app.use("/api/flow", serve({ client: flow, functions: [hello] }));
app.use(express.json()); // after the endpoint, for your own routes

app.listen(Number(process.env.PORT ?? 3000));
// #endregion express
