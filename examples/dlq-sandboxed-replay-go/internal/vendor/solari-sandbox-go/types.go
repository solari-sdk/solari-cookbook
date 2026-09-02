package solari

// Wire types for the Solari SDK core surface. These mirror the reference
// TypeScript shapes (sdk/packages/core/src/types.ts) on the wire; Go idiom is
// free above the wire.

// SandboxKind is the flavour of a session: headless "sandbox" or GUI "desktop".
type SandboxKind string

const (
	KindSandbox SandboxKind = "sandbox"
	KindDesktop SandboxKind = "desktop"
)

// SandboxLifecycle is the idle lifecycle policy (pause/kill on timeout).
type SandboxLifecycle struct {
	OnTimeout  string `json:"onTimeout"`
	AutoResume *bool  `json:"autoResume,omitempty"`
}

// VolumeAttachment is one attach-at-create instruction: a persistent volume
// (created via Client.Volumes) and the absolute path to mount it at inside the
// guest. The mount is performed host-side before the guest starts, and survives
// pause/resume and recreate.
type VolumeAttachment struct {
	// VolumeID is a `vol_…` id belonging to your org.
	VolumeID string `json:"volumeId"`
	// Path is the absolute in-guest mount point, e.g. "/data".
	Path string `json:"path"`
}

// CreateOptions are the caller-facing options for Client.Create. Only Template
// is commonly set; everything else is optional (nil/zero fields are omitted
// from the wire body).
type CreateOptions struct {
	Template     string
	Kind         SandboxKind
	CPU          int
	MemMb        int
	DiskGb       int
	Envs         map[string]string
	Metadata     map[string]string
	TimeoutMs    int
	FromSnapshot string
	Lifecycle    *SandboxLifecycle
	// Resolution is the initial display resolution, e.g. "1280x720". Desktops
	// only (KindDesktop) — a headless sandbox has no display.
	Resolution string
	// Record asks the gateway to record the session server-side; the create
	// response carries a presigned playback URL. Desktops only: `record` on a
	// headless sandbox is rejected (400 RecordingRequiresDesktop).
	//
	// A POINTER, not a bool: the reference SDKs distinguish "unset" (field
	// omitted) from an explicit false (field sent as `record:false`). A plain
	// bool + omitempty cannot express the latter, which would make this SDK the
	// only one unable to explicitly opt out.
	Record *bool
	// Volumes are persistent volumes to mount before the session starts.
	Volumes []VolumeAttachment
}

// createSandboxRequest is the JSON body for POST /sandboxes. Pointers/omitempty
// keep unset fields off the wire, matching the reference SDK which omits
// null/undefined fields.
type createSandboxRequest struct {
	Template     string             `json:"template,omitempty"`
	Kind         SandboxKind        `json:"kind,omitempty"`
	CPU          int                `json:"cpu,omitempty"`
	MemMb        int                `json:"memMb,omitempty"`
	DiskGb       int                `json:"diskGb,omitempty"`
	Envs         map[string]string  `json:"envs,omitempty"`
	Metadata     map[string]string  `json:"metadata,omitempty"`
	TimeoutMs    int                `json:"timeoutMs,omitempty"`
	FromSnapshot string             `json:"fromSnapshot,omitempty"`
	Lifecycle    *SandboxLifecycle  `json:"lifecycle,omitempty"`
	Resolution   string             `json:"resolution,omitempty"`
	Record       *bool              `json:"record,omitempty"`
	Volumes      []VolumeAttachment `json:"volumes,omitempty"`
}

// resumeResponse is the POST /sandboxes/{id}/resume reply. The gateway may or
// may not hand back a fresh controlUrl; Client.Resume derives one when it does
// not (the session lands on a new slot, so the old URL is stale).
type resumeResponse struct {
	State      string `json:"state"`
	ControlURL string `json:"controlUrl,omitempty"`
}

// CreateSandboxResponse is the 201 response from POST /sandboxes.
type CreateSandboxResponse struct {
	SandboxID  string      `json:"sandboxId"`
	Kind       SandboxKind `json:"kind"`
	ControlURL string      `json:"controlUrl"`
	ExpiresAt  string      `json:"expiresAt"`
	StreamURL  string      `json:"streamUrl,omitempty"`
}

// SandboxView is the GET /sandboxes/{id} response (used by Connect).
type SandboxView struct {
	SandboxID  string            `json:"sandboxId"`
	Kind       SandboxKind       `json:"kind"`
	State      string            `json:"state"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	ExpiresAt  string            `json:"expiresAt"`
	ControlURL string            `json:"controlUrl,omitempty"`
	CPU        int               `json:"cpu,omitempty"`
	MemMb      int               `json:"memMb,omitempty"`
}

// CommandOptions configure Commands.Run / Commands.Start.
type CommandOptions struct {
	// Args is the argv tail passed to the program (no shell). For shell syntax
	// use Run(ctx, "sh", CommandOptions{Args: []string{"-c", "…"}}).
	Args []string
	Cwd  string
	Env  map[string]string
	User string
	// TimeoutMs bounds the one-shot exec fast path (server-side).
	TimeoutMs int
	// Background returns immediately; caller drives output via OnStdout/OnStderr.
	Background bool
	OnStdout   func(string)
	OnStderr   func(string)
}

// CommandResult is the terminal result of Commands.Run.
type CommandResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

// execOneShotRequest is the body for the POST /sandboxes/{id}/exec fast path.
type execOneShotRequest struct {
	Cmd       string   `json:"cmd"`
	Args      []string `json:"args,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	TimeoutMs int      `json:"timeoutMs,omitempty"`
}

// FsEntry is one directory entry from Files.List. Fields match the guest wire
// exactly: the JSON key for a directory flag is "dir" (not "isDir").
type FsEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size"`
}

// FsStat is the Files.Stat result. Mirrors the guest wire: "dir" (not "isDir")
// and "modTimeMs" (unix-millis).
type FsStat struct {
	Name      string `json:"name"`
	Dir       bool   `json:"dir"`
	Size      int64  `json:"size"`
	Mode      int    `json:"mode"`
	ModTimeMs int64  `json:"modTimeMs"`
}

// ChartType is the kind of a structured matplotlib figure.
type ChartType string

const (
	ChartLine          ChartType = "line"
	ChartScatter       ChartType = "scatter"
	ChartBar           ChartType = "bar"
	ChartPie           ChartType = "pie"
	ChartBoxAndWhisker ChartType = "box_and_whisker"
	ChartComposite     ChartType = "composite"
	ChartUnknown       ChartType = "unknown"
)

// ChartAxis is one axis of a 2D chart.
type ChartAxis struct {
	Label string        `json:"label,omitempty"`
	Ticks []interface{} `json:"ticks,omitempty"`
	Scale string        `json:"scale,omitempty"`
}

// Chart is the structured representation of a matplotlib figure. Elements is
// kept loose (raw decoded JSON) so new chart types don't require an SDK bump.
type Chart struct {
	Type     ChartType     `json:"type"`
	Title    string        `json:"title,omitempty"`
	XLabel   string        `json:"xLabel,omitempty"`
	YLabel   string        `json:"yLabel,omitempty"`
	X        *ChartAxis    `json:"x,omitempty"`
	Y        *ChartAxis    `json:"y,omitempty"`
	Elements []interface{} `json:"elements,omitempty"`
}

// CodeResultItem is one rich result object from Code.Run.
type CodeResultItem struct {
	Type     string      `json:"type"`
	Text     string      `json:"text,omitempty"`
	PNG      string      `json:"png,omitempty"`
	JPEG     string      `json:"jpeg,omitempty"`
	SVG      string      `json:"svg,omitempty"`
	HTML     string      `json:"html,omitempty"`
	LaTeX    string      `json:"latex,omitempty"`
	JSON     interface{} `json:"json,omitempty"`
	Markdown string      `json:"markdown,omitempty"`
	Chart    *Chart      `json:"chart,omitempty"`
}

// CodeError is the structured error form of RunCodeResult.Error.
type CodeError struct {
	Name      string `json:"name,omitempty"`
	Message   string `json:"message,omitempty"`
	Traceback string `json:"traceback,omitempty"`
}

// RunCodeResult is the result of Code.Run. Charts is a client-side convenience:
// every results[i].Chart that is present, flattened into a top-level slice.
type RunCodeResult struct {
	Results []CodeResultItem `json:"results"`
	// Error is either a *CodeError (object form) or a string; kept as the raw
	// decoded value so both wire shapes round-trip.
	Error  interface{} `json:"error,omitempty"`
	Charts []Chart     `json:"charts"`
}

// RunCodeOptions configure Code.Run.
type RunCodeOptions struct {
	Language  string
	ContextID string
	OnStdout  func(string)
	OnStderr  func(string)
}

// GitStatus is the parsed working-tree status (git.status).
type GitStatus struct {
	Branch    string   `json:"branch"`
	Detached  bool     `json:"detached"`
	Ahead     int      `json:"ahead"`
	Behind    int      `json:"behind"`
	Staged    []string `json:"staged"`
	Modified  []string `json:"modified"`
	Untracked []string `json:"untracked"`
	Clean     bool     `json:"clean"`
}

// GitBranch is one branch entry (git.branches).
type GitBranch struct {
	Name    string `json:"name"`
	Commit  string `json:"commit"`
	Current bool   `json:"current"`
}

// GitCommit is one commit record (git.log).
type GitCommit struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	Email   string `json:"email"`
	Date    string `json:"date"`
	Message string `json:"message"`
}

// GitCloneOptions configure Git.Clone.
type GitCloneOptions struct {
	Path     string
	Branch   string
	Depth    int
	Username string
	Password string
	Cwd      string
}

// GitCommitOptions configure Git.Commit.
type GitCommitOptions struct {
	Cwd    string
	Author string
	Email  string
	All    bool
}

// GitRemoteOptions configure Git.Push / Git.Pull.
type GitRemoteOptions struct {
	Cwd      string
	Remote   string
	Branch   string
	Username string
	Password string
}

// GitLogOptions configure Git.Log.
type GitLogOptions struct {
	Cwd      string
	MaxCount int
}
