package flow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ClientOpts configures a client. Fields left nil are read from environment
// variables; values set here win.
type ClientOpts struct {
	// AppID names the app. Required.
	AppID string
	// SigningKey checks calls from the engine and signs sync. Env: FLOW_SIGNING_KEY.
	SigningKey *string
	// SigningKeyFallback is the old key while rotating. Env: FLOW_SIGNING_KEY_FALLBACK.
	SigningKeyFallback *string
	// EventKey is used to send events. Env: FLOW_EVENT_KEY.
	EventKey *string
	// BaseURL is the engine URL. Env: FLOW_BASE_URL. Default: DefaultBaseURL.
	BaseURL *string
	// Dev turns off signature checks. Env: FLOW_DEV=1.
	Dev *bool
	// HTTPClient is used for sync and sending events. Default: http.DefaultClient.
	HTTPClient *http.Client
	// NoStreaming turns off streamed answers: answers are sent whole at the end.
	// By default a POST answer is streamed when the engine asks for it, so a
	// proxy in front of the app does not end a long step (see docs/protocol.md).
	NoStreaming bool
	// HeartbeatInterval is the time between heartbeats in a streamed answer.
	// Default: 20s. At least 1ms. It also moves the server's write deadline
	// (http.Server.WriteTimeout) on, so that does not end a long step.
	HeartbeatInterval time.Duration
	// NoSyncOnBoot turns off the sync at boot. By default Serve checks in the
	// background whether the engine has this app's manifest, and syncs when it
	// changed, so a deploy needs no Resync. Then it checks again every
	// checkEveryMs the engine gives (5 min) until Client.Close. It needs the
	// signing key; without one it does nothing.
	NoSyncOnBoot bool
}

// Client holds an app's functions and talks to the engine.
type Client struct {
	appID       string
	signingKey  string
	fallbackKey string
	eventKey    string
	baseURL     string
	dev         bool
	http        *http.Client
	now         func() time.Time
	heartbeat   time.Duration // 0: no streamed answers
	syncOnBoot  bool
	bootOnce    sync.Once
	stop        chan struct{} // closed by Close
	bootDone    chan struct{} // closed when the checks have ended, or will never start
	booted      atomic.Bool   // the checks have started
	closeOnce   sync.Once

	mu        sync.Mutex
	functions []*function
}

// DefaultBaseURL is the engine URL when neither ClientOpts.BaseURL nor
// FLOW_BASE_URL is set. Self-hosters set FLOW_BASE_URL.
const DefaultBaseURL = "https://worker.clevixstudio.com"

func pick(opt *string, env string) string {
	if opt != nil {
		return *opt
	}
	return os.Getenv(env)
}

// NewClient makes a client. It fails if AppID or a signing key is not valid.
func NewClient(opts ClientOpts) (*Client, error) {
	if !idRE.MatchString(opts.AppID) {
		return nil, fmt.Errorf("flow: invalid app id %q (letters, digits, _ and -, up to 64)", opts.AppID)
	}
	c := &Client{
		appID:       opts.AppID,
		signingKey:  pick(opts.SigningKey, "FLOW_SIGNING_KEY"),
		fallbackKey: pick(opts.SigningKeyFallback, "FLOW_SIGNING_KEY_FALLBACK"),
		eventKey:    pick(opts.EventKey, "FLOW_EVENT_KEY"),
		baseURL:     strings.TrimRight(pick(opts.BaseURL, "FLOW_BASE_URL"), "/"),
		http:        opts.HTTPClient,
		now:         time.Now,
		syncOnBoot:  !opts.NoSyncOnBoot,
		stop:        make(chan struct{}),
		bootDone:    make(chan struct{}),
	}
	// Empty counts as not set, like in the TypeScript SDK.
	if c.baseURL == "" {
		c.baseURL = DefaultBaseURL
	}
	if opts.Dev != nil {
		c.dev = *opts.Dev
	} else {
		c.dev = os.Getenv("FLOW_DEV") == "1"
	}
	if c.http == nil {
		c.http = http.DefaultClient
	}
	if !opts.NoStreaming {
		c.heartbeat = opts.HeartbeatInterval
		if c.heartbeat == 0 {
			c.heartbeat = defaultHeartbeat
		}
		if c.heartbeat < time.Millisecond {
			return nil, errors.New("flow: HeartbeatInterval must be at least 1ms")
		}
	}
	for _, k := range []string{c.signingKey, c.fallbackKey} {
		if k == "" {
			continue
		}
		if _, err := parseSigningKey(k); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// AppID returns the app's ID.
func (c *Client) AppID() string { return c.appID }

func (c *Client) add(fn *function) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, f := range c.functions {
		if f.config.ID == fn.config.ID {
			return fmt.Errorf("flow: duplicate function id %q", fn.config.ID)
		}
	}
	c.functions = append(c.functions, fn)
	if c.booted.Load() {
		log.Printf("flow: function %s was made after Serve: the sync check may send the engine a list without it, "+
			"and the engine archives it until the next check. Make all functions before calling Serve", fn.config.ID)
	}
	return nil
}

func (c *Client) find(id string) *function {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, f := range c.functions {
		if f.config.ID == id {
			return f
		}
	}
	return nil
}

// SDKInfo names the SDK in the manifest.
type SDKInfo struct {
	Language string `json:"language"`
	Version  string `json:"version"`
}

// AppManifest is what the app sends on sync and returns on GET.
type AppManifest struct {
	AppID string `json:"appId"`
	// URL is left out of the sync at boot: the engine keeps the URL it has.
	URL       string           `json:"url,omitempty"`
	SDK       *SDKInfo         `json:"sdk,omitempty"`
	Functions []FunctionConfig `json:"functions"`
	// ManifestHash is the SDK's hash of SDK and Functions (see ManifestHash).
	ManifestHash string `json:"manifestHash,omitempty"`
}

// Manifest builds the app's manifest with serveURL as the app URL.
func (c *Client) Manifest(serveURL string) AppManifest {
	c.mu.Lock()
	fns := make([]FunctionConfig, 0, len(c.functions))
	for _, f := range c.functions {
		fns = append(fns, f.config)
	}
	c.mu.Unlock()
	m := AppManifest{
		AppID:     c.appID,
		URL:       serveURL,
		SDK:       &SDKInfo{Language: "go", Version: Version},
		Functions: fns,
	}
	m.ManifestHash = manifestHash(m)
	return m
}

// ManifestHash is the SDK's hash of the app's manifest: "v1:" and the sha256
// of its SDK and functions as JSON with sorted keys. The URL is left out, so
// every copy of the app has the same hash. The engine stores it on sync, and
// the sync at boot syncs only when the engine has a different one.
func (c *Client) ManifestHash() string { return c.Manifest("").ManifestHash }

func manifestHash(m AppManifest) string {
	b, err := json.Marshal(struct {
		SDK       *SDKInfo         `json:"sdk"`
		Functions []FunctionConfig `json:"functions"`
	}{m.SDK, m.Functions})
	if err != nil {
		return ""
	}
	// Through a map and back: json.Marshal sorts map keys, so struct field
	// order does not matter.
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return ""
	}
	if b, err = json.Marshal(v); err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return "v1:" + hex.EncodeToString(sum[:])
}

// Sync sends the manifest to the engine (PUT {base}/apps/{appId}/sync) and
// returns the engine's status code and body.
func (c *Client) Sync(ctx context.Context, serveURL string) (int, []byte, error) {
	if serveURL == "" {
		return 0, nil, errors.New("flow: no serve URL: pass the URL of this app's endpoint")
	}
	status, _, body, err := c.putManifest(ctx, c.Manifest(serveURL))
	return status, body, err
}

func (c *Client) syncURL() string {
	return c.baseURL + "/apps/" + url.PathEscape(c.appID) + "/sync"
}

// putManifest sends m and returns the engine's status, headers and body.
func (c *Client) putManifest(ctx context.Context, m AppManifest) (int, http.Header, []byte, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return 0, nil, nil, err
	}
	return c.doWithKeys(ctx, http.MethodPut, c.syncURL(), body)
}

// doWithKeys sends a request to the engine with the signing key as bearer.
// On a 401 it tries the fallback key, so a sync still works while the keys
// are being rotated. Without a key it sends no bearer.
func (c *Client) doWithKeys(ctx context.Context, method, u string, body []byte) (int, http.Header, []byte, error) {
	keys := []string{}
	for _, k := range []string{c.signingKey, c.fallbackKey} {
		if k != "" {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		keys = append(keys, "")
	}
	var (
		status int
		header http.Header
		b      []byte
	)
	for i, k := range keys {
		var r io.Reader
		if body != nil {
			r = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, r)
		if err != nil {
			return 0, nil, nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if k != "" {
			bearer, err := signingKeyBearer(k)
			if err != nil {
				return 0, nil, nil, err
			}
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		status, header, b, err = c.doHeader(req)
		if err != nil {
			return 0, nil, nil, err
		}
		if status != http.StatusUnauthorized || i == len(keys)-1 {
			break
		}
	}
	return status, header, b, nil
}

func (c *Client) do(req *http.Request) (int, []byte, error) {
	status, _, b, err := c.doHeader(req)
	return status, b, err
}

func (c *Client) doHeader(req *http.Request) (int, http.Header, []byte, error) {
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	return res.StatusCode, res.Header, b, err
}

// Send sends one event and returns its ID.
func (c *Client) Send(ctx context.Context, event Event) (string, error) {
	ids, err := c.send(ctx, event)
	if err != nil {
		return "", err
	}
	if len(ids) != 1 {
		return "", fmt.Errorf("flow: engine returned %d ids for one event", len(ids))
	}
	return ids[0], nil
}

// SendMany sends up to 100 events in one request and returns their IDs.
func (c *Client) SendMany(ctx context.Context, events []Event) ([]string, error) {
	if len(events) == 0 {
		return nil, errors.New("flow: SendMany needs at least one event")
	}
	return c.send(ctx, events)
}

func (c *Client) send(ctx context.Context, payload any) ([]string, error) {
	if c.eventKey == "" {
		return nil, errors.New("flow: no event key (set FLOW_EVENT_KEY or ClientOpts.EventKey)")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/e", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.eventKey)
	status, b, err := c.do(req)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		if e.Error == "" {
			e.Error = strings.TrimSpace(string(b))
		}
		return nil, fmt.Errorf("flow: sending events failed (%d): %s", status, e.Error)
	}
	var out struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("flow: cannot read the engine's answer: %w", err)
	}
	return out.IDs, nil
}
