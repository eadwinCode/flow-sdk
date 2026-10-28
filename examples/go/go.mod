// The Go code the docs show. A module of its own, so the SDK's own module and its
// `go vet ./...` and `go test ./...` do not include it. The replace line builds it
// against the SDK in this repo, so the docs always match the code.
module github.com/eadwinCode/flow-sdk/examples/go

go 1.27

require github.com/eadwinCode/flow-sdk v0.0.0

require github.com/coder/websocket v1.8.15 // indirect

replace github.com/eadwinCode/flow-sdk => ../..
