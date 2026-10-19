// Package flow is the Go SDK for clevix-worker, a durable workflow engine on
// Cloudflare. Its API follows Inngest's inngestgo.
//
// Make a client with NewClient, add functions with CreateFunction, and serve
// them with client.Serve(), which returns an http.Handler for your app's one
// endpoint (for example /api/flow). Steps are in the step package, parallel
// steps in the group package.
package flow

import (
	"time"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// Version is this SDK's version, sent in the manifest.
const Version = "0.4.0"

// Event is an event to send with client.Send or step.Send.
type Event = core.Event

// StepError is what a step returns when its stored result is an error.
type StepError = core.StepError

// NoRetryError wraps err so it is not retried. Returned from a step.Run
// callback, the step fails at once. Returned from the handler, the run fails
// at once.
func NoRetryError(err error) error { return core.NoRetryErr(err) }

// RetryAtError wraps err so the next attempt runs at the given time.
func RetryAtError(err error, at time.Time) error { return &core.RetryAt{Err: err, At: at} }

// StrPtr returns a pointer to s.
func StrPtr(s string) *string { return &s }

// IntPtr returns a pointer to i.
func IntPtr(i int) *int { return &i }

// BoolPtr returns a pointer to b.
func BoolPtr(b bool) *bool { return &b }
