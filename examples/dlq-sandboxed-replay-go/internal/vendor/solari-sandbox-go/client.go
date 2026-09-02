// Package solari is the Go language binding for the Solari sandbox SDK (core
// surface): create/connect/get/kill a sandbox over REST, then drive a live
// session's Commands, Files, Code, and Git namespaces over the control
// WebSocket. It behaves identically on the wire to the reference TypeScript
// (@solarisdk/core) and Python (solari_desktop) SDKs.
package solari

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// ClientOptions configure a Client.
type ClientOptions struct {
	// APIKey authenticates every REST request and control-WS upgrade.
	APIKey string
	// BaseURL is the gateway origin, e.g. https://gw.example.com.
	BaseURL string
	// HTTPClient overrides the default HTTP client (mainly for tests).
	HTTPClient *http.Client
	// CallTimeoutMs is the per-call control-WS RPC timeout. Default 300000.
	CallTimeoutMs int
	// MaxRetries caps idempotent-request retries. Default 5.
	MaxRetries int
	// RetryDelayMs, when non-nil, replaces exponential backoff with a fixed
	// delay (0 disables the wait — handy for tests).
	RetryDelayMs *int
}

// Client talks the SDK ⇆ Gateway REST API and hands back Sandbox handles.
type Client struct {
	http          *httpTransport
	callTimeoutMs int
}

// NewClient constructs a Client.
func NewClient(opts ClientOptions) (*Client, error) {
	retryDelay := -1
	if opts.RetryDelayMs != nil {
		retryDelay = *opts.RetryDelayMs
	}
	ht, err := newHTTPTransport(httpTransportOptions{
		apiKey:       opts.APIKey,
		baseURL:      opts.BaseURL,
		httpClient:   opts.HTTPClient,
		maxRetries:   opts.MaxRetries,
		retryDelayMs: retryDelay,
	})
	if err != nil {
		return nil, err
	}
	return &Client{http: ht, callTimeoutMs: opts.CallTimeoutMs}, nil
}

// buildCreateBody maps CreateOptions onto the POST /sandboxes wire body.
//
// EXTRACTED ON PURPOSE: this is the single place a caller-facing option becomes
// a wire field, so it is also the single place the cross-language wire contract
// can be pinned (see contract_wire_test.go). A field added to CreateOptions but
// not mapped here is invisible on the wire — exactly the silent-drop bug class
// the host-agent's capability negotiation exists to kill, one layer up.
func buildCreateBody(opts CreateOptions) createSandboxRequest {
	kind := opts.Kind
	if kind == "" {
		kind = KindSandbox
	}
	return createSandboxRequest{
		Template:     opts.Template,
		Kind:         kind,
		CPU:          opts.CPU,
		MemMb:        opts.MemMb,
		DiskGb:       opts.DiskGb,
		Envs:         opts.Envs,
		Metadata:     opts.Metadata,
		TimeoutMs:    opts.TimeoutMs,
		FromSnapshot: opts.FromSnapshot,
		Lifecycle:    opts.Lifecycle,
		Resolution:   opts.Resolution,
		Record:       opts.Record,
		Volumes:      opts.Volumes,
	}
}

// Create provisions a new sandbox (POST /sandboxes) and returns a handle. The
// control channel is NOT opened yet; the first Commands.Run may take the
// one-shot HTTP fast path, or call Connect() to open the WS.
func (c *Client) Create(ctx context.Context, opts CreateOptions) (*Sandbox, error) {
	body := buildCreateBody(opts)
	var resp CreateSandboxResponse
	err := c.http.request(ctx, http.MethodPost, "/sandboxes", body, httpRequestOptions{
		idempotencyKey: newIdempotencyKey(),
	}, &resp)
	if err != nil {
		return nil, err
	}
	return c.newSandbox(resp), nil
}

// Get fetches a sandbox's current view (GET /sandboxes/:id).
func (c *Client) Get(ctx context.Context, sandboxID string) (*SandboxView, error) {
	var view SandboxView
	err := c.http.request(ctx, http.MethodGet, "/sandboxes/"+encodeURIComponent(sandboxID), nil, httpRequestOptions{}, &view)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

// Connect re-attaches to a running sandbox by id. When the view carries no
// controlUrl, it is derived by swapping the base URL scheme to ws/wss and
// appending /control/<id>.
func (c *Client) Connect(ctx context.Context, sandboxID string) (*Sandbox, error) {
	view, err := c.Get(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	controlURL := view.ControlURL
	if controlURL == "" {
		controlURL = c.http.wsOrigin() + "/control/" + encodeURIComponent(sandboxID)
	}
	// GET /sandboxes/:id carries no streamUrl (the gateway's view serializer
	// omits it), so derive it the same way controlUrl is derived above — the
	// gateway builds both from the same origin. Desktops only: a headless
	// sandbox has no display, so leaving it empty is the honest answer.
	streamURL := ""
	if view.Kind == KindDesktop {
		streamURL = c.http.wsOrigin() + "/stream/" + encodeURIComponent(sandboxID)
	}
	return c.newSandbox(CreateSandboxResponse{
		SandboxID:  view.SandboxID,
		Kind:       view.Kind,
		ControlURL: controlURL,
		ExpiresAt:  view.ExpiresAt,
		StreamURL:  streamURL,
	}), nil
}

// Kill destroys a sandbox (DELETE /sandboxes/:id). Idempotent.
func (c *Client) Kill(ctx context.Context, sandboxID string) error {
	return c.http.request(ctx, http.MethodDelete, "/sandboxes/"+encodeURIComponent(sandboxID), nil, httpRequestOptions{}, nil)
}

// Pause snapshots a session's RAM+disk and frees its host slot
// (POST /sandboxes/:id/pause). The session keeps its id and can be brought back
// with Resume; its control channel is dead until then.
func (c *Client) Pause(ctx context.Context, sandboxID string) error {
	return c.http.request(ctx, http.MethodPost, "/sandboxes/"+encodeURIComponent(sandboxID)+"/pause", nil, httpRequestOptions{}, nil)
}

// Resume re-hydrates a paused session (POST /sandboxes/:id/resume) and returns
// the control URL to re-attach to.
//
// The session comes back on a FRESH slot, so the control URL it had before the
// pause is stale. The gateway normally returns the new one; when it does not,
// derive it from the gateway origin exactly as Connect does.
func (c *Client) Resume(ctx context.Context, sandboxID string) (string, error) {
	var r resumeResponse
	err := c.http.request(ctx, http.MethodPost, "/sandboxes/"+encodeURIComponent(sandboxID)+"/resume", nil, httpRequestOptions{}, &r)
	if err != nil {
		return "", err
	}
	if r.ControlURL != "" {
		return r.ControlURL, nil
	}
	return c.http.wsOrigin() + "/control/" + encodeURIComponent(sandboxID), nil
}

// exec is the one-shot command fast path (POST /sandboxes/:id/exec).
func (c *Client) exec(ctx context.Context, id string, req execOneShotRequest) (*CommandResult, error) {
	var res CommandResult
	err := c.http.request(ctx, http.MethodPost, "/sandboxes/"+encodeURIComponent(id)+"/exec", req, httpRequestOptions{}, &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// Sandbox is a live session handle exposing the core namespaces.
type Sandbox struct {
	ID         string
	ControlURL string
	ExpiresAt  string
	Kind       SandboxKind
	// StreamURL is the live-view WebSocket URL. Set for KindDesktop only — the
	// gateway omits it for headless sandboxes, which have no display to stream.
	StreamURL string

	ch         *channel
	execHook   func(ctx context.Context, id string, req execOneShotRequest) (*CommandResult, error)
	killHook   func(ctx context.Context, id string) error
	pauseHook  func(ctx context.Context, id string) error
	resumeHook func(ctx context.Context, id string) (string, error)

	Commands *Commands
	Files    *Files
	Code     *Code
	Git      *Git
}

func (c *Client) newSandbox(resp CreateSandboxResponse) *Sandbox {
	header := http.Header{}
	header.Set("Authorization", c.http.authHeader())
	callTimeout := time.Duration(c.callTimeoutMs) * time.Millisecond

	sb := &Sandbox{
		ID:         resp.SandboxID,
		ControlURL: resp.ControlURL,
		ExpiresAt:  resp.ExpiresAt,
		Kind:       resp.Kind,
		StreamURL:  resp.StreamURL,
		ch:         newChannel(resp.ControlURL, header, callTimeout),
		execHook:   c.exec,
		killHook:   c.Kill,
		pauseHook:  c.Pause,
		resumeHook: c.Resume,
	}
	sb.Commands = &Commands{sb: sb}
	sb.Files = &Files{sb: sb}
	sb.Code = &Code{sb: sb}
	sb.Git = newGit(sb.runCommand)
	return sb
}

// Connect opens the control WebSocket. Idempotent.
func (s *Sandbox) Connect(ctx context.Context) error { return s.ch.connect(ctx) }

// Reconnect re-opens the control channel after a drop.
func (s *Sandbox) Reconnect(ctx context.Context) error { return s.ch.reconnect(ctx) }

// Connected reports whether the control channel is open.
func (s *Sandbox) Connected() bool { return s.ch.isConnected() }

// Close closes the control channel locally (does NOT release the remote session).
func (s *Sandbox) Close() { s.ch.close() }

// Pause snapshots this session's RAM+disk, frees its host slot, and closes the
// control channel. The session keeps its id; bring it back with Resume.
//
// Mirrors TS `handle.pause()` / Python `handle.pause()`: the remote call first,
// then the local channel close.
func (s *Sandbox) Pause(ctx context.Context) error {
	if s.pauseHook == nil {
		return newSolariError("pause requires a client-created handle")
	}
	if err := s.pauseHook(ctx, s.ID); err != nil {
		return err
	}
	s.ch.close()
	return nil
}

// Resume re-hydrates this paused session and re-points the control channel at
// the fresh slot it came back on.
//
// Mirrors TS `handle.resume()` / Python `handle.resume()`: resume, adopt the new
// control URL, reconnect.
func (s *Sandbox) Resume(ctx context.Context) error {
	if s.resumeHook == nil {
		return newSolariError("resume requires a client-created handle")
	}
	controlURL, err := s.resumeHook(ctx, s.ID)
	if err != nil {
		return err
	}
	s.ControlURL = controlURL
	s.ch.setControlURL(controlURL)
	return s.ch.reconnect(ctx)
}

// Kill destroys the remote session and closes the channel. Idempotent.
func (s *Sandbox) Kill(ctx context.Context) error {
	var err error
	if s.killHook != nil {
		err = s.killHook(ctx, s.ID)
	}
	s.ch.close()
	return err
}

// unmarshal decodes raw JSON into v, wrapping decode failures as a SolariError.
func unmarshal(raw json.RawMessage, v interface{}) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return newSolariError("failed to decode RPC result: " + err.Error())
	}
	return nil
}
