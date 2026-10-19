# Changelog

## v0.2.0

- **New signing key format: `signkey-<64 hex>`.** The engine no longer has
  environments, so keys no longer carry one (was `signkey-<env>-<64 hex>`).
  Both SDKs refuse the old format, and SDK v0.1.0 refuses the new one.
  Upgrade an app together with its new `FLOW_SIGNING_KEY`, made in the
  dashboard of an engine that has this change.
- The sync answer has no `env` field.
- The SDK code now lives in this repo. `@clevix/protocol` is released here too,
  for the engine.

## v0.1.0

- First release: the Go SDK and `@clevix/flow`.
