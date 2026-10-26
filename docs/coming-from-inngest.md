# Coming from Inngest

You do not need to know Inngest to use Clevix Flow. This page is only for readers who
do. The SDKs' API follows Inngest's (`inngest` for TypeScript, `inngestgo` for Go),
and the engine reads function options in Inngest's names and shapes. What is
different here:

- **Package and names.** `new Flow({ id })` and `@clevix/flow` (TypeScript),
  `flow.NewClient(flow.ClientOpts{AppID})` and `github.com/eadwinCode/flow-sdk` (Go).
  `flow.send`, `flow.createFunction`, and the `step` tools keep their usual names.
- **Settings** are `FLOW_SIGNING_KEY`, `FLOW_SIGNING_KEY_FALLBACK`, `FLOW_EVENT_KEY`,
  `FLOW_BASE_URL` and `FLOW_DEV`. See [Settings](settings.md).
- **Each app has its own signing key**, made in **Add app**. An app's key can not sync
  another app or read its runs.
- **No hosted webhook URL.** The engine's only event intake is `POST /e` with your
  event key, in its own event shape. See [Webhooks and events](webhooks.md).
- **One engine is one environment.** A concurrency `scope` of `"env"` means the same
  as `"account"`: the whole workspace.
- **Expressions** are a small part of CEL, with no regular expressions. See
  [Expressions](functions.md#expressions).
- **Unknown options are refused** at sync (`unknown option "retry"`), and so is an
  `if` on a cron trigger.
- **Go has no `onFailure` option.** Make a function on `inngest/function.failed`.
  See [Errors and retries](errors.md#when-a-run-fails-for-good).
- **Wire names stay.** The signature header is `X-Inngest-Signature`, and the
  engine's own events are named `inngest/scheduled.timer`, `inngest/function.failed`,
  `inngest/function.cancelled` and `inngest/function.invoked`. You can not send
  events whose names start with `inngest/`.
