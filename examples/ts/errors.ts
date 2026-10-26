// Errors and retries: what happens when code fails, and how to change it.
// Run: node errors.ts
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
import express from "express";
import { Flow, NonRetriableError, RetryAfterError, StepError } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "billing" });

// #region compensate
const chargeOrder = flow.createFunction(
  { id: "charge-order", retries: 3 },
  { event: "order/checkout" },
  async ({ event, step }) => {
    const hold = await step.run("hold-stock", () => holdStock(event.data.orderId));

    try {
      await step.run("charge-card", ({ idempotencyKey }) => chargeCard(event.data.card, idempotencyKey));
    } catch (err) {
      // A StepError means the step failed for good: no tries are left.
      if (!(err instanceof StepError)) throw err;
      // Undo the earlier step, in a step of its own.
      await step.run("release-stock", () => releaseStock(hold.holdId));
      return { status: "payment-failed", reason: err.message };
    }

    return { status: "paid" };
  },
);
// #endregion compensate

// #region retry-after
const pushContacts = flow.createFunction(
  { id: "push-contacts" },
  { event: "crm/contacts-changed" },
  async ({ event, step }) => {
    return step.run("push-to-crm", async () => {
      const answer = await crmUpdate(event.data.contactIds);
      if (answer.status === 429) {
        // Try this step again when the API says, not on the normal schedule.
        throw new RetryAfterError("the CRM is rate limiting us", `${answer.retryAfterSeconds}s`);
      }
      return answer.updated;
    });
  },
);
// #endregion retry-after

// #region on-failure
const importUsers = flow.createFunction(
  {
    id: "import-users",
    // Runs once a run of import-users fails for good.
    onFailure: async ({ error, event, step }) => {
      // event is inngest/function.failed; event.data.event is the event that
      // started the failed run.
      await step.run("alert-the-team", () =>
        postToChat(`import of ${event.data.event.data.file} failed: ${error.message}`),
      );
    },
  },
  { event: "import/requested" },
  async ({ event, step }) => {
    const rows = await step.run("read-file", () => readFile(event.data.file));
    if (rows.length === 0) {
      // Trying again can not help: fail now, with no more retries.
      throw new NonRetriableError(`${event.data.file} is empty`);
    }
    return { rows: rows.length };
  },
);
// #endregion on-failure

// #region timeouts
const exportData = flow.createFunction(
  {
    id: "export-data",
    timeouts: {
      step: "2m", // one call to your app may take up to 2 minutes
      finish: "1h", // the whole run may take up to 1 hour, then it is cancelled
    },
  },
  { event: "export/requested" },
  async ({ event, step }) => {
    return step.run("export", () => runExport(event.data.accountId));
  },
);
// #endregion timeouts

const app = express();
app.use("/api/flow", serve({ client: flow, functions: [chargeOrder, pushContacts, importUsers, exportData] }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own code and outside APIs. ----

async function holdStock(orderId: string): Promise<{ holdId: string }> {
  return { holdId: `hold_${orderId}` };
}

async function releaseStock(holdId: string): Promise<void> {
  console.log(`released ${holdId}`);
}

async function chargeCard(card: string, idempotencyKey: string): Promise<{ chargeId: string }> {
  if (card === "declined") throw new NonRetriableError("the card was declined");
  if (card === "flaky") throw new Error("the payment API timed out");
  return { chargeId: `ch_${idempotencyKey.slice(-8)}` };
}

let crmCalls = 0;
async function crmUpdate(contactIds: string[]): Promise<{ status: number; retryAfterSeconds: number; updated: number }> {
  crmCalls += 1;
  // A pretend API: the first call is rate limited.
  return crmCalls === 1
    ? { status: 429, retryAfterSeconds: 20, updated: 0 }
    : { status: 200, retryAfterSeconds: 0, updated: contactIds.length };
}

async function readFile(file: string): Promise<string[]> {
  return file.startsWith("empty") ? [] : ["row 1", "row 2"];
}

async function postToChat(text: string): Promise<void> {
  console.log(`chat: ${text}`);
}

async function runExport(accountId: string): Promise<{ url: string }> {
  return { url: `https://files.example.com/exports/${accountId}.csv` };
}
