// Start runs from your app, then find, count and cancel them.
// Run: node runs.ts
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine).
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "jobs" });

// #region tags
const runJob = flow.createFunction(
  {
    id: "run-job",
    // One active run per job key.
    singleton: { key: "event.data.key", mode: "skip" },
    // Tags let you find this job's runs later. Worked out once, when a run starts.
    tags: { jobId: "event.data.jobId" },
  },
  { event: "jobs/run" },
  async ({ event, step }) => {
    await step.run("work", () => doWork(event.data.jobId));
  },
);
// #endregion tags

const app = express();
app.use("/api/flow", serve({ client: flow, functions: [runJob] }));
app.listen(Number(process.env.PORT ?? 3000));

export async function enqueue(jobId: string, key: string) {
  // #region start
  // Starts the run now and says if it did not. `id` makes a retry of this call safe.
  const result = await flow.start(runJob, { data: { jobId, key }, id: `job-${jobId}` });
  if (!result.started && result.reason === "singleton") {
    console.log(`job ${key} already runs as ${result.activeRunId}`);
  }
  // #endregion start
  return result;
}

export async function inspect(jobId: string, key: string) {
  // #region find
  // By tag or status. These read an index that lags the runs by a few seconds.
  const page = await flow.runs.list({ function: runJob, tags: { jobId }, status: ["queued", "running", "sleeping"] });
  const counts = await flow.runs.counts({ function: runJob });
  console.log(page.items.length, "active runs for", jobId, "-", counts.queued, "queued in all");

  // By singleton key: exact, no lag.
  const holder = await flow.runs.singleton(runJob, key);
  console.log(holder.runId ? `${key} is held by ${holder.runId} (${holder.status})` : `${key} is free`);
  // #endregion find
}

export async function withdraw(jobId: string, key: string) {
  // #region cancel
  // One run, the run that holds a key, or the active runs with a tag.
  await flow.runs.cancel({ function: runJob, singletonKey: key });
  const { cancelled, more } = await flow.runs.cancel({ function: runJob, tag: { jobId } });
  console.log(`cancelled ${cancelled.length}${more ? ", and there are more" : ""}`);
  // #endregion cancel
}

// ---- Stand-ins for your own code. ----

async function doWork(jobId: string): Promise<void> {
  console.log(`working on ${jobId}`);
}
