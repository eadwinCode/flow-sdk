package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// idRE is the rule for app and function IDs.
var idRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

// Trigger starts a function: an event (with an optional "if" expression) or a
// cron schedule. Make one with EventTrigger or CronTrigger.
type Trigger struct {
	Event string  `json:"event,omitempty"`
	If    *string `json:"if,omitempty"`
	Cron  string  `json:"cron,omitempty"`
}

// EventTrigger runs the function for each event with this name. expr is an
// optional "if" expression over event, for example "event.data.plan == 'pro'".
func EventTrigger(name string, expr *string) Trigger { return Trigger{Event: name, If: expr} }

// CronTrigger runs the function on a cron schedule, for example
// "0 2 * * *" or "TZ=Africa/Lagos 0 2 * * *".
func CronTrigger(cron string) Trigger { return Trigger{Cron: cron} }

// Triggerable is a Trigger or MultipleTriggers.
type Triggerable interface{ triggers() []Trigger }

func (t Trigger) triggers() []Trigger { return []Trigger{t} }

// MultipleTriggers starts a function from any of several triggers.
type MultipleTriggers []Trigger

func (m MultipleTriggers) triggers() []Trigger { return m }

// Concurrency limits how many steps of the function run at once. Key is an
// expression over event; Scope is "fn" (default), "env" or "account".
type Concurrency struct {
	Limit int     `json:"limit"`
	Key   *string `json:"key,omitempty"`
	Scope string  `json:"scope,omitempty"`
}

// CancelOn cancels a run when a matching event arrives.
type CancelOn struct {
	Event string
	// Match is a field path in both events, for example "data.orderId".
	Match *string
	// If is an expression over event (the trigger) and async (the new event).
	If *string
	// Timeout stops listening after this long. Zero means as long as the run lives.
	Timeout time.Duration
}

// Throttle delays runs over Limit per Period (plus Burst).
type Throttle struct {
	Limit  int
	Period time.Duration
	Burst  int
	Key    *string
}

// RateLimit drops events over Limit per Period.
type RateLimit struct {
	Limit  int
	Period time.Duration
	Key    *string
}

// Debounce waits for Period of quiet before running, with the last event.
// Timeout is the longest it may wait in all (zero: no limit).
type Debounce struct {
	Period  time.Duration
	Key     *string
	Timeout time.Duration
}

// BatchEvents runs the function with up to MaxSize events, or after Timeout.
type BatchEvents struct {
	MaxSize int
	Timeout time.Duration
	Key     *string
	If      *string
}

// Priority orders waiting runs. Run is an expression giving a boost in
// seconds (-600 to 600).
type Priority struct {
	Run *string `json:"run,omitempty"`
}

// Singleton keeps one active run per key. Mode is "skip" or "cancel".
type Singleton struct {
	Key  *string `json:"key,omitempty"`
	Mode string  `json:"mode"`
}

// Timeouts sets time limits. Step is the longest one step's HTTP call may take.
type Timeouts struct {
	Step time.Duration
}

// FunctionOpts configures a function. Only ID is required.
//
// Durations are sent to the engine as "<n>s" when they are whole seconds,
// else as "<n>ms".
type FunctionOpts struct {
	ID          string
	Name        string
	Retries     *int
	Timeouts    *Timeouts
	CancelOn    []CancelOn
	Concurrency []Concurrency
	Throttle    *Throttle
	RateLimit   *RateLimit
	Debounce    *Debounce
	BatchEvents *BatchEvents
	Priority    *Priority
	// Idempotency is an expression over event; one run per value.
	Idempotency *string
	Singleton   *Singleton
}

// FunctionConfig is one function in the manifest, with Inngest's key names.
type FunctionConfig struct {
	ID          string           `json:"id"`
	Name        string           `json:"name,omitempty"`
	Triggers    []Trigger        `json:"triggers"`
	Retries     *int             `json:"retries,omitempty"`
	Timeouts    *timeoutsJSON    `json:"timeouts,omitempty"`
	CancelOn    []cancelOnJSON   `json:"cancelOn,omitempty"`
	Concurrency []Concurrency    `json:"concurrency,omitempty"`
	Throttle    *throttleJSON    `json:"throttle,omitempty"`
	RateLimit   *rateLimitJSON   `json:"rateLimit,omitempty"`
	Debounce    *debounceJSON    `json:"debounce,omitempty"`
	BatchEvents *batchEventsJSON `json:"batchEvents,omitempty"`
	Priority    *Priority        `json:"priority,omitempty"`
	Idempotency *string          `json:"idempotency,omitempty"`
	Singleton   *Singleton       `json:"singleton,omitempty"`
}

type timeoutsJSON struct {
	Step *string `json:"step,omitempty"`
}

type cancelOnJSON struct {
	Event   string  `json:"event"`
	Match   *string `json:"match,omitempty"`
	If      *string `json:"if,omitempty"`
	Timeout *string `json:"timeout,omitempty"`
}

type throttleJSON struct {
	Limit  int     `json:"limit"`
	Period string  `json:"period"`
	Burst  int     `json:"burst,omitempty"`
	Key    *string `json:"key,omitempty"`
}

type rateLimitJSON struct {
	Limit  int     `json:"limit"`
	Period string  `json:"period"`
	Key    *string `json:"key,omitempty"`
}

type debounceJSON struct {
	Period  string  `json:"period"`
	Key     *string `json:"key,omitempty"`
	Timeout *string `json:"timeout,omitempty"`
}

type batchEventsJSON struct {
	MaxSize int     `json:"maxSize"`
	Timeout string  `json:"timeout"`
	Key     *string `json:"key,omitempty"`
	If      *string `json:"if,omitempty"`
}

func buildConfig(opts FunctionOpts, triggers []Trigger) FunctionConfig {
	c := FunctionConfig{
		ID:          opts.ID,
		Name:        opts.Name,
		Triggers:    triggers,
		Retries:     opts.Retries,
		Concurrency: opts.Concurrency,
		Priority:    opts.Priority,
		Idempotency: opts.Idempotency,
		Singleton:   opts.Singleton,
	}
	if opts.Timeouts != nil {
		c.Timeouts = &timeoutsJSON{Step: core.DurationPtr(&opts.Timeouts.Step)}
	}
	for _, co := range opts.CancelOn {
		c.CancelOn = append(c.CancelOn, cancelOnJSON{
			Event: co.Event, Match: co.Match, If: co.If, Timeout: core.DurationPtr(&co.Timeout),
		})
	}
	if t := opts.Throttle; t != nil {
		c.Throttle = &throttleJSON{Limit: t.Limit, Period: core.Duration(t.Period), Burst: t.Burst, Key: t.Key}
	}
	if r := opts.RateLimit; r != nil {
		c.RateLimit = &rateLimitJSON{Limit: r.Limit, Period: core.Duration(r.Period), Key: r.Key}
	}
	if d := opts.Debounce; d != nil {
		c.Debounce = &debounceJSON{Period: core.Duration(d.Period), Key: d.Key, Timeout: core.DurationPtr(&d.Timeout)}
	}
	if b := opts.BatchEvents; b != nil {
		c.BatchEvents = &batchEventsJSON{MaxSize: b.MaxSize, Timeout: core.Duration(b.Timeout), Key: b.Key, If: b.If}
	}
	return c
}

// GenericEvent is an event a function receives, with typed data.
type GenericEvent[T any] struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Data      T      `json:"data"`
	Timestamp int64  `json:"ts"`
	User      any    `json:"user,omitempty"`
}

// InputCtx says which run and attempt this is.
type InputCtx struct {
	Env        string
	FunctionID string
	RunID      string
	// Attempt counts from 0.
	Attempt     int
	MaxAttempts int
}

// Input is what a handler gets: the trigger event, the batch (one item unless
// batching) and the run details.
type Input[T any] struct {
	Event    GenericEvent[T]
	Events   []GenericEvent[T]
	InputCtx InputCtx
}

// Handler is a function's code.
type Handler[T any] func(ctx context.Context, input Input[T]) (any, error)

// ServableFunction is a function made by CreateFunction.
type ServableFunction interface {
	// ID is the function ID without the app prefix.
	ID() string
	// FullyQualifiedID is "<appId>-<id>", used by step.Invoke and in
	// inngest/function.failed events.
	FullyQualifiedID() string
	// Config is the function's manifest entry.
	Config() FunctionConfig

	call(ctx context.Context, req *core.InvokeRequest) (any, error)
}

type function struct {
	appID  string
	config FunctionConfig
	run    func(ctx context.Context, req *core.InvokeRequest) (any, error)
}

func (f *function) ID() string               { return f.config.ID }
func (f *function) FullyQualifiedID() string { return f.appID + "-" + f.config.ID }
func (f *function) Config() FunctionConfig   { return f.config }
func (f *function) call(ctx context.Context, req *core.InvokeRequest) (any, error) {
	return f.run(ctx, req)
}

// CreateFunction defines a function and adds it to the client.
//
// For failure handling (onFailure in TypeScript), create a second function
// with trigger EventTrigger("inngest/function.failed",
// StrPtr("event.data.function_id == '<appId>-<id>'")). Its event data holds
// function_id, run_id, error and event (the original trigger event).
func CreateFunction[T any](c *Client, opts FunctionOpts, trigger Triggerable, handler Handler[T]) (ServableFunction, error) {
	if c == nil {
		return nil, errors.New("flow: CreateFunction needs a client")
	}
	if !idRE.MatchString(opts.ID) {
		return nil, fmt.Errorf("flow: invalid function id %q (letters, digits, _ and -, up to 64)", opts.ID)
	}
	if trigger == nil || len(trigger.triggers()) == 0 {
		return nil, fmt.Errorf("flow: function %s needs at least one trigger", opts.ID)
	}
	if handler == nil {
		return nil, fmt.Errorf("flow: function %s needs a handler", opts.ID)
	}
	fn := &function{appID: c.appID, config: buildConfig(opts, trigger.triggers())}
	fn.run = func(ctx context.Context, req *core.InvokeRequest) (any, error) {
		var input Input[T]
		if err := json.Unmarshal(req.Event, &input.Event); err != nil {
			return nil, core.NoRetryErr(fmt.Errorf("flow: cannot read the event into %T: %w", input.Event.Data, err))
		}
		for _, raw := range req.Events {
			var e GenericEvent[T]
			if err := json.Unmarshal(raw, &e); err != nil {
				return nil, core.NoRetryErr(fmt.Errorf("flow: cannot read an event into %T: %w", e.Data, err))
			}
			input.Events = append(input.Events, e)
		}
		input.InputCtx = InputCtx{
			Env: req.Env, FunctionID: fn.FullyQualifiedID(), RunID: req.RunID,
			Attempt: req.Attempt, MaxAttempts: req.MaxAttempts,
		}
		return handler(ctx, input)
	}
	if err := c.add(fn); err != nil {
		return nil, err
	}
	return fn, nil
}
