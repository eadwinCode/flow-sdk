// Package group runs steps in parallel.
package group

import (
	"context"
	"errors"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// Result is what one parallel function returned.
type Result struct {
	Value any
	Error error
}

// Results holds one Result per function, in order.
type Results []Result

// AnyError joins the errors of all results (nil if none failed).
func (rs Results) AnyError() error {
	var errs []error
	for _, r := range rs {
		if r.Error != nil {
			errs = append(errs, r.Error)
		}
	}
	return errors.Join(errs...)
}

// Parallel runs fns as parallel steps. Each fn runs until its first new step.
// When new steps are found, the engine gets them all at once: step.Run calls
// are planned and then run one per request, at the same time; other steps
// (sleep, wait, invoke, send) start at once. Parallel returns only when every
// fn has finished; until then it stops the function like any other new step.
//
// The fns run one after another in this goroutine, so step IDs are counted
// the same way on every call. Give each step in the group its own ID.
func Parallel(ctx context.Context, fns ...func(ctx context.Context) (any, error)) Results {
	r := core.FromContext(ctx)
	results := make(Results, len(fns))
	if r == nil {
		// Not in a flow function: just run them.
		for i, fn := range fns {
			v, err := fn(ctx)
			results[i] = Result{Value: v, Error: err}
		}
		return results
	}
	nested := core.InParallel(ctx)
	pctx := core.WithParallel(ctx)
	stopped := false
	for i, fn := range fns {
		if runBranch(pctx, fn, &results[i]) {
			stopped = true
		}
	}
	if !stopped {
		return results
	}
	if nested {
		core.StopBranch()
	}
	r.RunIfAlone()
	core.StopRun()
	return nil // not reached
}

// runBranch runs one fn and reports whether it stopped at a new step.
func runBranch(ctx context.Context, fn func(ctx context.Context) (any, error), out *Result) (stopped bool) {
	defer func() {
		if rec := recover(); rec != nil {
			if core.IsBranchStop(rec) {
				stopped = true
				return
			}
			panic(rec) // a full stop, or a real panic
		}
	}()
	v, err := fn(ctx)
	*out = Result{Value: v, Error: err}
	return false
}
