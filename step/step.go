// Package step has the durable steps a flow function calls: Run, Sleep,
// SleepUntil, WaitForEvent, Invoke and Send.
//
// How replay works: the engine calls the function from the top on every
// request, with the results of finished steps (the memo). A step that is in
// the memo returns its stored result at once. A step that is new is run (for
// Run) or reported to the engine (the others), and then the SDK stops the
// function with a special panic that client.Serve() recovers.
//
// So do not swallow that panic. If you recover() around step calls, call
// Repanic first:
//
//	defer func() {
//		if r := recover(); r != nil {
//			step.Repanic(r) // lets the SDK stop the function
//			// ... your own handling
//		}
//	}()
//
// Step IDs must be stable between calls. The same ID used again (in a loop)
// is fine: repeats get ":1", ":2", ... added before hashing. Inside
// group.Parallel, give each step its own ID.
//
// Do not call steps from goroutines you start yourself; use group.Parallel.
package step

import (
	"context"
	"encoding/json"
	"errors"
	"runtime/debug"
	"time"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// StepError is returned by a step whose stored result is an error: the step
// ran out of retries, or an invoked function failed. Check for it with
// errors.As to run compensation steps.
type StepError = core.StepError

// ErrEventNotReceived is returned by WaitForEvent when the wait timed out.
var ErrEventNotReceived = errors.New("flow: event not received before the timeout")

// ErrNotInFunction is returned by step calls made outside a flow function or
// inside another step's callback.
var ErrNotInFunction = core.ErrNotInFunction

// Repanic panics again with r if r is the SDK's control panic. Call it first
// in any recover() that can catch step calls.
func Repanic(r any) {
	if core.IsControl(r) {
		panic(r)
	}
}

// IsControlPanic reports whether a recovered value is the SDK's control panic.
func IsControlPanic(r any) bool { return core.IsControl(r) }

// IdempotencyKey returns "<runId>:<hashed step id>" inside a Run callback. It
// is the same on every attempt, so pass it to outside APIs that take one.
// It is empty outside a Run callback.
func IdempotencyKey(ctx context.Context) string { return core.IdempotencyKeyFrom(ctx) }

func fromMemo[T any](e *core.MemoEntry) (T, error) {
	if e.Error != nil {
		var zero T
		return zero, &StepError{Name: e.Error.Name, Message: e.Error.Message, Stack: e.Error.Stack}
	}
	return core.Decode[T](e.Data)
}

// Run runs fn once, keeps its result, and returns the kept result on replay.
// If fn returns an error, the step fails and the engine retries it (wrap the
// error with flow.NoRetryError or flow.RetryAtError to change that). When the
// step is out of retries, Run returns a *StepError.
func Run[T any](ctx context.Context, id string, fn func(ctx context.Context) (T, error)) (T, error) {
	var zero T
	r := core.FromContext(ctx)
	if r == nil {
		return zero, ErrNotInFunction
	}
	h, e := r.Next(id)
	if e != nil {
		return fromMemo[T](e)
	}
	exec := func() (op core.Opcode) {
		// A panic in the callback is a failed attempt of this step, like a thrown error
		// in the TypeScript SDK: the engine retries the step, not the whole call.
		defer func() {
			if rec := recover(); rec != nil {
				if core.IsControl(rec) {
					panic(rec)
				}
				op = core.RunStep(h, id, nil, &core.PanicError{Value: rec, Stack: string(debug.Stack())})
			}
		}()
		v, err := fn(r.StepContext(ctx, h))
		return core.RunStep(h, id, v, err)
	}
	r.New(ctx, core.Opcode{Op: core.OpStepPlanned, ID: h, Name: id}, exec)
	return zero, nil // not reached
}

// Sleep pauses the function for d.
func Sleep(ctx context.Context, id string, d time.Duration) error {
	r := core.FromContext(ctx)
	if r == nil {
		return ErrNotInFunction
	}
	h, e := r.Next(id)
	if e != nil {
		_, err := fromMemo[any](e)
		return err
	}
	// Computed only for a new step: the memo decides replay.
	until := r.Now().Add(d).UnixMilli()
	r.New(ctx, core.Opcode{Op: core.OpSleep, ID: h, Name: id, Until: &until}, nil)
	return nil
}

// SleepUntil pauses the function until t.
func SleepUntil(ctx context.Context, id string, t time.Time) error {
	r := core.FromContext(ctx)
	if r == nil {
		return ErrNotInFunction
	}
	h, e := r.Next(id)
	if e != nil {
		_, err := fromMemo[any](e)
		return err
	}
	until := t.UnixMilli()
	r.New(ctx, core.Opcode{Op: core.OpSleep, ID: h, Name: id, Until: &until}, nil)
	return nil
}

// WaitForEventOpts says which event to wait for.
type WaitForEventOpts struct {
	// Event is the name of the event to wait for.
	Event string
	// Timeout is how long to wait. Required.
	Timeout time.Duration
	// Match is a field path in both events, for example "data.userId".
	Match *string
	// If is an expression over event (the trigger) and async (the new event).
	If *string
}

// WaitForEvent waits for an event and returns it. T is the event type, for
// example flow.GenericEvent[MyData]. On timeout it returns ErrEventNotReceived.
func WaitForEvent[T any](ctx context.Context, id string, opts WaitForEventOpts) (T, error) {
	var zero T
	r := core.FromContext(ctx)
	if r == nil {
		return zero, ErrNotInFunction
	}
	h, e := r.Next(id)
	if e != nil {
		if e.Error == nil && (len(e.Data) == 0 || string(e.Data) == "null") {
			return zero, ErrEventNotReceived
		}
		return fromMemo[T](e)
	}
	r.New(ctx, core.Opcode{
		Op: core.OpWaitForEvent, ID: h, Name: id,
		Event: opts.Event, Timeout: core.Duration(opts.Timeout), Match: opts.Match, If: opts.If,
	}, nil)
	return zero, nil
}

// InvokeOpts says which function to call.
type InvokeOpts struct {
	// FunctionID is the full ID "<appId>-<functionId>". It can be in another
	// app, in any language.
	FunctionID string
	// Data becomes the child's event data.
	Data any
	// User becomes the child's event user field.
	User any
	// Timeout stops waiting after this long; the step then fails with
	// InvokeTimeout. Zero means no timeout.
	Timeout time.Duration
}

// Invoke calls another flow function and returns its output. If the child
// fails, Invoke returns a *StepError.
func Invoke[T any](ctx context.Context, id string, opts InvokeOpts) (T, error) {
	var zero T
	r := core.FromContext(ctx)
	if r == nil {
		return zero, ErrNotInFunction
	}
	h, e := r.Next(id)
	if e != nil {
		return fromMemo[T](e)
	}
	op := core.Opcode{Op: core.OpInvokeFunction, ID: h, Name: id, Function: opts.FunctionID}
	if opts.Data != nil {
		b, err := json.Marshal(opts.Data)
		if err != nil {
			return zero, err
		}
		op.Data = b
	}
	if opts.User != nil {
		b, err := json.Marshal(opts.User)
		if err != nil {
			return zero, err
		}
		op.User = b
	}
	if opts.Timeout > 0 {
		op.Timeout = core.Duration(opts.Timeout)
	}
	r.New(ctx, op, nil)
	return zero, nil
}

// Send sends one or more events from the function, once (not again on
// replay). It returns the event IDs.
func Send(ctx context.Context, id string, events ...core.Event) ([]string, error) {
	r := core.FromContext(ctx)
	if r == nil {
		return nil, ErrNotInFunction
	}
	h, e := r.Next(id)
	if e != nil {
		out, err := fromMemo[struct {
			IDs []string `json:"ids"`
		}](e)
		return out.IDs, err
	}
	if len(events) == 0 {
		return nil, errors.New("flow: step.Send needs at least one event")
	}
	r.New(ctx, core.Opcode{Op: core.OpSendEvent, ID: h, Name: id, Events: events}, nil)
	return nil, nil
}
