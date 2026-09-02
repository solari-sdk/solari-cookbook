package solari

// channel is the shared control-WebSocket transport. Wire protocol is
// newline-delimited JSON; THREE frame kinds share the socket and are dispatched
// by SHAPE, never by assuming one-reply-per-request:
//
//  1. JSON-RPC reply       {id, ok, result?|error?}  — resolves the call id.
//  2. v1 streamed exec      {id, stream, data}        — routed to a per-id handler.
//  3. v2 async STREAM frame {type, cmdId|ptyId|watchId, ...} — NOT correlated to
//     a request id; dispatched by (type, streamId).
//
// gorilla delivers whole messages, but the server may pack multiple
// newline-delimited frames into one WS message OR split one frame across
// messages, so we buffer bytes and split on '\n' ourselves.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultCallTimeout = 300 * time.Second
	connectTimeout     = 15 * time.Second
	connectMaxAttempts = 3
	connectRetryBaseMs = 150
	maxOrphanFrames    = 1024
)

// asyncFrame is a v2 async STREAM frame carrying its own stream id.
type asyncFrame struct {
	Type     string
	CmdID    string
	PtyID    string
	WatchID  string
	Stream   string
	Base64   string
	ExitCode *int
	Path     string
}

type frameHandler func(asyncFrame)

type v1StreamHandler func(stream string, data string)

// inboundFrame is the union of every field the three frame kinds may carry.
type inboundFrame struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	OK       *bool           `json:"ok"`
	Result   json.RawMessage `json:"result"`
	Error    json.RawMessage `json:"error"`
	Stream   string          `json:"stream"`
	Data     *string         `json:"data"`
	CmdID    string          `json:"cmdId"`
	PtyID    string          `json:"ptyId"`
	WatchID  string          `json:"watchId"`
	Base64   string          `json:"base64"`
	ExitCode *int            `json:"exitCode"`
	Path     string          `json:"path"`
}

type callResult struct {
	result json.RawMessage
	err    error
}

type pendingCall struct {
	resultCh chan callResult // buffered (1) so a settled sender never blocks
	method   string
}

type channel struct {
	controlURL  string
	header      http.Header
	callTimeout time.Duration
	dialer      *websocket.Dialer

	writeMu sync.Mutex
	conn    *websocket.Conn

	// rxBuffer accumulates partial reads; touched only by the read loop / feed.
	rxBuffer []byte

	mu             sync.Mutex
	nextID         int
	connected      bool
	closed         bool
	pending        map[string]*pendingCall
	streamHandlers map[string]v1StreamHandler
	frameHandlers  map[string]map[string]frameHandler
	orphanFrames   map[string][]asyncFrame
	orphanCount    int
	streamClosers  map[string]func(error)
}

func newChannel(controlURL string, header http.Header, callTimeout time.Duration) *channel {
	if callTimeout <= 0 {
		callTimeout = defaultCallTimeout
	}
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = connectTimeout
	return &channel{
		controlURL:     controlURL,
		header:         header,
		callTimeout:    callTimeout,
		dialer:         &d,
		nextID:         1,
		pending:        map[string]*pendingCall{},
		streamHandlers: map[string]v1StreamHandler{},
		frameHandlers:  map[string]map[string]frameHandler{},
		orphanFrames:   map[string][]asyncFrame{},
		streamClosers:  map[string]func(error){},
	}
}

func (c *channel) isConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

func (c *channel) setControlURL(url string) {
	c.mu.Lock()
	c.controlURL = url
	c.mu.Unlock()
}

// connect opens the control WebSocket, retrying a fast-failing dial a couple of
// times (a freshly restored guest can transiently 502 a concurrent upgrade). A
// full connect timeout is NOT retried.
func (c *channel) connect(ctx context.Context) error {
	if c.isConnected() {
		return nil
	}
	c.mu.Lock()
	c.closed = false
	url := c.controlURL
	c.mu.Unlock()

	var lastErr error = newConnectionError("connect failed")
	for attempt := 1; attempt <= connectMaxAttempts; attempt++ {
		err := c.connectOnce(ctx, url)
		if err == nil {
			return nil
		}
		lastErr = err
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		var te *TimeoutError
		if closed || errors.As(err, &te) {
			break
		}
		if attempt < connectMaxAttempts {
			timer := time.NewTimer(time.Duration(connectRetryBaseMs*attempt) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
	return lastErr
}

func (c *channel) connectOnce(ctx context.Context, url string) error {
	start := time.Now()
	dialCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, _, err := c.dialer.DialContext(dialCtx, url, c.header)
	if err != nil {
		// Treat a dial that ran to (near) the handshake timeout as a genuine
		// connect timeout (not a transient); everything else is retryable.
		if time.Since(start) >= connectTimeout-time.Second {
			return newTimeoutError("connect", int(connectTimeout/time.Millisecond))
		}
		return newConnectionError(fmt.Sprintf("connect failed: %v", err))
	}
	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.mu.Unlock()
	go c.readLoop(conn)
	return nil
}

// reconnect re-opens the socket after a drop.
func (c *channel) reconnect(ctx context.Context) error {
	if c.isConnected() {
		return nil
	}
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()
	return c.connect(ctx)
}

func (c *channel) readLoop(conn *websocket.Conn) {
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			c.onClose(err)
			return
		}
		c.feed(msg)
	}
}

// feed accumulates bytes and dispatches every complete newline-delimited frame.
// Exposed (unexported) so tests can drive framing directly without a socket.
func (c *channel) feed(chunk []byte) {
	c.rxBuffer = append(c.rxBuffer, chunk...)
	for {
		i := bytes.IndexByte(c.rxBuffer, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimSpace(c.rxBuffer[:i])
		rest := c.rxBuffer[i+1:]
		// Copy the remaining tail into a fresh buffer so dispatching a cloned
		// line can't be aliased by later appends.
		c.rxBuffer = append([]byte(nil), rest...)
		if len(line) > 0 {
			c.dispatch(append([]byte(nil), line...))
		}
	}
}

func (c *channel) dispatch(line []byte) {
	var f inboundFrame
	if err := json.Unmarshal(line, &f); err != nil {
		return // ignore non-JSON noise
	}

	// (3) v2 async STREAM frame — dispatched by type + its own stream id.
	if f.Type != "" {
		streamID := firstNonEmpty(f.CmdID, f.PtyID, f.WatchID)
		af := asyncFrame{
			Type: f.Type, CmdID: f.CmdID, PtyID: f.PtyID, WatchID: f.WatchID,
			Stream: f.Stream, Base64: f.Base64, ExitCode: f.ExitCode, Path: f.Path,
		}
		c.mu.Lock()
		var h frameHandler
		if m := c.frameHandlers[f.Type]; m != nil {
			h = m[streamID]
		}
		if h != nil {
			c.mu.Unlock()
			h(af)
			return
		}
		if c.orphanCount < maxOrphanFrames {
			key := f.Type + "\x1f" + streamID
			c.orphanFrames[key] = append(c.orphanFrames[key], af)
			c.orphanCount++
		}
		c.mu.Unlock()
		return
	}

	if f.ID == "" {
		return
	}

	// (2) v1 streamed-exec frame — route to the per-id stream handler.
	if f.Stream != "" {
		c.mu.Lock()
		h := c.streamHandlers[f.ID]
		c.mu.Unlock()
		if h != nil {
			data := ""
			if f.Data != nil {
				data = *f.Data
			}
			h(f.Stream, data)
		}
		return
	}

	// (1) JSON-RPC reply.
	c.mu.Lock()
	p := c.pending[f.ID]
	if p == nil {
		c.mu.Unlock()
		return
	}
	delete(c.pending, f.ID)
	delete(c.streamHandlers, f.ID)
	c.mu.Unlock()

	if f.OK != nil && *f.OK {
		p.resultCh <- callResult{result: f.Result}
	} else {
		msg, code := normalizeRPCError(f.Error)
		p.resultCh <- callResult{err: &ActionError{
			SolariError: SolariError{Message: msg},
			Method:      p.method,
			Code:        code,
		}}
	}
}

func (c *channel) onClose(err error) {
	c.mu.Lock()
	c.connected = false
	c.conn = nil
	c.mu.Unlock()
	c.failAll(newConnectionError(fmt.Sprintf("Control channel closed: %v", err)))
}

// failAll rejects every in-flight RPC call AND every in-flight stream wait, then
// drops all handler + orphan state.
func (c *channel) failAll(err error) {
	c.mu.Lock()
	pend := c.pending
	closers := c.streamClosers
	c.pending = map[string]*pendingCall{}
	c.streamHandlers = map[string]v1StreamHandler{}
	c.frameHandlers = map[string]map[string]frameHandler{}
	c.orphanFrames = map[string][]asyncFrame{}
	c.orphanCount = 0
	c.streamClosers = map[string]func(error){}
	c.mu.Unlock()

	for _, p := range pend {
		p.resultCh <- callResult{err: err}
	}
	for _, cb := range closers {
		cb(err)
	}
}

// close tears down the channel locally and rejects in-flight work.
func (c *channel) close() {
	c.mu.Lock()
	c.closed = true
	c.connected = false
	conn := c.conn
	c.conn = nil
	c.mu.Unlock()
	c.failAll(newConnectionError("Control channel closed"))
	if conn != nil {
		conn.Close()
	}
}

// newIDLocked allocates the next opaque request id. Caller holds c.mu.
func (c *channel) newIDLocked() string {
	id := c.nextID
	c.nextID++
	return fmt.Sprintf("%d", id)
}

// --- async frame subscriptions (v2) -----------------------------------------

// onFrame registers a handler for an async-frame type keyed on its stream id,
// flushing any orphan frames that arrived before this registration.
func (c *channel) onFrame(typ, id string, h frameHandler) {
	c.mu.Lock()
	m := c.frameHandlers[typ]
	if m == nil {
		m = map[string]frameHandler{}
		c.frameHandlers[typ] = m
	}
	m[id] = h
	key := typ + "\x1f" + id
	pending := c.orphanFrames[key]
	if pending != nil {
		delete(c.orphanFrames, key)
		c.orphanCount -= len(pending)
	}
	c.mu.Unlock()
	for _, f := range pending {
		h(f)
	}
}

func (c *channel) offFrame(typ, id string) {
	c.mu.Lock()
	if m := c.frameHandlers[typ]; m != nil {
		delete(m, id)
	}
	c.mu.Unlock()
}

// onStreamClose registers a "channel closed" callback for a stream id so a drop
// rejects its in-flight wait.
//
// If the channel is ALREADY torn down when this is called, fire the callback
// synchronously instead of storing it — otherwise the wakeup is lost. A caller
// registers this AFTER the cmd.start reply resolves; if the channel closed in
// that window failAll has already drained streamClosers, so a late store would
// sit unreferenced and Wait() would block forever. This window is genuinely
// reachable in Go: the read pump runs on its own goroutine and can call
// failAll concurrently with a caller registering here.
func (c *channel) onStreamClose(id string, cb func(error)) {
	c.mu.Lock()
	if c.closed || !c.connected {
		c.mu.Unlock()
		cb(newConnectionError("Control channel closed"))
		return
	}
	c.streamClosers[id] = cb
	c.mu.Unlock()
}

func (c *channel) offStreamClose(id string) {
	c.mu.Lock()
	delete(c.streamClosers, id)
	c.mu.Unlock()
}

// callOptions tune a single call.
type callOptions struct {
	// id lets callers pre-allocate the request id (so they can subscribe to v2
	// async frames keyed on the same id before the reply lands).
	id string
	// onStream receives v1 {id, stream, data} frames for this call.
	onStream v1StreamHandler
	// timeout overrides the per-channel call timeout.
	timeout time.Duration
}

// call sends one JSON-RPC request and awaits its correlated reply, returning the
// raw result JSON.
func (c *channel) call(ctx context.Context, method string, params interface{}, opts callOptions) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, newConnectionError("Control channel is closed")
	}
	if !c.connected || c.conn == nil {
		c.mu.Unlock()
		return nil, newConnectionError("Not connected — call Connect() first")
	}
	id := opts.id
	if id == "" {
		id = c.newIDLocked()
	}
	p := &pendingCall{resultCh: make(chan callResult, 1), method: method}
	c.pending[id] = p
	if opts.onStream != nil {
		c.streamHandlers[id] = opts.onStream
	}
	c.mu.Unlock()

	frame, err := json.Marshal(map[string]interface{}{"id": id, "method": method, "params": params})
	if err != nil {
		c.removePending(id)
		return nil, newSolariError(fmt.Sprintf("failed to marshal %q: %v", method, err))
	}
	frame = append(frame, '\n')

	c.writeMu.Lock()
	werr := c.conn.WriteMessage(websocket.TextMessage, frame)
	c.writeMu.Unlock()
	if werr != nil {
		c.removePending(id)
		return nil, newConnectionError(fmt.Sprintf("failed to send %q: %v", method, werr))
	}

	timeout := opts.timeout
	if timeout <= 0 {
		timeout = c.callTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		c.removePending(id)
		return nil, ctx.Err()
	case <-timer.C:
		c.removePending(id)
		return nil, newTimeoutError(method, int(timeout/time.Millisecond))
	case r := <-p.resultCh:
		return r.result, r.err
	}
}

func (c *channel) removePending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	delete(c.streamHandlers, id)
	c.mu.Unlock()
}

// normalizeRPCError extracts a message + code from a reply's error field, which
// may be a string OR {code?, message?}.
func normalizeRPCError(raw json.RawMessage) (message, code string) {
	if len(raw) == 0 || string(raw) == "null" {
		return "Action failed", ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, ""
	}
	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &body) == nil {
		switch {
		case body.Message != "":
			return body.Message, body.Code
		case body.Code != "":
			return body.Code, body.Code
		}
	}
	return "Action failed", ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
