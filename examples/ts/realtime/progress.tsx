// Realtime in React, with the useRealtime hook from `@clevix/flow/react`.
import { useRealtime, type RealtimeToken } from "@clevix/flow/react";

// #region hook
type Progress = { pct: number; label: string };

export function DeployProgress({ deploymentId, building }: { deploymentId: string; building: boolean }) {
  const { latest, state, error } = useRealtime<Progress>({
    channel: `deployment:${deploymentId}`, // a new channel drops old messages and connects again
    enabled: building, // false closes the socket
    refreshToken: async () => {
      const res = await fetch(`/api/deployments/${deploymentId}/realtime-token`);
      if (!res.ok) throw new Error(`token route answered ${res.status}`);
      return (await res.json()) as RealtimeToken;
    },
  });

  if (error) return <p>Live updates are off: {error.message}</p>;
  if (!latest) return <p>{state === "open" ? "Waiting for the build..." : "Connecting..."}</p>;
  return (
    <p>
      {latest.data.label}: {latest.data.pct}%
    </p>
  );
}
// #endregion hook
