package flow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
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
	// ServeURL is this endpoint's public URL, for example
	// "https://billing.example.com/api/flow". It is used only as the url in the
	// manifest (the GET answer and the PUT sync). Set it when a proxy in front of
	// the app changes the host or path, so the app does not see its public URL.
	// Env: FLOW_SERVE_URL. Default: the URL the request shows.
	ServeURL *string
	// Dev turns off signature checks. Env: FLOW_DEV=1.
	Dev *bool
	// HTTPClient is used for sync and sending events. Default: http.DefaultClient.
	HTTPClient *http.Client
}

// Client holds an app's functions and talks to the engine.
type Client struct {
	appID       string
	signingKey  string
	fallbackKey string
	eventKey    string
	baseURL     string
	serveURL    string
	dev         bool
	http        *http.Client
	now         func() time.Time

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
		serveURL:    pick(opts.ServeURL, "FLOW_SERVE_URL"),
		http:        opts.HTTPClient,
		now:         time.Now,
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
	if c.serveURL != "" {
		// The engine compares host and path, so keep only scheme, host and path.
		u, err := url.Parse(c.serveURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
			u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
			return nil, fmt.Errorf("flow: the serve URL %q (FLOW_SERVE_URL) must be a full http or https URL with no user, query or fragment", c.serveURL)
		}
		c.serveURL = u.Scheme + "://" + u.Host + u.EscapedPath()
	}
	if c.http == nil {
		c.http = http.DefaultClient
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
	AppID     string           `json:"appId"`
	URL       string           `json:"url"`
	SDK       *SDKInfo         `json:"sdk,omitempty"`
	Functions []FunctionConfig `json:"functions"`
}

// Manifest builds the app's manifest with serveURL as the app URL.
func (c *Client) Manifest(serveURL string) AppManifest {
	c.mu.Lock()
	defer c.mu.Unlock()
	fns := make([]FunctionConfig, 0, len(c.functions))
	for _, f := range c.functions {
		fns = append(fns, f.config)
	}
	return AppManifest{
		AppID:     c.appID,
		URL:       serveURL,
		SDK:       &SDKInfo{Language: "go", Version: Version},
		Functions: fns,
	}
}

// Sync sends the manifest to the engine (PUT {base}/apps/{appId}/sync) and
// returns the engine's status code and body. An empty serveURL means ServeURL
// (FLOW_SERVE_URL).
func (c *Client) Sync(ctx context.Context, serveURL string) (int, []byte, error) {
	if serveURL == "" {
		serveURL = c.serveURL
	}
	if serveURL == "" {
		return 0, nil, errors.New("flow: no serve URL: pass the URL of this app's endpoint, or set ServeURL")
	}
	body, err := json.Marshal(c.Manifest(serveURL))
	if err != nil {
		return 0, nil, err
	}
	u := c.baseURL + "/apps/" + url.PathEscape(c.appID) + "/sync"
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.signingKey != "" {
		bearer, err := signingKeyBearer(c.signingKey)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return c.do(req)
}

func (c *Client) do(req *http.Request) (int, []byte, error) {
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	return res.StatusCode, b, err
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
