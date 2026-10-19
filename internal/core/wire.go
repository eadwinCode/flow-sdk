// Package core holds the parts shared by the flow, step and group packages:
// the wire types, the replay state of one call, and the error types.
// Users never import it; the public packages re-export what they need.
package core

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Header names, as in packages/protocol/src/types.ts (HEADERS).
const (
	HeaderSignature  = "X-Inngest-Signature"
	HeaderNoRetry    = "X-Inngest-No-Retry"
	HeaderRetryAfter = "Retry-After"
)

// HTTP status codes of the app endpoint (STATUS in types.ts).
const (
	StatusDone = 200
	StatusOps  = 206
)

// MaxOutputBytes is the largest step output the engine keeps (4 MB).
const MaxOutputBytes = 4_000_000

// SerializedError is an error as it travels on the wire.
type SerializedError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
}

// Event is an event to send: to POST /e, or from step.Send.
type Event struct {
	Name string `json:"name"`
	Data any    `json:"data,omitempty"`
	// ID makes the event idempotent: two events with the same ID are one event.
	ID *string `json:"id,omitempty"`
	// Timestamp is when the event happened, in ms since epoch. A future time
	// schedules the run. Zero means now.
	Timestamp int64 `json:"ts,omitempty"`
	User      any   `json:"user,omitempty"`
}

// MemoEntry is a finished step: either Data or Error is set.
type MemoEntry struct {
	Data  json.RawMessage
	Error *SerializedError
}

// UnmarshalJSON reads { data } or { error }. A missing data means null.
func (m *MemoEntry) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if e, ok := raw["error"]; ok && string(e) != "null" {
		var se SerializedError
		if err := json.Unmarshal(e, &se); err != nil {
			return err
		}
		m.Error = &se
		return nil
	}
	if d, ok := raw["data"]; ok {
		m.Data = d
	} else {
		m.Data = json.RawMessage("null")
	}
	return nil
}

// InvokeRequest is the body of the signed POST from the engine.
type InvokeRequest struct {
	FnID         string               `json:"fnId"`
	RunID        string               `json:"runId"`
	Event        json.RawMessage      `json:"event"`
	Events       []json.RawMessage    `json:"events"`
	Memo         map[string]MemoEntry `json:"memo"`
	Attempt      int                  `json:"attempt"`
	MaxAttempts  int                  `json:"maxAttempts"`
	TargetStepID string               `json:"targetStepId,omitempty"`
	// UseAPI means the state was too big to send: Memo and Events are empty,
	// and the SDK loads them from GET {base}/runs/{runId}/state.
	UseAPI bool `json:"useApi,omitempty"`
}

// LoadedMemoEntry is a memo entry from the run state API. It has the same
// { data } or { error } shape as MemoEntry.
type LoadedMemoEntry = MemoEntry

// RunStatePage is one page of GET {base}/runs/{runId}/state.
type RunStatePage struct {
	// Events is the run's batch. Only on the first page.
	Events []json.RawMessage          `json:"events,omitempty"`
	Memo   map[string]LoadedMemoEntry `json:"memo"`
	// Next is the cursor for the next page; nil on the last page.
	Next *string `json:"next"`
}

// Opcode is one step the SDK reports back. Op says which fields are used.
type Opcode struct {
	Op   string `json:"op"`
	ID   string `json:"id"`
	Name string `json:"name"`

	// StepCompleted. Always sent for StepCompleted (null when empty).
	Data json.RawMessage `json:"data,omitempty"`

	// StepFailed.
	Error   *SerializedError `json:"error,omitempty"`
	NoRetry bool             `json:"noRetry,omitempty"`
	RetryAt *int64           `json:"retryAt,omitempty"`

	// Sleep: ms since epoch.
	Until *int64 `json:"until,omitempty"`

	// WaitForEvent.
	Event   string  `json:"event,omitempty"`
	Timeout any     `json:"timeout,omitempty"`
	Match   *string `json:"match,omitempty"`
	If      *string `json:"if,omitempty"`

	// SendEvent.
	Events []Event `json:"events,omitempty"`

	// InvokeFunction. Function is the full "<appId>-<functionId>". Timeout is shared
	// with WaitForEvent above.
	Function string          `json:"function,omitempty"`
	User     json.RawMessage `json:"user,omitempty"`
}

// Opcode names.
const (
	OpStepCompleted  = "StepCompleted"
	OpStepFailed     = "StepFailed"
	OpStepPlanned    = "StepPlanned"
	OpSleep          = "Sleep"
	OpWaitForEvent   = "WaitForEvent"
	OpSendEvent      = "SendEvent"
	OpInvokeFunction = "InvokeFunction"
)

// Duration turns a Go duration into the engine's text form: "<n>s" when it is
// whole seconds, else "<n>ms". parseDuration in packages/protocol reads both.
// Anything under a millisecond is dropped.
func Duration(d time.Duration) string {
	if d%time.Second == 0 {
		return strconv.FormatInt(int64(d/time.Second), 10) + "s"
	}
	return strconv.FormatInt(d.Milliseconds(), 10) + "ms"
}

// DurationPtr is Duration for an optional value: nil or zero gives nil.
func DurationPtr(d *time.Duration) *string {
	if d == nil || *d == 0 {
		return nil
	}
	s := Duration(*d)
	return &s
}

// Decode reads stored step data into T. A JSON null leaves the zero value.
func Decode[T any](data json.RawMessage) (T, error) {
	var out T
	if len(data) == 0 || string(data) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, fmt.Errorf("flow: cannot read stored step data into %T: %w", out, err)
	}
	return out, nil
}
