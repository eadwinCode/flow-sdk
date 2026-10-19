package flow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Realtime sends small live messages from functions to browsers. A message goes
// to the browsers connected right now; nothing is stored or replayed. Get it with
// Client.Realtime.
//
// A publish is a plain call, not a step: if the step around it is retried, the
// message is sent again. Treat messages as hints (progress, logs), and keep
// anything that must happen once in a step's result.
type Realtime struct {
	c *Client
}

// Realtime returns the client's realtime API.
func (c *Client) Realtime() Realtime { return Realtime{c: c} }

// RealtimeToken lets one browser connect to one channel and read the listed
// topics. Hand it to the browser as JSON; the TypeScript client reads it.
type RealtimeToken struct {
	Token   string   `json:"token"`
	URL     string   `json:"url"`
	Channel string   `json:"channel"`
	Topics  []string `json:"topics"`
	// ExpiresAt is the connect deadline (ms since epoch), about a minute away.
	ExpiresAt int64 `json:"expiresAt"`
}

// Publish sends data (any JSON value, up to about 64 KB) to the browsers
// subscribed to topic on channel. Log its error and go on: a realtime outage
// should not fail a run.
func (r Realtime) Publish(ctx context.Context, channel, topic string, data any) error {
	body := map[string]any{"appId": r.c.appID, "channel": channel, "topic": topic, "data": data}
	status, b, err := r.c.postSigned(ctx, "/v1/realtime/publish", body)
	if err != nil {
		return fmt.Errorf("flow: realtime publish: %w", err)
	}
	if status/100 != 2 {
		return fmt.Errorf("flow: realtime publish failed (%d): %s", status, engineError(b))
	}
	return nil
}

// Token makes a subscription token for channel and topics (1 to 10). Call it in
// your own HTTP handler, after you checked that the user may see that channel.
func (r Realtime) Token(ctx context.Context, channel string, topics ...string) (RealtimeToken, error) {
	if len(topics) == 0 {
		return RealtimeToken{}, errors.New("flow: realtime token needs at least one topic")
	}
	body := map[string]any{"appId": r.c.appID, "channel": channel, "topics": topics}
	status, b, err := r.c.postSigned(ctx, "/v1/realtime/token", body)
	if err != nil {
		return RealtimeToken{}, fmt.Errorf("flow: realtime token: %w", err)
	}
	if status != http.StatusOK {
		return RealtimeToken{}, fmt.Errorf("flow: realtime token failed (%d): %s", status, engineError(b))
	}
	var tok RealtimeToken
	if err := json.Unmarshal(b, &tok); err != nil {
		return RealtimeToken{}, fmt.Errorf("flow: cannot read the engine's answer: %w", err)
	}
	return tok, nil
}

// postSigned POSTs JSON to the engine with the signing key as bearer. On a 401 it
// tries the fallback key, so it keeps working while the key is rotated.
func (c *Client) postSigned(ctx context.Context, path string, payload any) (int, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	keys := []string{}
	for _, k := range []string{c.signingKey, c.fallbackKey} {
		if k != "" {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		keys = append(keys, "") // dev: no key; the engine answers 401
	}
	var status int
	var b []byte
	for i, k := range keys {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if k != "" {
			bearer, err := signingKeyBearer(k)
			if err != nil {
				return 0, nil, err
			}
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		status, b, err = c.do(req)
		if err != nil {
			return 0, nil, err
		}
		if status != http.StatusUnauthorized || i == len(keys)-1 {
			break
		}
	}
	return status, b, nil
}

// engineError is the "error" field of an engine answer, or the body as text.
func engineError(b []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(b, &e)
	if e.Error == "" {
		e.Error = strings.TrimSpace(string(b))
	}
	return e.Error
}
