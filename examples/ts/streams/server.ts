// Streams: a function writes a run's output to a stream; readers start from any
// offset and follow it live.
// Run: node streams/server.ts
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine). The engine needs
// REALTIME_TOKEN_SECRET for readers.
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "writer" });

// #region write
const writeReport = flow.createFunction({ id: "write-report" }, { event: "report/requested" }, async ({ event, step }) => {
  const streamId = `report:${event.data.reportId}`;
  // Deleted after an hour if nobody closes it. Opening it again changes nothing.
  await step.run("open", () => flow.streams.open(streamId, { meta: { reportId: event.data.reportId }, ttl: "1h" }));
  for (const part of ["intro", "body", "summary"]) {
    await step.run(`write ${part}`, async () => {
      const text = await writePart(part);
      return flow.streams.append(streamId, [{ part, text }]); // the new offsets
    });
  }
  // The end item is the last item. The stream is deleted 10 minutes later.
  await step.run("close", () => flow.streams.close(streamId, { end: { done: true }, grace: "10m" }));
});
// #endregion write

const app = express();
app.use("/api/flow", serve({ client: flow, functions: [writeReport] }));

// #region token
// Your own route. Check that this user may see this report first.
app.get("/api/reports/:id/stream-token", async (req, res) => {
  if (!(await userMaySee(req.get("Authorization"), req.params.id))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  res.json(await flow.streams.token(`report:${req.params.id}`));
});
// #endregion token

app.listen(Number(process.env.PORT ?? 3000));

export async function follow(reportId: string, after?: string) {
  // #region read
  // On a server: every item after `after`, then new ones, until the end item.
  // It throws StreamGoneError when the stream does not exist.
  for await (const { offset, item, end } of flow.streams.read(`report:${reportId}`, { ...(after ? { after } : {}) })) {
    console.log(offset, item);
    if (end) console.log("done"); // the loop ends after the end item
  }
  // #endregion read

  // #region snapshot
  // What is there now, without following. Null when the stream is gone.
  const now = await flow.streams.snapshot(`report:${reportId}`);
  console.log(now ? `${now.items.length} items, ended: ${now.ended}` : "gone");
  // #endregion snapshot
}

// ---- Stand-ins for your own code. ----

async function writePart(part: string): Promise<string> {
  return `the ${part}`;
}

async function userMaySee(authorization: string | undefined, reportId: string): Promise<boolean> {
  return authorization !== undefined && reportId.length > 0; // check your session here
}
