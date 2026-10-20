package flow

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// wantSignedAnswer checks the answer's X-Flow-Answer-Signature against key and the
// request's signature header.
func wantSignedAnswer(t *testing.T, a answer, key, request string) {
	t.Helper()
	want, err := signAnswer(key, request, a.status, a.header.Get(core.HeaderNoRetry), a.header.Get(core.HeaderRetryAfter), a.body)
	if err != nil {
		t.Fatal(err)
	}
	if got := a.header.Get(core.HeaderAnswerSignature); got != want {
		t.Fatalf("answer signature = %q, want %q (status %d, body %s)", got, want, a.status, a.body)
	}
}

func TestAnswerSignedGet(t *testing.T) {
	c := newClient(t, ClientOpts{})
	sig, _ := signRequest(testKey, nil, testNow)
	a := send(t, c, http.MethodGet, nil, sig)
	if a.status != 200 {
		t.Fatalf("status %d", a.status)
	}
	wantSignedAnswer(t, a, testKey, sig)
}

func TestAnswerSignedPostDoneAndError(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "ok", func(ctx context.Context, in Input[charge]) (any, error) { return "done", nil })
	define(t, c, "bad", func(ctx context.Context, in Input[charge]) (any, error) {
		return nil, NoRetryError(errors.New("no"))
	})
	for _, id := range []string{"ok", "bad", "missing"} {
		body := invokeBody(t, id, reqOpts{})
		sig, _ := signRequest(testKey, body, testNow)
		a := send(t, c, http.MethodPost, body, sig)
		wantSignedAnswer(t, a, testKey, sig)
	}
}

func TestAnswerSignedWithFallbackKey(t *testing.T) {
	// The engine still signs with the old key: the answer is signed with it too.
	c := newClient(t, ClientOpts{SigningKey: StrPtr(testFallback), SigningKeyFallback: StrPtr(testKey)})
	sig, _ := signRequest(testKey, nil, testNow)
	wantSignedAnswer(t, send(t, c, http.MethodGet, nil, sig), testKey, sig)
}

func TestAnswerNotSignedWhenRefused(t *testing.T) {
	c := newClient(t, ClientOpts{})
	a := send(t, c, http.MethodGet, nil, "")
	if a.status != 401 || a.header.Get(core.HeaderAnswerSignature) != "" {
		t.Fatalf("status %d, signature %q", a.status, a.header.Get(core.HeaderAnswerSignature))
	}
}

func TestAnswerDevMode(t *testing.T) {
	c := newClient(t, ClientOpts{Dev: BoolPtr(true)})
	// Unsigned call: let in, answer not signed.
	if a := send(t, c, http.MethodGet, nil, ""); a.status != 200 || a.header.Get(core.HeaderAnswerSignature) != "" {
		t.Fatalf("status %d, signature %q", a.status, a.header.Get(core.HeaderAnswerSignature))
	}
	// Signed call: answer signed.
	sig, _ := signRequest(testKey, nil, testNow)
	wantSignedAnswer(t, send(t, c, http.MethodGet, nil, sig), testKey, sig)
}
