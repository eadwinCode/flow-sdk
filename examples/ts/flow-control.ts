// Flow control: options that decide when, and how many, runs go.
// Run: node flow-control.ts
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine).
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "flow-control" });

// #region concurrency
const syncCrm = flow.createFunction(
  {
    id: "sync-crm",
    // At most 5 steps at once per account, and 50 at once in all.
    concurrency: [{ limit: 50 }, { limit: 5, key: "event.data.accountId" }],
  },
  { event: "crm/sync" },
  async ({ event, step }) => {
    await step.run("sync", () => syncAccount(event.data.accountId));
  },
);
// #endregion concurrency

// #region shared-concurrency
// Two functions share one limit: 10 calls at once to the partner's API, in all.
const partnerLimit = { limit: 10, key: "'partner-api'", scope: "account" as const };

const pushOrders = flow.createFunction(
  { id: "push-orders", concurrency: partnerLimit },
  { event: "partner/orders-changed" },
  async ({ event, step }) => {
    await step.run("push", () => callPartner("orders", event.data));
  },
);

const pushStock = flow.createFunction(
  { id: "push-stock", concurrency: partnerLimit },
  { event: "partner/stock-changed" },
  async ({ event, step }) => {
    await step.run("push", () => callPartner("stock", event.data));
  },
);
// #endregion shared-concurrency

// #region throttle
const resizeImage = flow.createFunction(
  {
    id: "resize-image",
    // Start at most 60 runs a minute per user (one a second), plus 10 at once
    // after a quiet time. Extra runs wait; none are lost.
    throttle: { limit: 60, period: "1m", burst: 10, key: "event.data.userId" },
  },
  { event: "image/uploaded" },
  async ({ event, step }) => {
    await step.run("resize", () => resize(event.data.imageId));
  },
);
// #endregion throttle

// #region rate-limit
const lowStockAlert = flow.createFunction(
  {
    id: "low-stock-alert",
    // At most one run per product every 4 hours. Extra events start no run.
    rateLimit: { limit: 1, period: "4h", key: "event.data.productId" },
  },
  { event: "stock/low" },
  async ({ event, step }) => {
    await step.run("alert", () => alert(`low stock: ${event.data.productId}`));
  },
);
// #endregion rate-limit

// #region debounce
const indexDocument = flow.createFunction(
  {
    id: "index-document",
    // Wait until a document has had no edits for 5 minutes, then run once, with
    // the last edit. Never wait more than 30 minutes in all.
    debounce: { period: "5m", key: "event.data.documentId", timeout: "30m" },
  },
  { event: "document/edited" },
  async ({ event, step }) => {
    await step.run("index", () => indexDoc(event.data.documentId));
  },
);
// #endregion debounce

// #region batch
const saveClicks = flow.createFunction(
  {
    id: "save-clicks",
    // Up to 100 events per run, or what came in 10 seconds, per site.
    batchEvents: { maxSize: 100, timeout: "10s", key: "event.data.siteId" },
  },
  { event: "page/clicked" },
  async ({ events, step }) => {
    await step.run("insert", () => insertClicks(events.map((e) => e.data)));
    return { saved: events.length };
  },
);
// #endregion batch

// #region priority
const generateReport = flow.createFunction(
  {
    id: "generate-report",
    concurrency: { limit: 10 },
    // Runs waiting for a slot: enterprise ones go first, as if they had waited
    // 2 minutes longer.
    priority: { run: "event.data.plan == 'enterprise' ? 120 : 0" },
  },
  { event: "report/requested" },
  async ({ event, step }) => {
    await step.run("build", () => buildReport(event.data.accountId));
  },
);
// #endregion priority

// #region idempotency
const sendReceipt = flow.createFunction(
  {
    id: "send-receipt",
    // One run per order, however many order/paid events come for it.
    idempotency: "event.data.orderId",
  },
  { event: "order/paid" },
  async ({ event, step }) => {
    await step.run("email", () => emailReceipt(event.data.orderId));
  },
);
// #endregion idempotency

// #region singleton
const rebuildSearch = flow.createFunction(
  {
    id: "rebuild-search",
    // One run at a time per site. While one runs, a new event starts no run.
    singleton: { key: "event.data.siteId", mode: "skip" },
  },
  { event: "search/rebuild" },
  async ({ event, step }) => {
    await step.run("rebuild", () => rebuild(event.data.siteId));
  },
);
// #endregion singleton

const app = express();
app.use(
  "/api/flow",
  serve({
    client: flow,
    functions: [
      syncCrm, pushOrders, pushStock, resizeImage, lowStockAlert, indexDocument,
      saveClicks, generateReport, sendReceipt, rebuildSearch,
    ],
  }),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own code. ----

const log = (what: string) => async (...args: unknown[]) => {
  console.log(what, ...args);
};
const syncAccount = log("sync account");
const callPartner = log("call partner");
const resize = log("resize");
const alert = log("alert");
const indexDoc = log("index document");
const insertClicks = log("insert clicks");
const buildReport = log("build report");
const emailReceipt = log("email receipt");
const rebuild = log("rebuild search");
