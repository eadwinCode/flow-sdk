package core

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"
)

// ErrNotInFunction is returned by step calls made outside a flow function, or
// inside another step's callback.
var ErrNotInFunction = errors.New("flow: step called outside a flow function or inside another step")

// HashStepID gives the hashed step ID: lowercase hex SHA-1 of id for the first
// use (occurrence 0), and of "id:N" for the Nth repeat.
func HashStepID(id string, occurrence int) string {
	input := id
	if occurrence > 0 {
		input = id + ":" + strconv.Itoa(occurrence)
	}
	sum := sha1.Sum([]byte(input))
	return hex.EncodeToString(sum[:])
}

// The two kinds of control panic. They are how the SDK stops user code when it
// reaches new work (Go has no await).
type controlKind int

const (
	stopRun    controlKind = iota // stop the whole handler
	stopBranch                    // stop one group.Parallel branch
)

// Control is the value the SDK panics with. Never swallow it.
type Control struct{ kind controlKind }

// IsControl reports whether a recovered value is the SDK's control panic.
func IsControl(r any) bool {
	_, ok := r.(Control)
	return ok
}

// IsBranchStop reports whether r stops only one parallel branch.
func IsBranchStop(r any) bool {
	c, ok := r.(Control)
	return ok && c.kind == stopBranch
}

// StopRun panics to stop the whole handler.
func StopRun() { panic(Control{kind: stopRun}) }

// StopBranch panics to stop one parallel branch.
func StopBranch() { panic(Control{kind: stopBranch}) }

type pending struct {
	op   Opcode
	exec func() Opcode // set for a planned step.Run that has not run
}

// Run is the replay state of one call to a function.
type Run struct {
	RunID  string
	Target string
	Now    func() time.Time

	mu      sync.Mutex
	memo    map[string]MemoEntry
	counts  map[string]int
	pending []pending
	result  *Opcode // the target step's result, in target mode
}

// NewRun starts the replay state for one call.
func NewRun(runID, target string, memo map[string]MemoEntry, now func() time.Time) *Run {
	if memo == nil {
		memo = map[string]MemoEntry{}
	}
	if now == nil {
		now = time.Now
	}
	return &Run{RunID: runID, Target: target, Now: now, memo: memo, counts: map[string]int{}}
}

// Next counts one use of the user's step ID and returns its hashed ID and its
// memo entry, if any.
func (r *Run) Next(userID string) (string, *MemoEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := r.counts[userID]
	r.counts[userID] = n + 1
	h := HashStepID(userID, n)
	if e, ok := r.memo[h]; ok {
		return h, &e
	}
	return h, nil
}

// IdempotencyKey is "<runId>:<hashed step id>", the same on every attempt.
func (r *Run) IdempotencyKey(hashed string) string { return r.RunID + ":" + hashed }

// StepContext is the context a step.Run callback gets: step calls inside it
// fail with ErrNotInFunction, and step.IdempotencyKey works.
func (r *Run) StepContext(ctx context.Context, hashed string) context.Context {
	ctx = context.WithValue(ctx, frameKey{}, (*frame)(nil))
	return context.WithValue(ctx, idemKey{}, r.IdempotencyKey(hashed))
}

// New is called when a step is not in the memo. op is the step's own opcode
// (for step.Run, a StepPlanned); exec runs a step.Run callback and returns its
// StepCompleted or StepFailed (nil for other steps). New never returns.
func (r *Run) New(ctx context.Context, op Opcode, exec func() Opcode) {
	parallel := InParallel(ctx)
	if r.Target != "" {
		if op.ID == r.Target && exec != nil {
			res := exec()
			r.mu.Lock()
			r.result = &res
			r.mu.Unlock()
			StopRun()
		}
		// Other new steps are not run and not reported.
		if parallel {
			StopBranch()
		}
		StopRun()
	}
	if !parallel {
		// Alone: run it now (step.Run) or report its opcode.
		if exec != nil {
			op = exec()
		}
		r.add(pending{op: op})
		StopRun()
	}
	r.add(pending{op: op, exec: exec})
	StopBranch()
}

func (r *Run) add(p pending) {
	r.mu.Lock()
	r.pending = append(r.pending, p)
	r.mu.Unlock()
}

// HasPending reports whether new steps were found.
func (r *Run) HasPending() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending) > 0
}

// RunIfAlone runs the found step now when it is the only new step and it is a
// step.Run. Called at the end of the outer group.Parallel.
func (r *Run) RunIfAlone() {
	r.mu.Lock()
	if r.Target != "" || len(r.pending) != 1 || r.pending[0].exec == nil {
		r.mu.Unlock()
		return
	}
	exec := r.pending[0].exec
	r.mu.Unlock()
	op := exec()
	r.mu.Lock()
	r.pending[0] = pending{op: op}
	r.mu.Unlock()
}

// Ops returns the opcodes to answer with. In target mode it is the target's
// result (or nothing if it was not reached). Planned step.Run calls that did
// not run become StepPlanned.
func (r *Run) Ops() []Opcode {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Target != "" {
		if r.result == nil {
			return nil
		}
		return []Opcode{*r.result}
	}
	out := make([]Opcode, 0, len(r.pending))
	for _, p := range r.pending {
		out = append(out, p.op)
	}
	return out
}

// RunStep builds the StepCompleted or StepFailed for a step.Run result.
func RunStep(hashed, name string, value any, err error) Opcode {
	if err != nil {
		op := Opcode{Op: OpStepFailed, ID: hashed, Name: name}
		se := Serialize(err)
		op.Error = &se
		if IsNoRetry(err) {
			op.NoRetry = true
		}
		if at, ok := RetryTime(err); ok {
			ms := at.UnixMilli()
			op.RetryAt = &ms
		}
		return op
	}
	data, merr := json.Marshal(value)
	if merr != nil {
		return Opcode{Op: OpStepFailed, ID: hashed, Name: name, NoRetry: true,
			Error: &SerializedError{Name: "SerializationError", Message: merr.Error()}}
	}
	if len(data) > MaxOutputBytes {
		return Opcode{Op: OpStepFailed, ID: hashed, Name: name, NoRetry: true,
			Error: &SerializedError{Name: "OutputTooLarge", Message: "step output is " +
				strconv.Itoa(len(data)) + " bytes; the limit is " + strconv.Itoa(MaxOutputBytes)}}
	}
	return Opcode{Op: OpStepCompleted, ID: hashed, Name: name, Data: data}
}

// --------------------------------------------------------------- context

type frameKey struct{}
type idemKey struct{}

type frame struct {
	run      *Run
	parallel bool
}

// WithRun puts the replay state in the context given to a handler.
func WithRun(ctx context.Context, r *Run) context.Context {
	return context.WithValue(ctx, frameKey{}, &frame{run: r})
}

// WithParallel marks the context of one group.Parallel branch.
func WithParallel(ctx context.Context) context.Context {
	f, _ := ctx.Value(frameKey{}).(*frame)
	if f == nil {
		return ctx
	}
	return context.WithValue(ctx, frameKey{}, &frame{run: f.run, parallel: true})
}

// FromContext returns the replay state, or nil outside a flow function (and
// inside a step callback).
func FromContext(ctx context.Context) *Run {
	f, _ := ctx.Value(frameKey{}).(*frame)
	if f == nil {
		return nil
	}
	return f.run
}

// InParallel reports whether ctx is inside a group.Parallel branch.
func InParallel(ctx context.Context) bool {
	f, _ := ctx.Value(frameKey{}).(*frame)
	return f != nil && f.parallel
}

// IdempotencyKeyFrom returns the key stored in a step callback's context.
func IdempotencyKeyFrom(ctx context.Context) string {
	s, _ := ctx.Value(idemKey{}).(string)
	return s
}
