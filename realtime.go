package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf16"
)

// Realtime sends small live messages from functions to browsers. A message goes
// to the browsers connected right now; nothing is stored or replayed. A server
// can read them too, with Subscribe. Get it with Client.Realtime.
//
// A publish is a plain call, not a step: if the step around it is retried, the
// message is sent again. Treat messages as hints (progress, logs), and keep
// anything that must happen once in a step's result.
type Realtime struct {
	c *Client
}

// Realtime returns the client's realtime API.
func (c *Client) Realtime() Realtime { return Realtime{c: c} }

// RealtimeToken lets one browser (or server) connect to one channel, or to a
// list of channels, and read the listed topics. Hand it to the browser as
// JSON; the TypeScript client reads it.
type RealtimeToken struct {
	Token string `json:"token"`
	URL   string `json:"url"`
	// Channel is set for a token made by Token.
	Channel string `json:"channel,omitempty"`
	// Channels is set for a token made by TokenMany.
	Channels []string `json:"channels,omitempty"`
	Topics   []string `json:"topics"`
	// ExpiresAt is the connect deadline (ms since epoch), about a minute away.
	ExpiresAt int64 `json:"expiresAt"`
}

// RealtimeOut is one message for PublishMany.
type RealtimeOut struct {
	Channel string `json:"channel"`
	Topic   string `json:"topic"`
	Data    any    `json:"data"`
}

// Publish sends data (any JSON value, up to about 64 KB) to the browsers
// subscribed to topic on channel. Log its error and go on: a realtime outage
// should not fail a run.
func (r Realtime) Publish(ctx context.Context, channel, topic string, data any) error {
	body := map[string]any{"appId": r.c.appID, "channel": channel, "topic": topic, "data": data}
	return r.c.callSigned(ctx, "realtime publish", http.MethodPost, "/v1/realtime/publish", body, nil)
}

// PublishMany sends 1 to 100 messages in one call. Each message's data is up
// to about 64 KB, and the whole call up to 1 MB. The engine checks them all
// first: if one is bad, none is sent.
func (r Realtime) PublishMany(ctx context.Context, messages []RealtimeOut) error {
	if len(messages) == 0 || len(messages) > 100 {
		return fmt.Errorf("flow: PublishMany takes 1 to 100 messages, not %d", len(messages))
	}
	body := map[string]any{"appId": r.c.appID, "messages": messages}
	return r.c.callSigned(ctx, "realtime publish", http.MethodPost, "/v1/realtime/publish", body, nil)
}

// Token makes a subscription token for channel and topics (1 to 10). Call it in
// your own HTTP handler, after you checked that the user may see that channel.
func (r Realtime) Token(ctx context.Context, channel string, topics ...string) (RealtimeToken, error) {
	if len(topics) == 0 {
		return RealtimeToken{}, errors.New("flow: realtime token needs at least one topic")
	}
	body := map[string]any{"appId": r.c.appID, "channel": channel, "topics": topics}
	var tok RealtimeToken
	err := r.c.callSigned(ctx, "realtime token", http.MethodPost, "/v1/realtime/token", body, &tok)
	return tok, err
}

// TokenMany makes one token for 1 to 100 channels, with at most 8,000
// characters of names in all (so the token fits in a connect URL). The topics
// apply to every channel. One socket then gets the messages of all of them.
func (r Realtime) TokenMany(ctx context.Context, channels []string, topics ...string) (RealtimeToken, error) {
	if err := checkChannels(channels); err != nil {
		return RealtimeToken{}, err
	}
	if len(topics) == 0 {
		return RealtimeToken{}, errors.New("flow: realtime token needs at least one topic")
	}
	body := map[string]any{"appId": r.c.appID, "channels": channels, "topics": topics}
	var tok RealtimeToken
	err := r.c.callSigned(ctx, "realtime token", http.MethodPost, "/v1/realtime/token", body, &tok)
	return tok, err
}

// checkChannels checks a list of channels for one token: 1 to 100 names, and
// at most 8,000 characters in all, counted as the engine does (UTF-16).
func checkChannels(channels []string) error {
	if len(channels) == 0 || len(channels) > 100 {
		return fmt.Errorf("flow: a token takes 1 to 100 channels, not %d", len(channels))
	}
	n := 0
	for _, ch := range channels {
		for _, r := range ch {
			n += utf16.RuneLen(r)
		}
	}
	if n > 8000 {
		return fmt.Errorf("flow: the channel names have %d characters in all; at most 8000", n)
	}
	return nil
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
