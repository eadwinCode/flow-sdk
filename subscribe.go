package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"

	"github.com/coder/websocket"
)

// RealtimeMessage is one message a subscription gets.
type RealtimeMessage struct {
	Channel string          `json:"channel"`
	Topic   string          `json:"topic"`
	Data    json.RawMessage `json:"data"`
	// TS is when the engine got the publish, ms since epoch.
	TS int64 `json:"ts"`
}

// RealtimeState is the state of a subscription, given to SubscribeOpts.OnState.
type RealtimeState string

// The states of a subscription.
const (
	RealtimeConnecting RealtimeState = "connecting"
	RealtimeOpen       RealtimeState = "open"
	RealtimeClosed     RealtimeState = "closed"
	RealtimeError      RealtimeState = "error"
)

// SubscribeOpts says what Subscribe reads and where the messages go.
type SubscribeOpts struct {
	// Channel is the one channel to read. Set Channel or Channels, not both.
	Channel string
	// Channels reads 1 to 100 channels over one socket, with at most 8,000
	// characters of names in all.
	Channels []string
	// Topics are the topics to read (1 to 10), on every channel.
	Topics []string
	// OnMessage gets each message. Required. It runs on the subscription's
	// own goroutine, one message at a time, so a slow OnMessage holds up the
	// next ones.
	OnMessage func(RealtimeMessage)
	// OnState gets each change of state. err is set with RealtimeError, and
	// says why the connect or the socket failed. Optional.
	OnState func(state RealtimeState, err error)
}

// Subscribe reads live messages on a server, the way the TypeScript
// subscribe does in a browser. It makes a new token (Token or TokenMany)
// before every connect, so no token route is needed. It connects to the
// client's base URL with the path of the token's URL, not to the host in the
// token. It sends "ping" every 30s. When the socket drops it connects again
// after a wait (1s, doubling up to 30s, with some random), and at once when
// the engine ends the socket at the end of its 1-hour life (close code
// 4001).
//
// Messages are lost while the socket reconnects and at the 1-hour renewal.
// Treat them as hints: read missed state from your own store after a
// reconnect (OnState gets RealtimeOpen).
//
// It runs until stop is called or ctx ends. stop waits until the
// subscription has ended, so no callback runs after it returns. It may be
// called more than once. Do not call stop from inside OnMessage or OnState: it
// would wait for itself. To end from a callback, cancel the ctx given to
// Subscribe, or call go stop(). err is only for bad options: no channel, no
// topics, or no OnMessage.
func (r Realtime) Subscribe(ctx context.Context, opts SubscribeOpts) (stop func(), err error) {
	switch {
	case opts.Channel == "" && len(opts.Channels) == 0:
		return nil, errors.New("flow: Subscribe needs a Channel or Channels")
	case opts.Channel != "" && len(opts.Channels) > 0:
		return nil, errors.New("flow: Subscribe takes Channel or Channels, not both")
	case len(opts.Topics) == 0:
		return nil, errors.New("flow: Subscribe needs at least one topic")
	case opts.OnMessage == nil:
		return nil, errors.New("flow: Subscribe needs OnMessage")
	}
	if len(opts.Channels) > 0 {
		if err := checkChannels(opts.Channels); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &subscription{r: r, opts: opts, ctx: ctx}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.run()
	}()
	return func() {
		cancel()
		<-done
	}, nil
}

type subscription struct {
	r    Realtime
	opts SubscribeOpts
	ctx  context.Context
}

// call runs a callback, unless the subscription has ended.
func (s *subscription) call(f func()) {
	if s.ctx.Err() != nil {
		return
	}
	f()
}

func (s *subscription) state(st RealtimeState, err error) {
	if s.opts.OnState != nil {
		s.call(func() { s.opts.OnState(st, err) })
	}
}

func (s *subscription) run() {
	failures := 0
	for s.ctx.Err() == nil {
		s.state(RealtimeConnecting, nil)
		code, err := s.connect(&failures)
		if s.ctx.Err() != nil {
			return
		}
		if err != nil {
			s.state(RealtimeError, err)
		} else {
			s.state(RealtimeClosed, nil)
		}
		if code == closeExpired {
			continue
		}
		wait := backoff(failures)
		failures++
		if !sleepCtx(s.ctx, wait) {
			return
		}
	}
}

// connect gets a token, connects, and reads until the socket ends. It gives
// the close code, or an error when it could not connect.
func (s *subscription) connect(failures *int) (websocket.StatusCode, error) {
	var tok RealtimeToken
	var err error
	if s.opts.Channel != "" {
		tok, err = s.r.Token(s.ctx, s.opts.Channel, s.opts.Topics...)
	} else {
		tok, err = s.r.TokenMany(s.ctx, s.opts.Channels, s.opts.Topics...)
	}
	if err != nil {
		return -1, err
	}
	u, err := s.r.c.socketURL(tok.URL, url.Values{"token": {tok.Token}})
	if err != nil {
		return -1, err
	}
	conn, done, err := s.r.c.dialSocket(s.ctx, u, "unsubscribed")
	if err != nil {
		return -1, fmt.Errorf("flow: realtime connect: %w", err)
	}
	defer done()
	*failures = 0
	s.state(RealtimeOpen, nil)
	readCtx := context.WithoutCancel(s.ctx)
	for {
		typ, data, err := conn.Read(readCtx)
		if err != nil {
			return websocket.CloseStatus(err), nil
		}
		if typ != websocket.MessageText || string(data) == "pong" {
			continue
		}
		var m RealtimeMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		s.call(func() { s.opts.OnMessage(m) })
	}
}
