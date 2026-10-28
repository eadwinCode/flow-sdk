package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/coder/websocket"
)

// ErrStreamGone is the error for a stream that does not exist: never opened,
// deleted, or past its TTL or grace time. Check for it with errors.Is.
var ErrStreamGone = errors.New("flow: stream is gone")

// ErrStreamClosed is the error for an append to a closed stream. Check for it
// with errors.Is.
var ErrStreamClosed = errors.New("flow: stream is closed")

// offsetRE is the rule for an offset to read after: "" or a whole number.
var offsetRE = regexp.MustCompile(`^[0-9]{0,15}$`)

// streamIDRE is the rule for stream IDs.
var streamIDRE = regexp.MustCompile(`^[A-Za-z0-9:_.-]{1,256}$`)

// Streams keeps short lists of items (for example the output of one run) that
// readers can read from any offset, then follow live. A stream belongs to
// this app. Get it with Client.Streams.
//
// One writer per stream: Open it, Append to it, then Close it with an end
// item. Readers use Snapshot (what is there now) or Read (what is there, then
// new items, until the end item). See docs/limits.md for the limits.
type Streams struct {
	c *Client
}

// Streams returns the client's streams API.
func (c *Client) Streams() Streams { return Streams{c: c} }

// StreamOpenOpts is the input of Streams().Open.
type StreamOpenOpts struct {
	// Meta is any JSON value (up to 4 KB) kept with the stream. Optional.
	Meta any
	// TTL deletes the stream this long after Open if it is not closed
	// before. 1s to 7 days.
	TTL time.Duration
}

// StreamItem is one item of a stream.
type StreamItem struct {
	// Offset is the item's place in the stream. Treat it as opaque text: keep
	// the last one you read, and read again after it.
	Offset string          `json:"offset"`
	Item   json.RawMessage `json:"item"`
	// End is true for the end item, which Close writes. It is always last.
	End bool `json:"end,omitempty"`
}

// StreamSnapshot is a stream as it is now.
type StreamSnapshot struct {
	Meta  json.RawMessage `json:"meta"`
	Items []StreamItem    `json:"items"`
	// Ended is true when the stream is closed. Then the last item is the
	// end item.
	Ended bool `json:"ended"`
}

// StreamToken lets one reader (a browser, for example) connect to one stream.
// Hand it to the browser as JSON; the TypeScript readStream reads it.
type StreamToken struct {
	Token  string `json:"token"`
	URL    string `json:"url"`
	Stream string `json:"stream"`
	// ExpiresAt is the connect deadline (ms since epoch), about a minute away.
	ExpiresAt int64 `json:"expiresAt"`
}

func streamPath(id string) (string, error) {
	// "." and ".." would be read as steps in the URL path, and "token" and
	// "connect" are the names of routes.
	if !streamIDRE.MatchString(id) || id == "." || id == ".." || id == "token" || id == "connect" {
		return "", fmt.Errorf("flow: invalid stream id %q (letters, digits, and : _ . -, up to 256; not ., .., token or connect)", id)
	}
	return "/v1/streams/" + url.PathEscape(id), nil
}

// Open makes a stream. created is false when it exists already; then
// nothing changes.
func (s Streams) Open(ctx context.Context, id string, opts StreamOpenOpts) (created bool, err error) {
	path, err := streamPath(id)
	if err != nil {
		return false, err
	}
	body := map[string]any{"appId": s.c.appID, "ttlMs": opts.TTL.Milliseconds()}
	if opts.Meta != nil {
		body["meta"] = opts.Meta
	}
	var res struct {
		Created bool `json:"created"`
	}
	err = s.c.callSigned(ctx, "stream open", http.MethodPost, path+"/open", body, &res)
	return res.Created, err
}

// Append adds 1 to 100 items (each any JSON value, up to 64 KB) in order,
// and returns one offset for each. It fails with ErrStreamGone when the
// stream does not exist, and ErrStreamClosed after Close.
func (s Streams) Append(ctx context.Context, id string, items ...any) ([]string, error) {
	path, err := streamPath(id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, errors.New("flow: Append needs at least one item")
	}
	body := map[string]any{"appId": s.c.appID, "items": items}
	var res struct {
		Offsets []string `json:"offsets"`
	}
	err = s.c.callSigned(ctx, "stream append", http.MethodPost, path+"/append", body, &res)
	return res.Offsets, err
}

// Snapshot returns the items after the offset after ("" is from the start),
// without waiting for more. It reads every page. It returns nil, nil when the
// stream does not exist.
func (s Streams) Snapshot(ctx context.Context, id, after string) (*StreamSnapshot, error) {
	path, err := streamPath(id)
	if err != nil {
		return nil, err
	}
	snap := &StreamSnapshot{Items: []StreamItem{}}
	for first := true; ; first = false {
		q := url.Values{"appId": {s.c.appID}}
		if after != "" {
			q.Set("after", after)
		}
		var page struct {
			StreamSnapshot
			More bool `json:"more"`
		}
		err := s.c.callSigned(ctx, "stream snapshot", http.MethodGet, path+"?"+q.Encode(), nil, &page)
		if errors.Is(err, ErrStreamGone) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if first {
			snap.Meta = page.Meta
		}
		snap.Items = append(snap.Items, page.Items...)
		snap.Ended = page.Ended
		if !page.More || len(page.Items) == 0 {
			return snap, nil
		}
		after = page.Items[len(page.Items)-1].Offset
	}
}

// Close writes end (any JSON value) as the stream's last item and closes the
// stream. The stream is deleted grace later (0 to 7 days), so late readers
// still get the end. closed is false when it was closed already; then
// nothing changes. It fails with ErrStreamGone when the stream does not
// exist.
func (s Streams) Close(ctx context.Context, id string, end any, grace time.Duration) (closed bool, err error) {
	path, err := streamPath(id)
	if err != nil {
		return false, err
	}
	body := map[string]any{"appId": s.c.appID, "end": end, "graceMs": grace.Milliseconds()}
	var res struct {
		Closed bool `json:"closed"`
	}
	err = s.c.callSigned(ctx, "stream close", http.MethodPost, path+"/close", body, &res)
	return res.Closed, err
}

// Delete deletes a stream now. Its readers get ErrStreamGone. deleted is
// false when there was none.
func (s Streams) Delete(ctx context.Context, id string) (deleted bool, err error) {
	path, err := streamPath(id)
	if err != nil {
		return false, err
	}
	q := url.Values{"appId": {s.c.appID}}
	var res struct {
		Deleted bool `json:"deleted"`
	}
	err = s.c.callSigned(ctx, "stream delete", http.MethodDelete, path+"?"+q.Encode(), nil, &res)
	return res.Deleted, err
}

// Token makes a token to read one stream. Call it in your own HTTP handler,
// after you checked that the user may read that stream.
func (s Streams) Token(ctx context.Context, id string) (StreamToken, error) {
	if _, err := streamPath(id); err != nil {
		return StreamToken{}, err
	}
	body := map[string]any{"appId": s.c.appID, "stream": id}
	var tok StreamToken
	err := s.c.callSigned(ctx, "stream token", http.MethodPost, "/v1/streams/token", body, &tok)
	return tok, err
}

// Read yields the items after the offset after ("" is from the start), then
// new items as they are appended, until the end item, which it yields too.
// It makes a new token (Token) before every connect, and connects to the
// client's base URL with the path of the token's URL, not to the host in the
// token.
//
// When the socket drops, it connects again from the last offset it yielded,
// after a wait (1s, doubling up to 30s, with some random), or at once when the
// engine ends the socket at the end of its 1-hour life. So no item is lost or
// yielded twice.
//
// It yields ErrStreamGone (and stops) when the stream does not exist, or is
// deleted while read. It stops with no error when ctx ends or the loop
// breaks, and closes the socket. It also stops with no error, and no item,
// when the stream is closed and has nothing after after (you had the end
// item already; the engine closes the socket with code 4100).
//
// Other errors: a bad id or after, or a token call the engine refuses (4xx),
// is yielded, and Read stops. Anything else is tried again.
func (s Streams) Read(ctx context.Context, id, after string) iter.Seq2[StreamItem, error] {
	return func(yield func(StreamItem, error) bool) {
		// Each range over the sequence starts from the same place.
		after := after
		if _, err := streamPath(id); err != nil {
			yield(StreamItem{}, err)
			return
		}
		if !offsetRE.MatchString(after) {
			yield(StreamItem{}, fmt.Errorf("flow: invalid stream offset %q (a whole number, up to 15 digits)", after))
			return
		}
		failures := 0
		for ctx.Err() == nil {
			code, stop := s.readOnce(ctx, id, &after, &failures, yield)
			if stop || ctx.Err() != nil {
				return
			}
			if code == closeExpired {
				continue
			}
			wait := backoff(failures)
			failures++
			if !sleepCtx(ctx, wait) {
				return
			}
		}
	}
}

// readOnce connects once and yields items until the socket ends. It moves
// *after on with each item. stop is true when Read must end; else code is
// the close code (or -1 when it could not connect).
func (s Streams) readOnce(ctx context.Context, id string, after *string, failures *int,
	yield func(StreamItem, error) bool) (code websocket.StatusCode, stop bool) {
	tok, err := s.Token(ctx, id)
	if err != nil {
		var ae *apiError
		if errors.As(err, &ae) && ae.status/100 == 4 && ae.status != http.StatusTooManyRequests &&
			ae.status != http.StatusRequestTimeout {
			yield(StreamItem{}, err)
			return -1, true
		}
		return -1, false
	}
	q := url.Values{"token": {tok.Token}}
	if *after != "" {
		q.Set("after", *after)
	}
	u, err := s.c.socketURL(tok.URL, q)
	if err != nil {
		yield(StreamItem{}, err)
		return -1, true
	}
	conn, done, err := s.c.dialSocket(ctx, u, "")
	if err != nil {
		return -1, false
	}
	defer done()
	*failures = 0
	// closed acts on the socket's close code.
	closed := func(code websocket.StatusCode) (websocket.StatusCode, bool) {
		switch code {
		case closeGone:
			yield(StreamItem{}, fmt.Errorf("flow: stream %s: %w", id, ErrStreamGone))
			return code, true
		case closeEnded:
			return code, true
		}
		return code, false
	}
	readCtx := context.WithoutCancel(ctx)
	for {
		typ, data, err := conn.Read(readCtx)
		if err != nil {
			if ctx.Err() != nil {
				return -1, true
			}
			return closed(websocket.CloseStatus(err))
		}
		if typ != websocket.MessageText || string(data) == "pong" {
			continue
		}
		var frame struct {
			StreamItem
			Closing *int `json:"closing"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		if frame.Closing != nil {
			// The engine sends {"closing": code} right before it closes the
			// socket. Act on it now, and do not wait for the close frame.
			_ = conn.CloseNow()
			return closed(websocket.StatusCode(*frame.Closing))
		}
		item := frame.StreamItem
		if item.Offset == "" {
			continue
		}
		*after = item.Offset
		if !yield(item, nil) || item.End {
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return websocket.StatusNormalClosure, true
		}
	}
}
