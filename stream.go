package flow

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// Streamed answers (see docs/protocol.md, "Streamed answers", and
// packages/protocol/src/stream.ts).
//
// A proxy in front of the app (Cloudflare: 100 s, nginx: 60 s) ends a call
// that sends nothing for too long. When the engine asks (X-Flow-Stream: 1),
// the answer to a POST is 200 at once, a "\n" heartbeat now and then, and at
// the end one meta line and the answer's raw body:
//
//	\n\n{"status":206,"noRetry":null,"retryAfter":null,"signature":"s=…"}\n<body>

// defaultHeartbeat is the time between heartbeats. Well under nginx's 60 s.
const defaultHeartbeat = 20 * time.Second

// streamHeartbeat is one heartbeat.
const streamHeartbeat = "\n"

// streamMeta is the meta line: what a normal answer has in its status and headers.
type streamMeta struct {
	Status     int     `json:"status"`
	NoRetry    *string `json:"noRetry"`
	RetryAfter *string `json:"retryAfter"`
	Signature  *string `json:"signature"`
}

func orNull(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// streamedAnswerTail is the end of a streamed answer: the meta line, then the
// raw body. signature is "" when the answer is not signed.
func streamedAnswerTail(status int, noRetry, retryAfter, signature string, body []byte) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// Same bytes as JSON.stringify in the TypeScript SDK.
	enc.SetEscapeHTML(false)
	_ = enc.Encode(streamMeta{Status: status, NoRetry: orNull(noRetry), RetryAfter: orNull(retryAfter), Signature: orNull(signature)})
	buf.Write(body) // Encode ended the meta line with "\n".
	return buf.Bytes()
}

// canFlush reports whether w (or a writer it wraps) can flush, without writing anything.
func canFlush(w http.ResponseWriter) bool {
	for {
		switch t := w.(type) {
		case http.Flusher:
			return true
		case interface{ Unwrap() http.ResponseWriter }:
			w = t.Unwrap()
		default:
			return false
		}
	}
}

// answerStream is a streamed answer in progress: it sends heartbeats until end.
type answerStream struct {
	w    http.ResponseWriter
	rc   *http.ResponseController
	mu   sync.Mutex // guards w between the heartbeat goroutine and end
	done chan struct{}
	wg   sync.WaitGroup
	once sync.Once
}

// startStream sends the headers and the first heartbeat, and starts the
// heartbeats. Call stop (or end) before the handler returns.
func startStream(w http.ResponseWriter, r *http.Request, every time.Duration) *answerStream {
	s := &answerStream{w: w, rc: http.NewResponseController(w), done: make(chan struct{})}
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Accel-Buffering", "no")
	h.Set(core.HeaderStream, "1")
	w.WriteHeader(http.StatusOK)
	s.beat()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				s.beat()
			case <-s.done:
				return
			case <-r.Context().Done():
				// The engine went away (or the step timeout hit).
				return
			}
		}
	}()
	return s
}

func (s *answerStream) beat() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.w.Write([]byte(streamHeartbeat))
	_ = s.rc.Flush()
}

// stop ends the heartbeats and waits for the goroutine. Safe to call twice.
func (s *answerStream) stop() {
	s.once.Do(func() { close(s.done) })
	s.wg.Wait()
}

// end stops the heartbeats and sends the meta line and body of a's answer.
func (s *answerStream) end(a *answerWriter) {
	s.stop()
	h := a.Header()
	var signature string
	if a.key != "" {
		if sig, err := signAnswer(a.key, a.request, a.status, h.Get(core.HeaderNoRetry), h.Get(core.HeaderRetryAfter), a.body); err == nil {
			signature = sig
		}
	}
	tail := streamedAnswerTail(a.status, h.Get(core.HeaderNoRetry), h.Get(core.HeaderRetryAfter), signature, a.body)
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.w.Write(tail)
	_ = s.rc.Flush()
}
