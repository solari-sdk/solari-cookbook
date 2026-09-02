# solari-sdk-go

Go language binding for the Solari sandbox SDK (core surface): create / connect /
kill a sandbox over REST, then drive a live session's **Commands**, **Files**,
**Code**, and **Git** namespaces over the control WebSocket. It behaves
identically on the wire to the reference TypeScript (`@solarisdk/core`) and
Python (`solari_desktop`) SDKs — see `../PROTOCOL.md` for the contract.

```
import "github.com/solari-sdk/solari-sandbox-go"
```

Module path: `github.com/solari-sdk/solari-sandbox-go`, package `solari`.
Requires Go 1.23+ and `github.com/gorilla/websocket`.

## Design

- **Context-first.** Every network method takes `ctx context.Context` first.
- **Errors as typed values.** `*AuthError`, `*PlanError`, `*ConcurrencyLimitError`,
  `*NoCapacityError`, `*GatewayError`, `*ActionError`, `*ConnectionError`,
  `*TimeoutError`, all embedding the base `*SolariError`. Match with `errors.As`.
- **Two transports.** REST to the gateway for session lifecycle + the one-shot
  `/exec` fast path; a control WebSocket (newline-delimited JSON RPC) for a live
  session. The first `Commands.Run` on an unconnected sandbox uses the warm REST
  `/exec` path, skipping the cold WS handshake; call `Connect(ctx)` to open the
  WS for streaming/interactive work.

## Example: create → run a command → git

```go
package main

import (
	"context"
	"fmt"
	"log"

	solari "github.com/solari-sdk/solari-sandbox-go"
)

func main() {
	ctx := context.Background()

	client, err := solari.NewClient(solari.ClientOptions{
		APIKey:  "slr_live_…",
		BaseURL: "https://gw.example.com",
	})
	if err != nil {
		log.Fatal(err)
	}

	// Create a sandbox.
	sb, err := client.Create(ctx, solari.CreateOptions{Template: "base"})
	if err != nil {
		log.Fatal(err)
	}
	defer sb.Kill(ctx)

	// Run a command (this first call uses the warm REST /exec fast path).
	res, err := sb.Commands.Run(ctx, "echo", solari.CommandOptions{
		Args: []string{"hello", "world"},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("exit=%d stdout=%q\n", res.ExitCode, res.Stdout)

	// Streaming a long-running command opens the control WebSocket.
	if err := sb.Connect(ctx); err != nil {
		log.Fatal(err)
	}
	_, err = sb.Commands.Run(ctx, "sh", solari.CommandOptions{
		Args:     []string{"-c", "for i in 1 2 3; do echo line $i; done"},
		OnStdout: func(s string) { fmt.Print(s) },
	})
	if err != nil {
		log.Fatal(err)
	}

	// Git: clone, inspect status, commit. Runs as safe, non-shell `git`
	// invocations over the command RPC (no injection surface).
	if err := sb.Git.Clone(ctx, "https://github.com/acme/repo.git", solari.GitCloneOptions{
		Path:  "repo",
		Depth: 1,
	}); err != nil {
		log.Fatal(err)
	}

	st, err := sb.Git.Status(ctx, "repo")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("branch=%s clean=%v staged=%v\n", st.Branch, st.Clean, st.Staged)

	sb.Git.Add(ctx, []string{"."}, "repo")
	hash, err := sb.Git.Commit(ctx, "automated change", solari.GitCommitOptions{
		Cwd:    "repo",
		Author: "Solari Bot",
		Email:  "bot@example.com",
		All:    true,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("committed", hash)
}
```

## Typed error handling

```go
_, err := client.Create(ctx, solari.CreateOptions{Template: "base"})
var cap *solari.ConcurrencyLimitError
var auth *solari.AuthError
switch {
case errors.As(err, &cap):
	// org at its live-session cap (HTTP 429) — not retryable
case errors.As(err, &auth):
	// bad/missing API key (HTTP 401/403)
}
```

## Reconnecting to a running sandbox

```go
sb, err := client.Connect(ctx, "sbx_…") // GET /sandboxes/:id, derives controlUrl
```

## Namespaces

| Namespace   | Methods |
|-------------|---------|
| `Commands`  | `Run`, `Start` (→ `CommandHandle` with `Stdin`/`OnData`/`Wait`/`Kill`) |
| `Files`     | `Read`, `ReadText`, `Write`, `List`, `Stat`, `Mkdir`, `Remove`, `Rename` |
| `Code`      | `Run` (chart flattening), `CreateContext` |
| `Git`       | `Clone`, `Status`, `Add`, `Commit`, `Push`, `Pull`, `Checkout`, `Branches`, `Log` |

## Build & test

Offline — no live gateway required (transports are mocked in tests):

```
go build ./...
go test ./...
```
