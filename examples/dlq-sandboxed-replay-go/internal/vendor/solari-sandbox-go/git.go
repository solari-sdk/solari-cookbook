package solari

// git namespace: safe, non-shell `git` invocations over the command RPC, plus
// the client-side parsers (status/branches/log) and arg construction
// (clone/commit/push auth). Ported to match the reference TypeScript git
// namespace byte-for-byte on the wire (args) and in its parsed outputs.

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// commandRunner runs `cmd` with the given options and returns its result. The
// Sandbox wires this to Commands.Run; tests inject a stub (exactly like the TS
// git suite stubs runCommand) so no guest is needed.
type commandRunner func(ctx context.Context, cmd string, opts CommandOptions) (*CommandResult, error)

// Git is the version-control namespace on a Sandbox. Every method is a safe,
// non-shell `git` invocation over the command RPC with client-side parsing.
type Git struct {
	run commandRunner
}

func newGit(run commandRunner) *Git { return &Git{run: run} }

var (
	reNoCommits = regexp.MustCompile(`^No commits yet on (.+)$`)
	reBracket   = regexp.MustCompile(`\[(.*)\]`)
	reAhead     = regexp.MustCompile(`ahead (\d+)`)
	reBehind    = regexp.MustCompile(`behind (\d+)`)
)

// runGit runs `git <args>` in the guest via the command RPC (no shell).
func (g *Git) runGit(ctx context.Context, args []string, cwd string) (*CommandResult, error) {
	opts := CommandOptions{Args: args}
	if cwd != "" {
		opts.Cwd = cwd
	}
	return g.run(ctx, "git", opts)
}

// mustGit runs `git <args>` and returns stdout, or an error carrying the
// subcommand, exit code, and trimmed stderr (fallback stdout) on a non-zero exit.
func (g *Git) mustGit(ctx context.Context, args []string, cwd string) (string, error) {
	r, err := g.runGit(ctx, args, cwd)
	if err != nil {
		return "", err
	}
	if r.ExitCode != 0 {
		detail := strings.TrimSpace(r.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(r.Stdout)
		}
		sub := ""
		if len(args) > 0 {
			sub = args[0]
		}
		return "", fmt.Errorf("git %s failed (exit %d): %s", sub, r.ExitCode, detail)
	}
	return r.Stdout, nil
}

// authURL splices basic-auth creds into an https remote URL. On any parse
// failure (or a non-http(s) scheme like ssh/scp) it returns the URL unchanged.
// Verify: p@ss word → p%40ss%20word.
func authURL(rawURL, username, password string) string {
	if username == "" && password == "" {
		return rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return rawURL
	}
	switch {
	case username != "" && password != "":
		u.User = url.UserPassword(username, password)
	case username != "":
		u.User = url.User(username)
	default:
		u.User = url.UserPassword("", password)
	}
	return u.String()
}

// Clone clones url into opts.Path (or git's default dir) under opts.Cwd.
func (g *Git) Clone(ctx context.Context, rawURL string, opts GitCloneOptions) error {
	args := []string{"clone"}
	if opts.Depth > 0 {
		args = append(args, "--depth", strconv.Itoa(opts.Depth))
	}
	if opts.Branch != "" {
		args = append(args, "--branch", opts.Branch)
	}
	args = append(args, authURL(rawURL, opts.Username, opts.Password))
	if opts.Path != "" {
		args = append(args, opts.Path)
	}
	_, err := g.mustGit(ctx, args, opts.Cwd)
	return err
}

// Status returns the parsed working-tree status.
func (g *Git) Status(ctx context.Context, cwd string) (*GitStatus, error) {
	out, err := g.mustGit(ctx, []string{"status", "--porcelain=v1", "--branch"}, cwd)
	if err != nil {
		return nil, err
	}
	st := &GitStatus{
		Staged:    []string{},
		Modified:  []string{},
		Untracked: []string{},
		Clean:     true,
	}
	for _, line := range strings.Split(out, "\n") {
		if len(line) == 0 {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			head := line[3:]
			if strings.HasPrefix(head, "HEAD (no branch)") {
				st.Detached = true
			} else {
				// "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main"
				body := head
				if m := reNoCommits.FindStringSubmatch(head); m != nil {
					body = m[1]
				}
				beforeDots := strings.SplitN(body, "...", 2)[0]
				st.Branch = strings.SplitN(beforeDots, " ", 2)[0]
				if ab := reBracket.FindStringSubmatch(head); ab != nil {
					inner := ab[1]
					if a := reAhead.FindStringSubmatch(inner); a != nil {
						st.Ahead, _ = strconv.Atoi(a[1])
					}
					if b := reBehind.FindStringSubmatch(inner); b != nil {
						st.Behind, _ = strconv.Atoi(b[1])
					}
				}
			}
			continue
		}
		if len(line) < 3 {
			continue
		}
		xy := line[0:2]
		path := line[3:]
		if xy == "??" {
			st.Untracked = append(st.Untracked, path)
		} else if len(xy) == 2 {
			index := xy[0]
			work := xy[1]
			if index != ' ' && index != '?' {
				st.Staged = append(st.Staged, path)
			}
			if work != ' ' && work != '?' {
				st.Modified = append(st.Modified, path)
			}
		}
	}
	st.Clean = len(st.Staged) == 0 && len(st.Modified) == 0 && len(st.Untracked) == 0
	return st, nil
}

// Add stages paths (use ["."] for everything). A no-op on empty paths; the `--`
// separator guards paths that look like flags.
func (g *Git) Add(ctx context.Context, paths []string, cwd string) error {
	if len(paths) == 0 {
		return nil
	}
	args := append([]string{"add", "--"}, paths...)
	_, err := g.mustGit(ctx, args, cwd)
	return err
}

// Commit commits staged changes and returns the new commit hash. author/email
// scope identity to this one commit without mutating repo/global config.
func (g *Git) Commit(ctx context.Context, message string, opts GitCommitOptions) (string, error) {
	var args []string
	if opts.Author != "" {
		args = append(args, "-c", "user.name="+opts.Author)
	}
	if opts.Email != "" {
		args = append(args, "-c", "user.email="+opts.Email)
	}
	args = append(args, "commit", "-m", message)
	if opts.All {
		args = append(args, "-a")
	}
	if _, err := g.mustGit(ctx, args, opts.Cwd); err != nil {
		return "", err
	}
	out, err := g.mustGit(ctx, []string{"rev-parse", "HEAD"}, opts.Cwd)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// Push pushes to a remote (default origin + current branch).
func (g *Git) Push(ctx context.Context, opts GitRemoteOptions) error {
	return g.pushPull(ctx, "push", opts)
}

// Pull pulls from a remote (default origin + current branch).
func (g *Git) Pull(ctx context.Context, opts GitRemoteOptions) error {
	return g.pushPull(ctx, "pull", opts)
}

func (g *Git) pushPull(ctx context.Context, op string, opts GitRemoteOptions) error {
	remote := opts.Remote
	if remote == "" {
		remote = "origin"
	}
	// One-off HTTPS auth without persisting a credential: rewrite the remote's
	// URL for just this invocation via `-c url.<authed>.insteadOf=<plain>`.
	var cfg []string
	if opts.Username != "" || opts.Password != "" {
		r, err := g.runGit(ctx, []string{"remote", "get-url", remote}, opts.Cwd)
		if err != nil {
			return err
		}
		plain := strings.TrimSpace(r.Stdout)
		if plain != "" {
			authed := authURL(plain, opts.Username, opts.Password)
			if authed != plain {
				cfg = append(cfg, "-c", "url."+authed+".insteadOf="+plain)
			}
		}
	}
	args := append(append([]string{}, cfg...), op, remote)
	if opts.Branch != "" {
		args = append(args, opts.Branch)
	}
	_, err := g.mustGit(ctx, args, opts.Cwd)
	return err
}

// Checkout checks out an existing ref, or creates a branch with create=true.
func (g *Git) Checkout(ctx context.Context, ref string, cwd string, create bool) error {
	args := []string{"checkout"}
	if create {
		args = append(args, "-b")
	}
	args = append(args, ref)
	_, err := g.mustGit(ctx, args, cwd)
	return err
}

// Branches lists local branches (name, short commit, whether it's HEAD).
func (g *Git) Branches(ctx context.Context, cwd string) ([]GitBranch, error) {
	out, err := g.mustGit(ctx, []string{"branch", "--format=%(HEAD)%1f%(refname:short)%1f%(objectname:short)"}, cwd)
	if err != nil {
		return nil, err
	}
	branches := []GitBranch{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\x1f")
		head := field(fields, 0)
		branches = append(branches, GitBranch{
			Name:    field(fields, 1),
			Commit:  field(fields, 2),
			Current: head == "*",
		})
	}
	return branches, nil
}

// Log returns recent commits, newest first.
func (g *Git) Log(ctx context.Context, opts GitLogOptions) ([]GitCommit, error) {
	args := []string{"log", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s"}
	if opts.MaxCount > 0 {
		args = append(args, "--max-count="+strconv.Itoa(opts.MaxCount))
	}
	out, err := g.mustGit(ctx, args, opts.Cwd)
	if err != nil {
		return nil, err
	}
	commits := []GitCommit{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\x1f")
		commits = append(commits, GitCommit{
			Hash:    field(fields, 0),
			Author:  field(fields, 1),
			Email:   field(fields, 2),
			Date:    field(fields, 3),
			Message: field(fields, 4),
		})
	}
	return commits, nil
}

func field(fields []string, i int) string {
	if i < len(fields) {
		return fields[i]
	}
	return ""
}
