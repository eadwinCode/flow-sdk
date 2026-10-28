// Realtime on a server: follow channels without a browser.
// Run: node realtime/server-subscribe.ts (Node 22 and later have a global WebSocket)
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine).
import { Flow } from "@clevix/flow";

const flow = new Flow({ id: "sites" });

// #region server-subscribe
// It makes its own token before every connect, so you need no token route.
const stop = flow.realtime.subscribe<{ pct: number; label: string }>({
  channels: ["deployment:dep_1", "deployment:dep_2"], // or channel: "deployment:dep_1"
  topics: ["progress"],
  onMessage: (m) => console.log(`${m.channel} ${m.data.pct}% ${m.data.label}`),
  onState: (state) => {
    // Messages sent while it was not open are lost: read them from your own store.
    if (state === "open") void catchUp();
  },
});
// #endregion server-subscribe

// #region publish-many
await flow.realtime.publishMany([
  { channel: "deployment:dep_1", topic: "progress", data: { pct: 50, label: "Half" } },
  { channel: "deployment:dep_2", topic: "progress", data: { pct: 10, label: "Start" } },
]);
// #endregion publish-many

setTimeout(stop, 60_000);

// ---- Stand-ins for your own code. ----

async function catchUp(): Promise<void> {
  console.log("reading what we missed from the database");
}
