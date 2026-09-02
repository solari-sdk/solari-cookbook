package solari

import (
	"context"
	"encoding/base64"
	"sync"
)

// Commands is the process-execution namespace on a Sandbox.
type Commands struct {
	sb *Sandbox
}

// Run executes a command to completion and returns its terminal result.
// OnStdout/OnStderr (if set) receive output as it streams.
func (c *Commands) Run(ctx context.Context, cmd string, opts CommandOptions) (*CommandResult, error) {
	return c.sb.runCommand(ctx, cmd, opts)
}

// Start launches a command and returns a handle immediately (does not wait for
// exit). Output streams as cmd.data frames; the handle exposes Stdin, OnData,
// Wait, and Kill.
func (c *Commands) Start(ctx context.Context, cmd string, opts CommandOptions) (*CommandHandle, error) {
	return c.sb.startCommand(ctx, cmd, opts)
}

type dataChunk struct {
	stream string
	data   string
}

type exitResult struct {
	code int
	err  error
}

// CommandHandle is a started command from Commands.Start.
type CommandHandle struct {
	CmdID string
	ch    *channel

	mu       sync.Mutex
	dataCbs  []func(stream, data string)
	buffered []dataChunk

	exitCh   chan exitResult
	exitOnce sync.Once
}

// OnData subscribes to stdout/stderr chunks. Any output buffered before the
// first subscriber is replayed so early output is never dropped.
func (h *CommandHandle) OnData(cb func(stream, data string)) {
	h.mu.Lock()
	if len(h.buffered) > 0 {
		buffered := h.buffered
		h.buffered = nil
		h.mu.Unlock()
		for _, c := range buffered {
			cb(c.stream, c.data)
		}
		h.mu.Lock()
	}
	h.dataCbs = append(h.dataCbs, cb)
	h.mu.Unlock()
}

// Wait blocks until the command exits (or the channel drops / ctx is cancelled)
// and returns the exit code.
func (h *CommandHandle) Wait(ctx context.Context) (int, error) {
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case r := <-h.exitCh:
		return r.code, r.err
	}
}

// Stdin writes bytes/text to the command's stdin.
func (h *CommandHandle) Stdin(ctx context.Context, data []byte) error {
	_, err := h.ch.call(ctx, "cmd.stdin", map[string]interface{}{
		"cmdId":  h.CmdID,
		"base64": base64.StdEncoding.EncodeToString(data),
	}, callOptions{})
	return err
}

// Kill sends a signal (default SIGTERM when signal <= 0) to the command.
func (h *CommandHandle) Kill(ctx context.Context, signal int) error {
	params := map[string]interface{}{"cmdId": h.CmdID}
	if signal > 0 {
		params["signal"] = signal
	}
	_, err := h.ch.call(ctx, "cmd.kill", params, callOptions{})
	return err
}

func (h *CommandHandle) deliver(chunk dataChunk) {
	h.mu.Lock()
	if len(h.dataCbs) == 0 {
		h.buffered = append(h.buffered, chunk)
		h.mu.Unlock()
		return
	}
	cbs := append([]func(stream, data string){}, h.dataCbs...)
	h.mu.Unlock()
	for _, cb := range cbs {
		cb(chunk.stream, chunk.data)
	}
}

func (h *CommandHandle) finishExit(code int, err error) {
	h.exitOnce.Do(func() {
		h.exitCh <- exitResult{code: code, err: err}
	})
}

// startCommand issues cmd.start and wires the async cmd.data/cmd.exit handlers.
func (s *Sandbox) startCommand(ctx context.Context, cmd string, opts CommandOptions) (*CommandHandle, error) {
	params := map[string]interface{}{"cmd": cmd}
	if opts.Args != nil {
		params["args"] = opts.Args
	}
	if opts.Cwd != "" {
		params["cwd"] = opts.Cwd
	}
	if opts.Env != nil {
		params["env"] = opts.Env
	}
	if opts.User != "" {
		params["user"] = opts.User
	}

	raw, err := s.ch.call(ctx, "cmd.start", params, callOptions{})
	if err != nil {
		return nil, err
	}
	var res struct {
		CmdID string `json:"cmdId"`
	}
	if err := unmarshal(raw, &res); err != nil {
		return nil, err
	}
	cmdID := res.CmdID

	h := &CommandHandle{
		CmdID:  cmdID,
		ch:     s.ch,
		exitCh: make(chan exitResult, 1),
	}

	// Route streaming callbacks straight through (before returning the handle),
	// mirroring the reference SDK so early output reaches OnStdout/OnStderr.
	if opts.OnStdout != nil || opts.OnStderr != nil {
		h.dataCbs = append(h.dataCbs, func(stream, data string) {
			if stream == "stdout" {
				if opts.OnStdout != nil {
					opts.OnStdout(data)
				}
			} else if opts.OnStderr != nil {
				opts.OnStderr(data)
			}
		})
	}

	// If the channel drops before cmd.exit, wake Wait() with the error.
	s.ch.onStreamClose(cmdID, func(err error) { h.finishExit(0, err) })

	s.ch.onFrame("cmd.data", cmdID, func(f asyncFrame) {
		stream := f.Stream
		if stream == "" {
			stream = "stdout"
		}
		data := ""
		if f.Base64 != "" {
			if b, derr := base64.StdEncoding.DecodeString(f.Base64); derr == nil {
				data = string(b)
			}
		}
		h.deliver(dataChunk{stream: stream, data: data})
	})
	s.ch.onFrame("cmd.exit", cmdID, func(f asyncFrame) {
		s.ch.offFrame("cmd.data", cmdID)
		s.ch.offFrame("cmd.exit", cmdID)
		s.ch.offStreamClose(cmdID)
		code := 0
		if f.ExitCode != nil {
			code = *f.ExitCode
		}
		h.finishExit(code, nil)
	})

	return h, nil
}

// runCommand runs a command to completion. It prefers the one-shot HTTP fast
// path (no cold WS handshake) for a plain run-to-completion, falling back to the
// control-WS path when the fast path is unavailable or unsuitable.
func (s *Sandbox) runCommand(ctx context.Context, cmd string, opts CommandOptions) (*CommandResult, error) {
	if s.execHook != nil &&
		!opts.Background &&
		opts.OnStdout == nil &&
		opts.OnStderr == nil &&
		opts.Env == nil &&
		opts.User == "" &&
		!s.ch.isConnected() {
		res, err := s.execHook(ctx, s.ID, execOneShotRequest{
			Cmd:       cmd,
			Args:      opts.Args,
			Cwd:       opts.Cwd,
			TimeoutMs: opts.TimeoutMs,
		})
		if err == nil {
			return res, nil
		}
		// Fall back to the WS path ONLY when /exec isn't served (older gateway).
		// Any other failure propagates so we never silently double-execute.
		if !isRouteUnavailable(err) {
			return nil, err
		}
	}

	handle, err := s.startCommand(ctx, cmd, opts)
	if err != nil {
		return nil, err
	}

	var mu sync.Mutex
	var stdout, stderr []byte
	handle.OnData(func(stream, data string) {
		mu.Lock()
		if stream == "stdout" {
			stdout = append(stdout, data...)
		} else {
			stderr = append(stderr, data...)
		}
		mu.Unlock()
	})

	if opts.Background {
		return &CommandResult{ExitCode: 0, Stdout: "", Stderr: ""}, nil
	}

	code, err := handle.Wait(ctx)
	if err != nil {
		return nil, err
	}
	mu.Lock()
	defer mu.Unlock()
	return &CommandResult{ExitCode: code, Stdout: string(stdout), Stderr: string(stderr)}, nil
}
