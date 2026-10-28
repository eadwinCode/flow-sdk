// Read a stream in the browser. `@clevix/flow/realtime` has no server code.
// It also runs in Node 22 and later, which has a global WebSocket:
//   node streams/browser.ts <reportId> [after]
import { readStream, type StreamToken } from "@clevix/flow/realtime";

const base = process.env.APP_URL ?? "http://127.0.0.1:3000";
const reportId = process.argv[2] ?? "r_1";
// The last offset the page showed, e.g. kept in sessionStorage. None: from the start.
const after = process.argv[3];

// #region read-stream
// Pass the last offset you showed as `after`, so a reload starts where it left off.
// After a dropped connection, readStream itself goes on from the last item it gave.
const stop = readStream<{ part: string; text: string }>({
  // Called before every connect: ask your own route for a new token.
  refreshToken: async () => {
    const res = await fetch(`${base}/api/reports/${reportId}/stream-token`, {
      headers: { Authorization: "Bearer your-session" },
    });
    if (!res.ok) throw new Error(`token route answered ${res.status}`);
    return (await res.json()) as StreamToken;
  },
  ...(after ? { after } : {}),
  onItem: ({ offset, item }) => console.log(offset, item), // keep `offset` for a reload
  onEnd: () => console.log("done"),
  onGone: () => console.log("the stream is gone: load the report from your server"),
  onState: (state) => console.log("state:", state),
});
// #endregion read-stream

setTimeout(stop, 60_000);
