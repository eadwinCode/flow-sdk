package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// maxRequestBytes caps the body read from the engine (memo included).
const maxRequestBytes = 64 << 20

// Serve returns the http.Handler for the app's one endpoint:
//
//   - POST runs a function (signed by the engine).
//   - PUT syncs: sends the manifest to the engine and returns its answer.
//     Call it on deploy, for example: curl -X PUT https://app/api/flow
//   - GET returns the manifest (signed GET with an empty body).
//
// Without a signing key, and not in dev mode, it answers every request with
// 500 NoSigningKey.
func (c *Client) Serve() http.Handler {
	if c.signingKey == "" && !c.dev {
		log.Printf("flow: FLOW_SIGNING_KEY is not set; app %s will refuse all requests (set FLOW_DEV=1 for local dev)", c.appID)
	}
	return http.HandlerFunc(c.serveHTTP)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status = http.StatusInternalServerError
		b, _ = json.Marshal(core.SerializedError{Name: "SerializationError", Message: err.Error()})
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func writeError(w http.ResponseWriter, status int, name, message string) {
	writeJSON(w, status, core.SerializedError{Name: name, Message: message})
}

func (c *Client) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if c.signingKey == "" && !c.dev {
		writeError(w, http.StatusInternalServerError, "NoSigningKey", "FLOW_SIGNING_KEY is not set (set FLOW_DEV=1 for local dev)")
		return
	}
	switch r.Method {
	case http.MethodPost:
		c.servePost(w, r)
	case http.MethodGet:
		c.serveGet(w, r)
	case http.MethodPut:
		c.servePut(w, r)
	default:
		w.Header().Set("Allow", "GET, POST, PUT")
		writeError(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "use GET, POST or PUT")
	}
}

// readSigned reads the raw body and checks its signature (skipped in dev mode).
// On success it returns a writer to answer with: it signs the answer with the
// key that matched (in dev mode, only when the request was signed with one of
// the keys). Call its finish when the answer is written.
func (c *Client) readSigned(w http.ResponseWriter, r *http.Request) ([]byte, *answerWriter, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BadRequest", "could not read the body")
		return nil, nil, false
	}
	if len(body) > maxRequestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "RequestTooLarge", "request body is too large")
		return nil, nil, false
	}
	header := r.Header.Get(core.HeaderSignature)
	key := matchSignature(header, body, []string{c.signingKey, c.fallbackKey}, c.now())
	if key == "" && !c.dev {
		writeError(w, http.StatusUnauthorized, "Unauthorized", "missing or invalid signature")
		return nil, nil, false
	}
	return body, &answerWriter{w: w, key: key, request: header, status: http.StatusOK}, true
}

// answerWriter holds the answer until finish, then signs it (when it has a
// key) and sends it. For a streamed answer it keeps its own headers (the real
// ones are already sent) and answerStream.end sends it.
type answerWriter struct {
	w       http.ResponseWriter
	header  http.Header // own headers of a streamed answer; nil: w's
	key     string
	request string
	status  int
	body    []byte
}

func (a *answerWriter) Header() http.Header {
	if a.header != nil {
		return a.header
	}
	return a.w.Header()
}
func (a *answerWriter) WriteHeader(status int) { a.status = status }
func (a *answerWriter) Write(b []byte) (int, error) {
	a.body = append(a.body, b...)
	return len(b), nil
}

func (a *answerWriter) finish() {
	if a.key != "" {
		h := a.w.Header()
		sig, err := signAnswer(a.key, a.request, a.status, h.Get(core.HeaderNoRetry), h.Get(core.HeaderRetryAfter), a.body)
		if err == nil {
			h.Set(core.HeaderAnswerSignature, sig)
		}
	}
	a.w.WriteHeader(a.status)
	_, _ = a.w.Write(a.body)
}

// serveURLFor is the URL of this request (scheme, host and path), sent in the
// manifest. An app added by URL in the dashboard does not need it: the engine
// keeps the URL it was given, and keeps a stored URL when this one is not usable.
func (c *Client) serveURLFor(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host + r.URL.Path
}

func (c *Client) serveGet(w http.ResponseWriter, r *http.Request) {
	_, aw, ok := c.readSigned(w, r)
	if !ok {
		return
	}
	writeJSON(aw, http.StatusOK, c.Manifest(c.serveURLFor(r)))
	aw.finish()
}

func (c *Client) servePut(w http.ResponseWriter, r *http.Request) {
	status, body, err := c.Sync(r.Context(), c.serveURLFor(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SyncFailed", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (c *Client) servePost(w http.ResponseWriter, r *http.Request) {
	body, aw, ok := c.readSigned(w, r)
	if !ok {
		return
	}
	var req core.InvokeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		// A bad request is answered at once, never streamed.
		writeError(aw, http.StatusBadRequest, "BadRequest", "body is not a valid request: "+err.Error())
		aw.finish()
		return
	}
	if c.heartbeat > 0 && r.Header.Get(core.HeaderStream) == "1" && canFlush(w) {
		s := startStream(w, r, c.heartbeat)
		// Stop the heartbeats even after a panic: nothing may write to w once
		// the handler has returned.
		defer s.stop()
		aw.header = http.Header{}
		c.run(aw, r, &req)
		s.end(aw)
		return
	}
	// Not deferred: after a panic nothing is sent, as before (net/http drops the connection).
	c.run(aw, r, &req)
	aw.finish()
}

func (c *Client) run(w http.ResponseWriter, r *http.Request, req *core.InvokeRequest) {
	fn := c.find(req.FnID)
	if fn == nil {
		w.Header().Set(core.HeaderNoRetry, "true")
		writeError(w, http.StatusInternalServerError, "FunctionNotFound", fmt.Sprintf("no function %q in app %s", req.FnID, c.appID))
		return
	}
	if req.UseAPI {
		memo, events, err := c.loadState(r.Context(), req.RunID)
		if err != nil {
			// No no-retry header: the engine should try the call again.
			writeError(w, http.StatusInternalServerError, "StateLoadFailed", err.Error())
			return
		}
		req.Memo, req.Events = memo, events
	}
	c.answer(w, c.invoke(r, fn, req))
}

// loadState loads a run's memo and events from the engine, page by page
// (GET {base}/runs/{runId}/state). It is used when the request has useApi set.
// It returns an error unless every page loaded, so the function never runs
// with part of its memo.
func (c *Client) loadState(ctx context.Context, runID string) (map[string]core.MemoEntry, []json.RawMessage, error) {
	if c.signingKey == "" {
		return nil, nil, errors.New("flow: no signing key to load the run state (set FLOW_SIGNING_KEY)")
	}
	bearer, err := signingKeyBearer(c.signingKey)
	if err != nil {
		return nil, nil, err
	}
	base := c.baseURL + "/runs/" + url.PathEscape(runID) + "/state"
	memo := map[string]core.MemoEntry{}
	var events []json.RawMessage
	u := base
	for n := 0; ; n++ {
		// Same stop as the TypeScript SDK, so a bad cursor can not loop forever.
		if n >= maxStatePages {
			return nil, nil, fmt.Errorf("flow: the run state has more than %d pages", maxStatePages)
		}
		first := n == 0
		page, err := c.getStatePage(ctx, u, bearer)
		if err != nil {
			return nil, nil, err
		}
		if first {
			events = page.Events
		}
		for k, v := range page.Memo {
			memo[k] = v
		}
		if page.Next == nil {
			return memo, events, nil
		}
		u = base + "?cursor=" + url.QueryEscape(*page.Next)
	}
}

// maxStatePages is the most pages loadState reads (a 32 MiB state is about 8).
const maxStatePages = 1000

// getStatePage fetches and reads one page of the run state.
func (c *Client) getStatePage(ctx context.Context, u, bearer string) (*core.RunStatePage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("flow: loading the run state failed: %w", err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxRequestBytes+1))
	if err != nil {
		return nil, fmt.Errorf("flow: loading the run state failed: %w", err)
	}
	if len(b) > maxRequestBytes {
		return nil, errors.New("flow: a run state page is too large")
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("flow: loading the run state failed (%d): %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var page core.RunStatePage
	if err := json.Unmarshal(b, &page); err != nil {
		return nil, fmt.Errorf("flow: cannot read a run state page: %w", err)
	}
	return &page, nil
}

// outcome is the result of one call to a function.
type outcome struct {
	output any
	err    error
	ops    []core.Opcode
	stop   bool // stopped at new work
	panic  any  // a real panic in user code
	target string
}

func (c *Client) invoke(r *http.Request, fn *function, req *core.InvokeRequest) (out outcome) {
	run := core.NewRun(req.RunID, req.TargetStepID, req.Memo, c.now)
	ctx := core.WithRun(r.Context(), run)
	out.target = req.TargetStepID
	defer func() {
		if rec := recover(); rec != nil {
			if core.IsControl(rec) {
				out.stop = true
				out.ops = run.Ops()
				return
			}
			out.panic = rec
		}
	}()
	out.output, out.err = fn.call(ctx, req)
	return out
}

func (c *Client) answer(w http.ResponseWriter, out outcome) {
	switch {
	case out.panic != nil:
		writeError(w, http.StatusInternalServerError, "Panic", fmt.Sprint(out.panic))
	case out.stop && len(out.ops) > 0:
		writeJSON(w, core.StatusOps, out.ops)
	case out.stop || (out.target != "" && out.err == nil):
		// In target mode the planned step was not reached.
		writeError(w, http.StatusInternalServerError, "StepNotFound",
			"the function did not reach step "+out.target)
	case out.err != nil:
		c.writeFunctionError(w, out.err)
	default:
		writeJSON(w, core.StatusDone, out.output)
	}
}

func (c *Client) writeFunctionError(w http.ResponseWriter, err error) {
	if core.IsNoRetry(err) {
		w.Header().Set(core.HeaderNoRetry, "true")
	}
	if at, ok := core.RetryTime(err); ok {
		secs := int64(math.Ceil(at.Sub(c.now()).Seconds()))
		if secs < 0 {
			secs = 0
		}
		w.Header().Set(core.HeaderRetryAfter, strconv.FormatInt(secs, 10))
	}
	writeJSON(w, http.StatusInternalServerError, core.Serialize(err))
}
