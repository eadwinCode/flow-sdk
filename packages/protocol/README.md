# @clevix/protocol

The wire protocol shared by the clevix-worker engine and the SDKs: types, request
signing, IDs and durations. Apps do not need it; `@clevix/flow` has its own copy
built in. The engine installs it from the `.tgz` on each
[release](https://github.com/eadwinCode/flow-sdk/releases). See
[docs/protocol.md](../../docs/protocol.md).
