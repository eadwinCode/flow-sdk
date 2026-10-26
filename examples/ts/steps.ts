// Functions and steps: every kind of step, in small functions.
// Run: node steps.ts
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "orders" });

// #region replay
const replayDemo = flow.createFunction(
  { id: "replay-demo" },
  { event: "demo/replay" },
  async ({ step }) => {
    console.log("the function starts"); // not in a step: runs on every call

    const a = await step.run("step-a", () => {
      console.log("step-a runs"); // in a step: runs once
      return 1;
    });
    const b = await step.run("step-b", () => {
      console.log("step-b runs");
      return 2;
    });

    console.log("the function ends");
    return a + b;
  },
);
// #endregion replay

// #region order
const fulfilOrder = flow.createFunction(
  { id: "fulfil-order" },
  { event: "order/placed" },
  async ({ event, step }) => {
    const orderId: string = event.data.orderId;

    // run: do some work once, and keep its result.
    const charge = await step.run("charge-card", ({ idempotencyKey }) =>
      // The same key on every try of this step: the payment API charges once.
      chargeCard(orderId, event.data.total, idempotencyKey),
    );

    // waitForEvent: pause until order/shipped comes for this order, or 14 days pass.
    const shipped = await step.waitForEvent("wait-for-shipment", {
      event: "order/shipped",
      match: "data.orderId", // the new event's data.orderId must equal this one's
      timeout: "14d",
    });
    if (shipped === null) {
      await step.run("alert-support", () => alertSupport(`order ${orderId} did not ship in 14 days`));
      return { orderId, shipped: false };
    }

    // sendEvent: send events from a function, once.
    await step.sendEvent("ask-for-review", {
      name: "review/requested",
      data: { orderId, carrier: shipped.data.carrier },
    });

    return { orderId, chargeId: charge.id, shipped: true };
  },
);
// #endregion order

// #region sleep
const followUp = flow.createFunction(
  { id: "follow-up" },
  { event: "order/delivered" },
  async ({ event, step }) => {
    // Pause for a time: "30s", "15m", "2h", "1h30m", "3d", "2w", or ms as a number.
    await step.sleep("wait-3-days", "3d");
    await step.run("ask-how-it-went", () => sendEmail(event.data.email, "How is your order?"));

    // Pause until a moment: a Date, ms since 1970, or an ISO date text.
    await step.sleepUntil("wait-for-new-year", "2027-01-01T09:00:00Z");
    await step.run("send-greetings", () => sendEmail(event.data.email, "Happy new year"));
  },
);
// #endregion sleep

// #region invoke
// The child: any function can be invoked. Its return value goes back to the caller.
const buildInvoice = flow.createFunction(
  { id: "build-invoice" },
  { event: "invoice/requested" },
  async ({ event, step }) => {
    return step.run("make-pdf", () => makeInvoicePdf(event.data.orderId));
  },
);

// The parent: starts a run of buildInvoice and waits for its result.
const closeOrder = flow.createFunction(
  { id: "close-order" },
  { event: "order/closed" },
  async ({ event, step }) => {
    const invoice = await step.invoke<{ url: string }>("build-invoice", {
      function: buildInvoice, // or the full ID: "orders-build-invoice"
      data: { orderId: event.data.orderId }, // becomes the child's event.data
      timeout: "1h", // optional: stop waiting after 1 hour
    });
    await step.run("email-invoice", () => sendEmail(event.data.email, `Your invoice: ${invoice.url}`));
    return invoice;
  },
);
// #endregion invoke

// #region parallel
const loadProfile = flow.createFunction(
  { id: "load-profile" },
  { event: "profile/requested" },
  async ({ event, step }) => {
    // Start both steps, then wait for both. The engine runs them at the same time.
    const [user, orders] = await Promise.all([
      step.run("load-user", () => loadUser(event.data.userId)),
      step.run("load-orders", () => loadOrders(event.data.userId)),
    ]);
    return { name: user.name, orders: orders.length };
  },
);
// #endregion parallel

// #region loop
const importRows = flow.createFunction(
  { id: "import-rows" },
  { event: "import/started" },
  async ({ event, step }) => {
    const rows: string[] = event.data.rows;
    // The same step ID in a loop is fine: the SDK counts each use.
    for (const row of rows) {
      await step.run("import-row", () => saveRow(row));
    }
    return { imported: rows.length };
  },
);
// #endregion loop

// #region cancel
const onboarding = flow.createFunction(
  {
    id: "onboarding",
    // Stop this run when user/deleted comes for the same user.
    cancelOn: [{ event: "user/deleted", match: "data.userId", timeout: "30d" }],
  },
  { event: "user/signed-up" },
  async ({ event, step }) => {
    await step.run("send-welcome", () => sendEmail(event.data.email, "Welcome!"));
    await step.sleep("wait-a-week", "7d");
    await step.run("send-tips", () => sendEmail(event.data.email, "Tips for your first week"));
  },
);
// #endregion cancel

const app = express();
app.use(
  "/api/flow",
  serve({
    client: flow,
    functions: [replayDemo, fulfilOrder, followUp, buildInvoice, closeOrder, loadProfile, importRows, onboarding],
  }),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own code. ----

async function chargeCard(orderId: string, total: number, idempotencyKey: string): Promise<{ id: string }> {
  console.log(`charged ${total} for ${orderId} (key ${idempotencyKey})`);
  return { id: `ch_${orderId}` };
}

async function alertSupport(text: string): Promise<void> {
  console.log(`support: ${text}`);
}

async function sendEmail(to: string, text: string): Promise<void> {
  console.log(`email to ${to}: ${text}`);
}

async function makeInvoicePdf(orderId: string): Promise<{ url: string }> {
  return { url: `https://files.example.com/invoices/${orderId}.pdf` };
}

async function loadUser(userId: string): Promise<{ name: string }> {
  return { name: `User ${userId}` };
}

async function loadOrders(userId: string): Promise<string[]> {
  return [`${userId}-o1`, `${userId}-o2`];
}

async function saveRow(row: string): Promise<void> {
  console.log(`saved ${row}`);
}
