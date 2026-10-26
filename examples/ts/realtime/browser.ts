// Realtime in the browser, without React. `@clevix/flow/realtime` has no server code.
// It also runs in Node 22 and later, which has a global WebSocket:
//   node realtime/browser.ts <deploymentId>
import { subscribe, type RealtimeToken } from "@clevix/flow/realtime";

const base = process.env.APP_URL ?? "http://127.0.0.1:3000";
const deploymentId = process.argv[2] ?? "dep_1";

// #region subscribe
const stop = subscribe<{ pct: number; label: string }>({
  // Called before every connect: ask your own route for a new token.
  refreshToken: async () => {
    const res = await fetch(`${base}/api/deployments/${deploymentId}/realtime-token`, {
      headers: { Authorization: "Bearer your-session" },
    });
    if (!res.ok) throw new Error(`token route answered ${res.status}`);
    return (await res.json()) as RealtimeToken;
  },
  onMessage: (m) => {
    console.log(`${m.topic}: ${m.data.pct}% ${m.data.label}`);
    if (m.data.pct === 100) stop();
  },
  onState: (state) => console.log("state:", state), // connecting, open, closed, error
});
// #endregion subscribe
