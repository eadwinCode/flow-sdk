// Hono: the endpoint is one route of your app. On Workers, c.env is passed on, so
// settings can live in the Worker's env.
// #region hono
import { Hono } from "hono";
import { serve } from "@clevix/flow/hono";
import { flow, hello } from "./functions.ts";

// On Workers, the Worker's env holds the settings.
type Bindings = { FLOW_SIGNING_KEY?: string; FLOW_EVENT_KEY?: string; FLOW_BASE_URL?: string };
const app = new Hono<{ Bindings: Bindings }>();

app.on(["GET", "PUT", "POST"], "/api/flow", serve({ client: flow, functions: [hello] }));

app.post("/hello", async (c) => {
  // On Workers, pass c.env so flow.send finds FLOW_EVENT_KEY there.
  const { ids } = await flow.send({ name: "demo/hello", data: { name: "Ada" } }, { env: c.env });
  return c.json({ ids });
});

export default app;
// #endregion hono
