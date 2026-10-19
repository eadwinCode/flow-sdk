package core

import (
	"errors"
	"fmt"
	"time"
)

// StepError is what a step returns on replay when the memo holds { error }:
// the step ran out of retries (or a child function failed). The function can
// check for it with errors.As and run compensation steps.
type StepError struct {
	Name    string
	Message string
	Stack   string
}

func (e *StepError) Error() string {
	if e.Name == "" {
		return e.Message
	}
	return e.Name + ": " + e.Message
}

// NoRetry marks an error so it is not retried.
type NoRetry struct{ Err error }

// NoRetryErr wraps err so it is not retried.
func NoRetryErr(err error) error { return &NoRetry{Err: err} }

func (e *NoRetry) Error() string {
	if e.Err == nil {
		return "no retry"
	}
	return e.Err.Error()
}
func (e *NoRetry) Unwrap() error { return e.Err }

// RetryAt marks an error so the next attempt runs at At.
type RetryAt struct {
	Err error
	At  time.Time
}

func (e *RetryAt) Error() string {
	if e.Err == nil {
		return "retry at " + e.At.Format(time.RFC3339)
	}
	return e.Err.Error()
}
func (e *RetryAt) Unwrap() error { return e.Err }

// Serialize turns an error into its wire form. The name is the StepError's name
// when there is one, else "Error".
func Serialize(err error) SerializedError {
	if pe, ok := err.(*PanicError); ok {
		return SerializedError{Name: "Panic", Message: pe.Error(), Stack: pe.Stack}
	}
	if se, ok := err.(*StepError); ok && se.Name != "" {
		return SerializedError{Name: se.Name, Message: se.Message, Stack: se.Stack}
	}
	// Same names as the TypeScript SDK's error classes, so a parent run sees the
	// same error whichever language its child is written in.
	name := "Error"
	var se *StepError
	var nr *NoRetry
	var ra *RetryAt
	switch {
	case errors.As(err, &nr):
		name = "NonRetriableError"
	case errors.As(err, &ra):
		name = "RetryAfterError"
	case errors.As(err, &se) && se.Name != "":
		name = se.Name
	}
	return SerializedError{Name: name, Message: err.Error()}
}

// IsNoRetry reports whether err (or an error it wraps) is a NoRetry.
func IsNoRetry(err error) bool {
	var nr *NoRetry
	return errors.As(err, &nr)
}

// RetryTime returns the retry time of a RetryAt in err, if any.
func RetryTime(err error) (time.Time, bool) {
	var ra *RetryAt
	if errors.As(err, &ra) {
		return ra.At, true
	}
	return time.Time{}, false
}

// PanicError is a panic recovered from a step.Run callback. It fails that step's
// attempt (the step is retried), the same as an error thrown in a TypeScript step.
type PanicError struct {
	Value any
	Stack string
}

func (e *PanicError) Error() string { return fmt.Sprint(e.Value) }
