// Sending events from your own code: one, a list, once only, and for later.
// Run: node send-events.ts
// Needs FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine). No server needed.
import { Flow } from "@clevix/flow";

const flow = new Flow({ id: "shop" });

// #region one
// One event. The answer holds the ID the engine gave it.
const { ids } = await flow.send({
  name: "order/paid",
  data: { orderId: "o_123", total: 4200 },
});
console.log("one event:", ids);
// #endregion one

// #region many
// Up to 100 events in one request. All are taken, or none.
const many = await flow.send([
  { name: "user/signed-up", data: { userId: "u_1" } },
  { name: "user/signed-up", data: { userId: "u_2" } },
]);
console.log("two events:", many.ids);
// #endregion many

// #region once
// The same `id` twice: the engine sees one event, with one event ID.
const paymentId = "pi_3Nx";
const first = await flow.send({ id: `payment-${paymentId}`, name: "order/paid", data: { orderId: "o_124" } });
const again = await flow.send({ id: `payment-${paymentId}`, name: "order/paid", data: { orderId: "o_124" } });
console.log("sent twice:", first.ids[0], again.ids[0]);
// #endregion once

// #region later
// `ts` in the future: the runs are made now and start at that time.
const inAMinute = Date.now() + 60_000;
const later = await flow.send({ name: "cart/reminder", data: { cartId: "c_9" }, ts: inAMinute });
console.log("for later:", later.ids);
// #endregion later

// #region error
// A bad event fails the whole request with an Error that holds the engine's answer.
try {
  await flow.send({ name: "inngest/anything" });
} catch (err) {
  console.log("refused:", err instanceof Error ? err.message : err);
}
// #endregion error
