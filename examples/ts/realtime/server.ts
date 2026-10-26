// Realtime: a function sends progress to the browser while it runs.
// Run: node realtime/server.ts
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine). The engine needs
// realtime turned on (REALTIME_TOKEN_SECRET).
import express from "express";
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/express";

const flow = new Flow({ id: "sites" });

// #region publish
const buildSite = flow.createFunction(
  { id: "build-site" },
  { event: "site/build-requested" },
  async ({ event, step }) => {
    const channel = `deployment:${event.data.deploymentId}`;

    // A failed publish must not fail the step: log it and go on.
    const progress = (pct: number, label: string) =>
      flow.realtime
        .publish({ channel, topic: "progress", data: { pct, label } })
        .catch((err) => console.warn("realtime publish failed", err));

    await step.run("render", async () => {
      await progress(10, "Rendering");
      return render(event.data.deploymentId);
    });
    await step.run("upload", async () => {
      await progress(60, "Uploading");
      return upload(event.data.deploymentId);
    });

    // After the last step, this runs only on the run's last call. So it is sent
    // once, unless that call fails and the engine tries it again.
    await progress(100, "Done");
  },
);
// #endregion publish

const app = express();
app.use("/api/flow", serve({ client: flow, functions: [buildSite] }));

// #region token
// Your own route. Check that this user may see this deployment first: the engine
// does not know your users.
app.get("/api/deployments/:id/realtime-token", async (req, res) => {
  if (!(await userMaySee(req.get("Authorization"), req.params.id))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const token = await flow.realtime.token({
    channel: `deployment:${req.params.id}`,
    topics: ["progress"],
  });
  res.json(token);
});
// #endregion token

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));

// ---- Stand-ins for your own code. ----

async function userMaySee(authorization: string | undefined, deploymentId: string): Promise<boolean> {
  return authorization !== undefined && deploymentId.length > 0; // check your session here
}

async function render(deploymentId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(`rendered ${deploymentId}`);
}

async function upload(deploymentId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(`uploaded ${deploymentId}`);
}
