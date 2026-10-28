package flow

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// What Realtime().Subscribe and Streams().Read share: the socket, the ping,
// and the wait between tries.

const (
	// closeExpired is the close code the engine sends when a socket reaches the
	// end of its 1-hour life. The client connects again at once.
	closeExpired websocket.StatusCode = 4001
	// closeGone is the close code for a stream that does not exist.
	closeGone websocket.StatusCode = 4404
	// closeEnded is the close code for a closed stream with nothing after the
	// reader's offset: the reader had the end item already.
	closeEnded websocket.StatusCode = 4100
	// socketReadLimit is the largest frame we take. A message is up to 64 KB.
	socketReadLimit = 1 << 20
	// minStable is how long a socket must have been open, when it closes, to
	// start the wait between tries again from 1s. A socket that opens and
	// closes at once counts as a failed try, so the wait grows.
	minStable = 10 * time.Second
)

// These are vars so tests can make them short.
var (
	pingEvery  = 30 * time.Second
	minBackoff = time.Second
	maxBackoff = 30 * time.Second
)

// backoff is the wait before the next try after failures failed tries in a
// row: 1s doubling up to 30s, times a random 0.5 to 1.0.
func backoff(failures int) time.Duration {
	d := maxBackoff
	if failures < 16 {
		if b := minBackoff << failures; b < maxBackoff {
			d = b
		}
	}
	return time.Duration(float64(d) * (0.5 + rand.Float64()/2))
}

// resetIfStable sets failures to 0 when the socket, opened at opened, was
// open for at least minStable.
func resetIfStable(failures *int, opened time.Time) {
	if time.Since(opened) >= minStable {
		*failures = 0
	}
}

// sleepCtx waits d, or until ctx ends. It reports whether the wait ran out.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// socketURL is where a socket connects: the client's base URL (http becomes
// ws, https becomes wss), the path of the token's URL, and the query q. The
// host in the token's URL is not used: the engine builds it from the host it
// sees, which is wrong behind a proxy or under wrangler dev, while this
// server already reaches the engine at the base URL.
func (c *Client) socketURL(tokenURL string, q url.Values) (string, error) {
	tu, err := url.Parse(tokenURL)
	if err != nil || tu.Path == "" {
		return "", fmt.Errorf("flow: the token's url %q has no path", tokenURL)
	}
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return "", fmt.Errorf("flow: bad base URL %q: %w", c.baseURL, err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("flow: bad base URL %q: want http or https", c.baseURL)
	}
	u.Path = strings.TrimRight(u.Path, "/") + tu.Path
	u.RawPath = ""
	u.RawQuery = q.Encode()
	u.Fragment = ""
	return u.String(), nil
}

// dialSocket connects to u. While the socket is open it sends "ping" every
// pingEvery, and when ctx ends it closes the socket with code 1000 and
// reason. Read from the socket with a context that does not end (for
// example context.WithoutCancel(ctx)): ctx ending closes it already. Call the
// returned func when done with the socket: it sends a 1000 close, but does
// not wait for the engine's answer, so it returns at once.
func (c *Client) dialSocket(ctx context.Context, u, reason string) (*websocket.Conn, func(), error) {
	conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: c.http})
	if err != nil {
		return nil, nil, err
	}
	conn.SetReadLimit(socketReadLimit)
	pingCtx, stopPing := context.WithCancel(context.Background())
	every := pingEvery
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
				if conn.Write(pingCtx, websocket.MessageText, []byte("ping")) != nil {
					return
				}
			}
		}
	}()
	stopClose := context.AfterFunc(ctx, func() {
		stopPing()
		_ = conn.Close(websocket.StatusNormalClosure, reason)
	})
	done := func() {
		stopClose()
		stopPing()
		// Close waits for the engine's answer (up to 5s): not here.
		go func() { _ = conn.Close(websocket.StatusNormalClosure, reason) }()
	}
	return conn, done, nil
}
