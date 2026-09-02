// Command dlq-sandboxed-replay is a pre-flight check for DLQ Inspector's
// (github.com/HalxDocs/dlqctl) replay/recover workflow.
//
// DLQ Inspector already classifies dead-lettered messages as REPLAYABLE,
// REQUIRES_FIX, DO_NOT_REPLAY, or INVESTIGATE before touching production. This
// program is a candidate implementation of the classifier's missing piece: it
// doesn't guess whether a replay would succeed, it actually runs the
// consumer's handler against the exact payload that dead-lettered, inside an
// isolated Solari sandbox (a hardware-isolated microVM that boots from a
// snapshot in ~1s), and reports what really happened.
//
// That means:
//   - A replay that would fail again gets caught before it burns a real
//     attempt (and, for payment webhooks, before it risks a duplicate side
//     effect).
//   - The handler runs untouched and untrusted — no risk to the operator's
//     own machine or the production environment.
//   - The result (exit code, stdout, stderr, decision) is structured JSON,
//     so dlqctl's Planner can consume it directly as an Executor pre-check.
//
// Usage:
//
//	export SOLARI_API_KEY=slr_live_...
//	go run . -payload testdata/payload.json -handler testdata/handler.py
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	solari "github.com/solari-sdk/solari-sandbox-go"
)

// Decision mirrors DLQ Inspector's recovery-engine classifier states, so this
// tool's report can be fed straight into dlqctl's plan step.
type Decision string

const (
	Replayable  Decision = "REPLAYABLE"   // ran clean; safe to promote to a real replay
	RequiresFix Decision = "REQUIRES_FIX" // reproduced the original failure deterministically
	Investigate Decision = "INVESTIGATE"  // ran, but produced no clear signal either way
)

// Report is the structured result of one sandboxed replay attempt.
type Report struct {
	MessageID string   `json:"message_id"`
	SandboxID string   `json:"sandbox_id"`
	ExitCode  int      `json:"exit_code"`
	Stdout    string   `json:"stdout,omitempty"`
	Stderr    string   `json:"stderr,omitempty"`
	Decision  Decision `json:"decision"`
	Reason    string   `json:"reason"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		payloadPath = flag.String("payload", "testdata/payload.json", "path to the dead-lettered message JSON")
		handlerPath = flag.String("handler", "testdata/handler.py", "path to the consumer handler to replay")
		baseURL     = flag.String("base-url", "", "Solari gateway base URL (optional; defaults to the SDK's default)")
		timeout     = flag.Duration("timeout", 30*time.Second, "max time to let the sandboxed replay run")
	)
	flag.Parse()

	apiKey := os.Getenv("SOLARI_API_KEY")
	if apiKey == "" {
		return errors.New("SOLARI_API_KEY is not set (grab one at console.getsolari.com)")
	}

	payload, err := os.ReadFile(*payloadPath)
	if err != nil {
		return fmt.Errorf("read payload: %w", err)
	}
	handlerSrc, err := os.ReadFile(*handlerPath)
	if err != nil {
		return fmt.Errorf("read handler: %w", err)
	}

	var msg struct {
		MessageID string `json:"message_id"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return fmt.Errorf("parse payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	// The standalone Sandbox Go SDK requires BaseURL explicitly, unlike the
	// umbrella SolariClient in @solarisdk/sdk which defaults it. Default to the
	// public gateway so `go run .` works without -base-url.
	if *baseURL == "" {
		*baseURL = "https://api.getsolari.com"
	}
	client, err := solari.NewClient(solari.ClientOptions{APIKey: apiKey, BaseURL: *baseURL})
	if err != nil {
		return fmt.Errorf("build solari client: %w", err)
	}

	sb, err := client.Create(ctx, solari.CreateOptions{Template: "base"})
	if err != nil {
		var capErr *solari.ConcurrencyLimitError
		var authErr *solari.AuthError
		var noCap *solari.NoCapacityError
		switch {
		case errors.As(err, &capErr):
			return fmt.Errorf("org is at its live-sandbox cap (not retryable): %w", err)
		case errors.As(err, &authErr):
			return fmt.Errorf("bad or missing SOLARI_API_KEY: %w", err)
		case errors.As(err, &noCap):
			return fmt.Errorf("no host capacity right now, safe to retry: %w", err)
		default:
			return fmt.Errorf("create sandbox: %w", err)
		}
	}
	// Always tear the sandbox down, even if a step below fails.
	defer sb.Kill(context.Background())

	if err := sb.Files.Write(ctx, "payload.json", payload, 0); err != nil {
		return fmt.Errorf("upload payload into sandbox: %w", err)
	}
	if err := sb.Files.Write(ctx, "handler.py", handlerSrc, 0); err != nil {
		return fmt.Errorf("upload handler into sandbox: %w", err)
	}

	res, err := sb.Commands.Run(ctx, "python3", solari.CommandOptions{
		Args: []string{"handler.py", "payload.json"},
	})
	if err != nil {
		return fmt.Errorf("run handler in sandbox: %w", err)
	}

	report := classify(msg.MessageID, sb.ID, res)

	out, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal report: %w", err)
	}
	fmt.Println(string(out))

	return nil
}

// classify turns a raw sandboxed run into a replay decision. It intentionally
// stays conservative: a clean exit is the only thing that earns REPLAYABLE.
func classify(messageID, sandboxID string, res *solari.CommandResult) Report {
	r := Report{
		MessageID: messageID,
		SandboxID: sandboxID,
		ExitCode:  res.ExitCode,
		Stdout:    res.Stdout,
		Stderr:    res.Stderr,
	}

	switch {
	case res.ExitCode == 0:
		r.Decision = Replayable
		r.Reason = "handler completed with exit 0 against the dead-lettered payload; safe to promote to a real replay"
	case res.Stderr != "":
		r.Decision = RequiresFix
		r.Reason = "handler reproduced a failure deterministically; replaying against production would fail the same way"
	default:
		r.Decision = Investigate
		r.Reason = "handler exited non-zero with no stderr signal; needs a human look before replay"
	}
	return r
}
