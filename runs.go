package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// StartOpts is the input of Client.Start.
type StartOpts struct {
	// Data is the run's event data. Default: {}.
	Data any
	// ID makes a retry safe: a second Start with the same ID (1 to 256
	// characters) finds the same run, and does not start another. Optional.
	ID string
	// User is the event's user field. Optional.
	User any
	// WhenPaused says what a paused function does with the start: "refuse"
	// (the default: Reason is "paused") or "hold" (the run is made paused, and
	// starts when the function is resumed).
	WhenPaused string
}

// StartResult says whether Start started a run.
type StartResult struct {
	Started bool   `json:"started"`
	RunID   string `json:"runId,omitempty"`
	EventID string `json:"eventId,omitempty"`
	// Existed is true when a run with this StartOpts.ID was there already.
	Existed bool `json:"existed,omitempty"`
	// Reason says why no run started: "singleton", "paused" or "not_found".
	Reason string `json:"reason,omitempty"`
	// ActiveRunID is the run that holds the singleton when Reason is
	// "singleton". It is empty if that run ended in between.
	ActiveRunID string `json:"activeRunId,omitempty"`
}

// Start starts a run of one of this app's functions now, without an event
// name to match (POST /v1/functions/{id}/start). functionID is the
// function's own ID, as in FunctionOpts.ID. Singleton, throttle, concurrency
// and priority apply; rate limit, debounce and batching do not.
//
// The run exists when Start returns, so a Runs().Cancel right after it can
// not miss it. Start does not fail when no run started: then Started is
// false and Reason says why. It fails for any answer other than 200 (for
// example 429 when the workspace sends too many events a second).
func (c *Client) Start(ctx context.Context, functionID string, opts StartOpts) (StartResult, error) {
	if functionID == "" {
		return StartResult{}, errors.New("flow: Start needs a function id")
	}
	body := map[string]any{"appId": c.appID}
	if opts.Data != nil {
		body["data"] = opts.Data
	}
	if opts.ID != "" {
		body["id"] = opts.ID
	}
	if opts.User != nil {
		body["user"] = opts.User
	}
	if opts.WhenPaused != "" {
		body["whenPaused"] = opts.WhenPaused
	}
	var res StartResult
	err := c.callSigned(ctx, "start", http.MethodPost, "/v1/functions/"+url.PathEscape(functionID)+"/start", body, &res)
	return res, err
}

// Runs finds, counts and cancels this app's runs. Get it with Client.Runs.
type Runs struct {
	c *Client
}

// Runs returns the client's runs API.
func (c *Client) Runs() Runs { return Runs{c: c} }

// ListRunsOpts filters Runs().List. Every field is optional.
type ListRunsOpts struct {
	// Function is a function's own ID. Needed with Tags.
	Function string
	// Status keeps runs in these statuses, for example "queued", "running".
	// Empty: every status.
	Status []string
	// Tags keeps runs with all these tag values (up to 3). See FunctionOpts.Tags.
	Tags map[string]string
	// Limit is the page size, 1 to 200. Default: 50.
	Limit int
	// Before is RunPage.Next of the page before, to read the next page.
	Before string
	// Order is "newest" (the default) or "oldest": oldest first.
	Order string
}

// RunSummary is one run in a RunPage.
type RunSummary struct {
	ID string `json:"id"`
	// FunctionID is the function's own ID, without the app.
	FunctionID string `json:"functionId"`
	Status     string `json:"status"`
	// CreatedAt is ms since epoch.
	CreatedAt int64 `json:"createdAt"`
	// EndedAt is ms since epoch, or 0 while the run has not ended.
	EndedAt int64 `json:"endedAt"`
	// Tags are the run's tags; empty when it has none.
	Tags map[string]string `json:"tags"`
}

// RunPage is one page of runs, newest first.
type RunPage struct {
	Items []RunSummary `json:"items"`
	// Next reads the next page as ListRunsOpts.Before. Empty on the last page.
	Next string `json:"next"`
}

// RunCounts is how many of a function's runs are in each status.
type RunCounts struct {
	Queued        int `json:"queued"`
	Running       int `json:"running"`
	Sleeping      int `json:"sleeping"`
	Waiting       int `json:"waiting"`
	WaitingForApp int `json:"waiting_for_app"`
	Paused        int `json:"paused"`
	Completed     int `json:"completed"`
	Failed        int `json:"failed"`
	Cancelled     int `json:"cancelled"`
	// Since is ms since epoch. Ended runs older than this may be gone from
	// the counts already.
	Since int64 `json:"since"`
}

// SingletonRun is the run that holds a singleton key.
type SingletonRun struct {
	// RunID is empty when no active run holds the key.
	RunID string `json:"runId"`
	// Status is the run's status, or empty with RunID.
	Status string `json:"status"`
}

// List lists this app's runs, newest first (GET /v1/runs). It reads the
// engine's run index, which is a few seconds behind the runs.
func (r Runs) List(ctx context.Context, opts ListRunsOpts) (RunPage, error) {
	q := url.Values{"appId": {r.c.appID}}
	if opts.Function != "" {
		q.Set("function", opts.Function)
	}
	if len(opts.Status) > 0 {
		q.Set("status", strings.Join(opts.Status, ","))
	}
	for name, value := range opts.Tags {
		q.Set("tag."+name, value)
	}
	if opts.Limit != 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Before != "" {
		q.Set("before", opts.Before)
	}
	if opts.Order != "" {
		q.Set("order", opts.Order)
	}
	var page RunPage
	err := r.c.callSigned(ctx, "list runs", http.MethodGet, "/v1/runs?"+q.Encode(), nil, &page)
	return page, err
}

// Counts counts a function's runs by status (GET /v1/runs/counts). Like
// List, it is a few seconds behind the runs.
func (r Runs) Counts(ctx context.Context, functionID string) (RunCounts, error) {
	if functionID == "" {
		return RunCounts{}, errors.New("flow: Counts needs a function id")
	}
	q := url.Values{"appId": {r.c.appID}, "function": {functionID}}
	var counts RunCounts
	err := r.c.callSigned(ctx, "count runs", http.MethodGet, "/v1/runs/counts?"+q.Encode(), nil, &counts)
	return counts, err
}

// Singleton finds the active run that holds a singleton key of a function
// (GET /v1/functions/{id}/singleton). key is the value the function's
// singleton key expression gives: a string, or any other JSON value. This is
// exact, with no index lag.
func (r Runs) Singleton(ctx context.Context, functionID string, key any) (SingletonRun, error) {
	if functionID == "" {
		return SingletonRun{}, errors.New("flow: Singleton needs a function id")
	}
	q := url.Values{"appId": {r.c.appID}}
	if s, ok := key.(string); ok {
		q.Set("key", s)
	} else {
		b, err := json.Marshal(key)
		if err != nil {
			return SingletonRun{}, fmt.Errorf("flow: singleton key: %w", err)
		}
		q.Set("keyJson", string(b))
	}
	var run SingletonRun
	err := r.c.callSigned(ctx, "singleton lookup", http.MethodGet,
		"/v1/functions/"+url.PathEscape(functionID)+"/singleton?"+q.Encode(), nil, &run)
	return run, err
}

// CancelOpts says which runs Runs().Cancel cancels. Set exactly one of RunID,
// SingletonKey and Tag.
type CancelOpts struct {
	// RunID cancels one run.
	RunID string
	// Function is the function's own ID. Needed with SingletonKey and Tag.
	Function string
	// SingletonKey cancels the run that holds this singleton key. Set when
	// not nil.
	SingletonKey any
	// Tag cancels the runs with this tag value: one name and its value.
	Tag map[string]string
	// Status, with Tag only, cancels only runs in these active statuses.
	// Nil: every active status. Empty but not nil is an error.
	Status []string
	// Cursor, with Tag only, goes on after the page before: pass
	// CancelResult.Next. Sent when not empty.
	Cursor string
}

// CancelResult says what Runs().Cancel did.
type CancelResult struct {
	// Cancelled are the runs it cancelled.
	Cancelled []string `json:"cancelled"`
	// NotActive are runs that had ended already, or are not this app's.
	NotActive []string `json:"notActive"`
	// More is true when more runs match a Tag than one call cancels (500).
	// Call again with Next as CancelOpts.Cursor.
	More bool `json:"more"`
	// Next is the cursor for the next call by Tag. Empty when there is no
	// more.
	Next string `json:"next"`
}

// Cancel cancels runs of this app (POST /v1/runs/cancel): one run by ID, the
// run that holds a singleton key, or the runs with a tag value. A run that has
// ended already is not an error: it is in NotActive. A cancel by tag cancels
// up to 500 runs; when More is true, call again with Next as Cursor.
func (r Runs) Cancel(ctx context.Context, opts CancelOpts) (CancelResult, error) {
	set := 0
	for _, ok := range []bool{opts.RunID != "", opts.SingletonKey != nil, len(opts.Tag) > 0} {
		if ok {
			set++
		}
	}
	switch {
	case set != 1:
		return CancelResult{}, errors.New("flow: Cancel takes exactly one of RunID, SingletonKey and Tag")
	case opts.RunID == "" && opts.Function == "":
		return CancelResult{}, errors.New("flow: Cancel needs Function with SingletonKey or Tag")
	case len(opts.Tag) > 1:
		return CancelResult{}, errors.New("flow: Cancel takes one tag")
	case opts.Status != nil && len(opts.Status) == 0:
		// An empty filter must not cancel every active run.
		return CancelResult{}, errors.New("flow: Cancel: Status must name at least one status, or be nil")
	case len(opts.Status) > 0 && len(opts.Tag) == 0:
		return CancelResult{}, errors.New("flow: Cancel takes Status only with Tag")
	case opts.Cursor != "" && len(opts.Tag) == 0:
		return CancelResult{}, errors.New("flow: Cancel takes Cursor only with Tag")
	}
	body := map[string]any{"appId": r.c.appID}
	switch {
	case opts.RunID != "":
		body["runId"] = opts.RunID
	case opts.SingletonKey != nil:
		body["function"] = opts.Function
		body["singletonKey"] = opts.SingletonKey
	default:
		body["function"] = opts.Function
		body["tag"] = opts.Tag
		if len(opts.Status) > 0 {
			body["status"] = opts.Status
		}
		if opts.Cursor != "" {
			body["cursor"] = opts.Cursor
		}
	}
	var res CancelResult
	err := r.c.callSigned(ctx, "cancel runs", http.MethodPost, "/v1/runs/cancel", body, &res)
	return res, err
}

// RunDetail is one run, as Runs().Get gives it.
type RunDetail struct {
	RunSummary
	// Attempts is, for a failed run, how many times the call that failed it
	// was tried (as the failure function's attempts); for any other run, how
	// many times it was called.
	Attempts int `json:"attempts"`
	// Error is why the run failed or was cancelled; nil otherwise.
	Error *RunError `json:"error"`
	// Event is the event that started the run. For a run from Start, its Data
	// is StartOpts.Data.
	Event RunEvent `json:"event"`
}

// RunError is a run's error, as the engine keeps it.
type RunError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
}

// RunEvent is the event that started a run.
type RunEvent struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Data json.RawMessage `json:"data"`
	// TS is ms since epoch.
	TS int64 `json:"ts"`
}

// RetryResult says what Runs().Retry did.
type RetryResult struct {
	// Retried is false when the run had not failed or been cancelled, or
	// another run holds its singleton key now (Reason "singleton").
	Retried bool   `json:"retried"`
	Reason  string `json:"reason,omitempty"`
}

// Get gives one of this app's runs, with its event and error (GET
// /v1/runs/{id}). It asks the run itself, so it does not lag. Nil, nil when
// there is no such run.
func (r Runs) Get(ctx context.Context, runID string) (*RunDetail, error) {
	if runID == "" {
		return nil, errors.New("flow: Get needs a run id")
	}
	q := url.Values{"appId": {r.c.appID}}
	var run RunDetail
	err := r.c.callSigned(ctx, "get run", http.MethodGet, "/v1/runs/"+url.PathEscape(runID)+"?"+q.Encode(), nil, &run)
	var ae *apiError
	if errors.As(err, &ae) && ae.status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// Retry retries a failed or cancelled run from where it stopped, under the
// same run ID, as the dashboard's Retry (POST /v1/runs/{id}/retry). A run
// that is missing, or has not ended that way, is not retried: Retried is
// false, with no error.
func (r Runs) Retry(ctx context.Context, runID string) (RetryResult, error) {
	if runID == "" {
		return RetryResult{}, errors.New("flow: Retry needs a run id")
	}
	var res RetryResult
	err := r.c.callSigned(ctx, "retry run", http.MethodPost, "/v1/runs/"+url.PathEscape(runID)+"/retry",
		map[string]any{"appId": r.c.appID}, &res)
	var ae *apiError
	if errors.As(err, &ae) && ae.status == http.StatusNotFound {
		return RetryResult{}, nil
	}
	return res, err
}

// Delete deletes a run that has ended now, as its retention would later (POST
// /v1/runs/{id}/delete): its state, files and index row. It is false for an
// active run, or one that is not found.
func (r Runs) Delete(ctx context.Context, runID string) (bool, error) {
	if runID == "" {
		return false, errors.New("flow: Delete needs a run id")
	}
	var res struct {
		Deleted bool `json:"deleted"`
	}
	err := r.c.callSigned(ctx, "delete run", http.MethodPost, "/v1/runs/"+url.PathEscape(runID)+"/delete",
		map[string]any{"appId": r.c.appID}, &res)
	var ae *apiError
	if errors.As(err, &ae) && ae.status == http.StatusNotFound {
		return false, nil
	}
	return res.Deleted, err
}

// Functions pauses and resumes this app's functions. Get it with
// Client.Functions.
type Functions struct {
	c *Client
}

// Functions returns the client's functions API.
func (c *Client) Functions() Functions { return Functions{c: c} }

// PauseResult says what Functions().Pause or Resume did.
type PauseResult struct {
	Paused bool `json:"paused"`
	// Runs is how many of the function's runs were paused, or resumed.
	Runs int `json:"runs"`
}

// Pause pauses one of this app's functions, as the dashboard does (POST
// /v1/functions/{id}/pause): new runs are refused (or held, with
// StartOpts.WhenPaused), and its active runs pause at their next step.
func (f Functions) Pause(ctx context.Context, functionID string) (PauseResult, error) {
	return f.set(ctx, functionID, "pause")
}

// Resume resumes a paused function and its paused runs (POST
// /v1/functions/{id}/resume).
func (f Functions) Resume(ctx context.Context, functionID string) (PauseResult, error) {
	return f.set(ctx, functionID, "resume")
}

func (f Functions) set(ctx context.Context, functionID, action string) (PauseResult, error) {
	if functionID == "" {
		return PauseResult{}, fmt.Errorf("flow: %s needs a function id", action)
	}
	var res PauseResult
	err := f.c.callSigned(ctx, "function "+action, http.MethodPost, "/v1/functions/"+url.PathEscape(functionID)+"/"+action,
		map[string]any{"appId": f.c.appID}, &res)
	return res, err
}
