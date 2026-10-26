// Webhooks: your app gets GitHub's webhook, checks its signature, turns it into an
// event, and answers at once. Functions do the work, with retries.
// Run: node webhooks.ts
// Needs FLOW_SIGNING_KEY, FLOW_EVENT_KEY, GITHUB_WEBHOOK_SECRET
// (and FLOW_BASE_URL for a local engine).
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "integrations" });

// #region route
const app = express();

// express.raw keeps the body as bytes: the signature is over the exact bytes sent.
app.post("/webhooks/github", express.raw({ type: "application/json" }), async (req, res) => {
  const body: Buffer = req.body;
  if (!validGitHubSignature(body, req.get("X-Hub-Signature-256"))) {
    res.status(401).send("bad signature");
    return;
  }

  const kind = req.get("X-GitHub-Event") ?? "unknown"; // "push", "pull_request", ...
  const delivery = req.get("X-GitHub-Delivery") ?? ""; // one ID per delivery

  try {
    await flow.send({
      // A stable ID: if GitHub sends this delivery again, the engine sees the same
      // event, and each function runs once for it.
      id: `github-${delivery}`,
      name: `github/${kind}`,
      data: JSON.parse(body.toString("utf8")),
    });
  } catch (err) {
    // Not queued: answer an error, so GitHub sends it again later.
    console.error("could not send the event", err);
    res.status(500).send("try again");
    return;
  }

  // Queued. Answer now; the functions do the work.
  res.status(200).send("ok");
});

function validGitHubSignature(body: Buffer, header: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// #endregion route

// #region functions
// Two functions on the same event: each push starts one run of each.
const recordPush = flow.createFunction(
  { id: "record-push" },
  { event: "github/push" },
  async ({ event, step }) => {
    const repo: string = event.data.repository.full_name;
    const commits: number = event.data.commits.length;

    await step.run("save-push", () => savePush(repo, event.data.after, commits));
    await step.run("tell-the-team", () => postToChat(`${commits} new commit(s) in ${repo}`));

    return { repo, commits };
  },
);

const indexPush = flow.createFunction(
  { id: "index-push" },
  { event: "github/push" },
  async ({ event, step }) => {
    await step.run("add-to-search", () => addToSearch(event.data.repository.full_name, event.data.after));
  },
);
// #endregion functions

// #region wait
// When a pull request opens, wait up to 2 days for a review of it. No review:
// remind the team.
const reviewReminder = flow.createFunction(
  { id: "review-reminder" },
  { event: "github/pull_request", if: "event.data.action == 'opened'" },
  async ({ event, step }) => {
    const review = await step.waitForEvent("wait-for-review", {
      event: "github/pull_request_review",
      // `event` is the event that started this run; `async` is the new one.
      if: "async.data.pull_request.number == event.data.pull_request.number && async.data.repository.id == event.data.repository.id",
      timeout: "2d",
    });

    if (review === null) {
      await step.run("remind-the-team", () =>
        postToChat(`Pull request #${event.data.pull_request.number} has no review after 2 days`),
      );
      return { reviewed: false };
    }
    return { reviewed: true, by: review.data.review.user.login };
  },
);
// #endregion wait

app.use("/api/flow", serve({ client: flow, functions: [recordPush, indexPush, reviewReminder] }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own database and chat. ----

const pushes = new Map<string, { repo: string; commits: number }>();
const searchIndex = new Set<string>();

async function savePush(repo: string, sha: string, commits: number): Promise<void> {
  pushes.set(sha, { repo, commits }); // keyed by commit, so a second run changes nothing
}

async function addToSearch(repo: string, sha: string): Promise<void> {
  searchIndex.add(`${repo}@${sha}`); // a set: adding twice changes nothing
}

async function postToChat(text: string): Promise<void> {
  console.log(`chat: ${text}`);
}
