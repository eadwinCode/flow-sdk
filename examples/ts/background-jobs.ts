// Background jobs: the sign-up route answers at once, and a function does the slow
// work (set up the account, send the welcome email) with retries.
// Run: node background-jobs.ts
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
import { randomUUID } from "node:crypto";
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "shop" });

// #region function
const onboardUser = flow.createFunction(
  {
    id: "onboard-user",
    // Each step gets 1 try plus 4 retries (the default). Set it to be sure.
    retries: 4,
    // At most 5 steps of this function run at the same time, over all runs,
    // so a burst of sign-ups does not flood the email provider.
    concurrency: { limit: 5 },
    // And start at most 60 runs a minute.
    throttle: { limit: 60, period: "1m" },
  },
  { event: "user/signed-up" },
  async ({ event, step }) => {
    const { userId, email } = event.data;

    // Safe to run twice: it creates the account only if it is not there yet.
    await step.run("create-account", () => createAccount(userId));

    const sent = await step.run("send-welcome-email", ({ idempotencyKey }) =>
      // The key is the same on every try of this step. The email provider uses it
      // to send the email once, even if this step runs again.
      sendEmail({ to: email, template: "welcome", idempotencyKey }),
    );

    await step.run("mark-onboarded", () => markOnboarded(userId));

    return { userId, emailId: sent.id };
  },
);
// #endregion function

const app = express();
app.use("/api/flow", serve({ client: flow, functions: [onboardUser] }));

// #region route
// Your own API. It saves the user, sends one event, and answers. The slow work
// happens later, in the function.
app.post("/signup", express.json(), async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== "string" || email === "") {
    res.status(400).json({ error: "email is required" });
    return;
  }
  // One user per email: a second sign-up with the same email gets the same user.
  const userId = await saveUser(email);

  try {
    await flow.send({
      // The id comes from the saved user, so a retried sign-up sends the same id.
      // If the engine got the first send, it sees one event, and the function runs
      // once.
      id: `signup-${userId}`,
      name: "user/signed-up",
      data: { userId, email },
    });
  } catch (err) {
    // Not queued. The user is saved but will not be onboarded unless the caller
    // tries again: answer an error so it does.
    console.error("could not queue the sign-up", err);
    res.status(503).json({ error: "try again" });
    return;
  }

  res.status(201).json({ userId });
});
// #endregion route

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own database and email provider. ----

const users = new Map<string, { email: string; account?: boolean; onboarded?: boolean }>();
const userIdByEmail = new Map<string, string>();

// Saves the user, or finds the one saved with this email (like a unique column).
async function saveUser(email: string): Promise<string> {
  const known = userIdByEmail.get(email);
  if (known) return known;
  const userId = `user_${randomUUID()}`;
  userIdByEmail.set(email, userId);
  users.set(userId, { email });
  return userId;
}

async function createAccount(userId: string): Promise<void> {
  const user = users.get(userId);
  if (user && !user.account) user.account = true;
}

async function markOnboarded(userId: string): Promise<void> {
  const user = users.get(userId);
  if (user) user.onboarded = true;
}

// A pretend email API that fails the first call for each key, as a real one
// sometimes does. The step fails, the engine waits, and the retry works.
const seenKeys = new Map<string, string>();
async function sendEmail(mail: { to: string; template: string; idempotencyKey: string }): Promise<{ id: string }> {
  const done = seenKeys.get(mail.idempotencyKey);
  if (done) return { id: done };
  if (!seenKeys.has(`tried:${mail.idempotencyKey}`)) {
    seenKeys.set(`tried:${mail.idempotencyKey}`, "");
    throw new Error("email API answered 503: try again later");
  }
  const id = `email_${randomUUID()}`;
  seenKeys.set(mail.idempotencyKey, id);
  console.log(`sent ${mail.template} email to ${mail.to}`);
  return { id };
}
