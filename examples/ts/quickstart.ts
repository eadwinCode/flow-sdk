// Quick start: one function, served by an Express app.
// Run: node quickstart.ts (Node 24 runs TypeScript files as they are).
// Needs FLOW_SIGNING_KEY, and FLOW_BASE_URL when you use a local engine.
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

// #region client
// The app ID names this app on the engine. Keep it the same forever.
const flow = new Flow({ id: "quickstart" });
// #endregion client

// #region function
const helloWorld = flow.createFunction(
  { id: "hello-world" },
  { event: "demo/hello" },
  async ({ event, step }) => {
    const greeting = await step.run("make-greeting", () => {
      return `Hello, ${event.data.name}!`;
    });

    await step.sleep("wait-a-moment", "10s");

    await step.run("print-greeting", () => {
      console.log(greeting);
    });

    return { greeting };
  },
);
// #endregion function

// #region serve
const app = express();
// One endpoint for all functions. The engine calls it to run your code.
app.use("/api/flow", serve({ client: flow, functions: [helloWorld] }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));
// #endregion serve
