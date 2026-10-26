// Crons and scheduled jobs: a nightly report, a weekly digest sent per user, a
// reminder at a set time, and emails timed around a trial's end.
// Run: node crons.ts
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "reports" });

// #region nightly
const nightlyReport = flow.createFunction(
  { id: "nightly-report" },
  // 02:00 every day, Paris time. Without TZ=..., the time is UTC.
  { cron: "TZ=Europe/Paris 0 2 * * *" },
  async ({ event, step }) => {
    // The time this run was planned for, in ms. Use it, not the clock: a run
    // can start a little late, or be retried later.
    const day = new Date(event.data.scheduledAt).toISOString().slice(0, 10);

    const total = await step.run("build-report", () => buildReport(day));
    await step.run("email-report", () => emailReport(day, total));

    return { day, total };
  },
);
// #endregion nightly

// #region fan-out
// One cron run lists the users and sends one event per user. Each user then gets
// a run of their own, with its own retries.
const weeklyDigest = flow.createFunction(
  { id: "weekly-digest" },
  { cron: "TZ=UTC 0 7 * * MON" }, // Mondays at 07:00 UTC
  async ({ step }) => {
    const userIds = await step.run("list-users", () => listDigestUsers());

    // Up to 100 events per sendEvent, so send them in chunks, each its own step.
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100);
      await step.sendEvent(
        `send-chunk-${i / 100}`,
        chunk.map((userId) => ({ name: "digest/send", data: { userId } })),
      );
    }
    return { users: userIds.length };
  },
);

const sendDigest = flow.createFunction(
  { id: "send-digest", concurrency: { limit: 10 } },
  { event: "digest/send" },
  async ({ event, step }) => {
    await step.run("send-digest-email", () => sendDigestEmail(event.data.userId));
  },
);
// #endregion fan-out

// #region at-a-time
// A run that starts at a set time: send the event now, with `ts` in the future.
const sendReminder = flow.createFunction(
  { id: "send-reminder" },
  { event: "reminder/due" },
  async ({ event, step }) => {
    await step.run("send-reminder", () => notify(event.data.userId, event.data.text));
  },
);

const app = express();
app.post("/reminders", express.json(), async (req, res) => {
  const { userId, text, at } = req.body; // at: "2026-11-02T09:00:00Z"
  const { ids } = await flow.send({
    name: "reminder/due",
    data: { userId, text },
    ts: Date.parse(at), // the run waits, queued, until this time
  });
  res.status(202).json({ eventId: ids[0] });
});
// #endregion at-a-time

// #region trial
// Emails timed around a trial's end. Ends early if the user pays.
const trialEmails = flow.createFunction(
  {
    id: "trial-emails",
    cancelOn: [{ event: "trial/converted", match: "data.userId" }],
  },
  { event: "trial/started" },
  async ({ event, step }) => {
    const endsAt = Date.parse(event.data.endsAt);
    const threeDays = 3 * 24 * 60 * 60 * 1000;

    await step.sleepUntil("wait-until-3-days-left", endsAt - threeDays);
    await step.run("send-ending-soon", () => notify(event.data.userId, "Your trial ends in 3 days"));

    await step.sleepUntil("wait-until-the-end", endsAt);
    await step.run("end-trial", () => endTrial(event.data.userId));
  },
);
// #endregion trial

app.use(
  "/api/flow",
  serve({ client: flow, functions: [nightlyReport, weeklyDigest, sendDigest, sendReminder, trialEmails] }),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own code. ----

async function buildReport(day: string): Promise<number> {
  console.log(`building the report for ${day}`);
  return 42;
}

async function emailReport(day: string, total: number): Promise<void> {
  console.log(`report for ${day}: ${total}`);
}

async function listDigestUsers(): Promise<string[]> {
  return Array.from({ length: 120 }, (_, i) => `user_${i + 1}`);
}

async function sendDigestEmail(userId: string): Promise<void> {
  console.log(`digest sent to ${userId}`);
}

async function notify(userId: string, text: string): Promise<void> {
  console.log(`to ${userId}: ${text}`);
}

async function endTrial(userId: string): Promise<void> {
  console.log(`trial ended for ${userId}`);
}
