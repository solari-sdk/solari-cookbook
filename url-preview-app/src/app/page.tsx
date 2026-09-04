"use client"

import { useEffect, useRef, useState } from "react"

type Mode = "repo" | "site"

type LogEntry = {
  id: number
  timestamp: string
  level: "info" | "warn" | "error" | "debug"
  phase: string | null
  message: string
}

type SessionState = {
  status: string
  detectedFramework: string | null
  detectedPkgManager: string | null
  detectedPort: number | null
  installCmd: string | null
  buildCmd: string | null
  startCmd: string | null
  isStatic: boolean | null
  serverReady: boolean | null
  outOfScopeReason: string | null
  errorSummary: string | null
  expiresAt: string
  extendCount: number | null
}

type Report = {
  downloads: { filename: string; url: string; mimeType: string | null; sizeBytes: number | null; sha256: string | null }[]
  clipboardEvents: { text: string; seenAt: string }[]
  screenshotKinds: string[]
}

type User = { email: string; dailyMinutesUsed: number; dailyMinutesLimit: number }

// Mirrors src/lib/session-manager.ts detectMode — a client-side hint only.
// The server re-checks and is the source of truth.
function guessMode(url: string): Mode | null {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const path = u.pathname.toLowerCase()
    if (
      host === "github.com" ||
      host === "gitlab.com" ||
      host.endsWith(".github.com") ||
      host.endsWith(".gitlab.com") ||
      path.endsWith(".git") ||
      path.endsWith(".zip") ||
      path.endsWith(".tar.gz") ||
      path.endsWith(".tgz")
    ) {
      return "repo"
    }
    return "site"
  } catch {
    return null
  }
}

function formatCountdown(expiresAt: string | null): string {
  if (!expiresAt) return "--:--"
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return "0:00"
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export default function Page() {
  const [user, setUser] = useState<User | null | undefined>(undefined) // undefined = loading
  const [authMode, setAuthMode] = useState<"login" | "signup">("login")
  const [authEmail, setAuthEmail] = useState("")
  const [authPassword, setAuthPassword] = useState("")
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const [url, setUrl] = useState("")
  const [modeOverride, setModeOverride] = useState<Mode | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionMode, setSessionMode] = useState<Mode | null>(null)
  const [sessionState, setSessionState] = useState<SessionState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [report, setReport] = useState<Report | null>(null)

  const [confirmForm, setConfirmForm] = useState({ installCmd: "", buildCmd: "", startCmd: "", port: "" })
  const [confirmSent, setConfirmSent] = useState(false)

  const [, forceTick] = useState(0)

  const esRef = useRef<EventSource | null>(null)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logBodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
  }, [])

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (logBodyRef.current) logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight
  }, [logs])

  function resetSession() {
    esRef.current?.close()
    esRef.current = null
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    heartbeatRef.current = null
    setSessionId(null)
    setSessionMode(null)
    setSessionState(null)
    setLogs([])
    setReport(null)
    setConfirmSent(false)
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault()
    setAuthError(null)
    setAuthBusy(true)
    try {
      const res = await fetch(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Something went wrong")
      setUser({ email: data.email, dailyMinutesUsed: 0, dailyMinutesLimit: 120 })
      const me = await fetch("/api/auth/me").then((r) => r.json())
      setUser(me.user)
    } catch (err: any) {
      setAuthError(err.message)
    } finally {
      setAuthBusy(false)
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" })
    setUser(null)
    resetSession()
  }

  async function startSession(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    if (!url.trim()) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), mode: modeOverride }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Could not start a session")
      resetSession()
      setSessionId(data.sessionId)
      setSessionMode(data.mode)
      attachStream(data.sessionId, data.mode)
    } catch (err: any) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function attachStream(id: string, mode: Mode) {
    const es = new EventSource(`/api/logs/${id}`)
    esRef.current = es

    es.onmessage = (evt) => {
      const entry = JSON.parse(evt.data)
      setLogs((prev) => [...prev, entry])
    }

    es.addEventListener("session", (evt: MessageEvent) => {
      const s: SessionState = JSON.parse(evt.data)
      setSessionState(s)

      if (s.status === "awaiting_confirm") {
        setConfirmForm((prev) =>
          prev.installCmd || prev.buildCmd || prev.startCmd || prev.port
            ? prev
            : {
                installCmd: s.installCmd ?? "",
                buildCmd: s.buildCmd ?? "",
                startCmd: s.startCmd ?? "",
                port: s.detectedPort ? String(s.detectedPort) : "",
              },
        )
      }

      if (mode === "site" && s.status === "running" && !heartbeatRef.current) {
        heartbeatRef.current = setInterval(() => {
          fetch("/api/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: id }),
          }).catch(() => {})
        }, 15_000)
        // fire one immediately so we don't wait 15s for the first beat
        fetch("/api/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id }),
        }).catch(() => {})
      }

      if (["done", "failed", "killed"].includes(s.status)) {
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current)
          heartbeatRef.current = null
        }
        if (mode === "site" && s.status === "done") {
          fetch(`/api/session/${id}/report`)
            .then((r) => r.json())
            .then(setReport)
            .catch(() => {})
        }
        fetch("/api/auth/me")
          .then((r) => r.json())
          .then((d) => setUser(d.user))
          .catch(() => {})
      }
    })

    es.onerror = () => {
      // EventSource retries on its own; nothing to do.
    }
  }

  async function confirmRun(e: React.FormEvent) {
    e.preventDefault()
    if (!sessionId) return
    setConfirmSent(true)
    await fetch(`/api/session/${sessionId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installCmd: confirmForm.installCmd,
        buildCmd: confirmForm.buildCmd,
        startCmd: confirmForm.startCmd,
        port: confirmForm.port ? Number(confirmForm.port) : undefined,
      }),
    }).catch(() => setConfirmSent(false))
  }

  async function extend() {
    if (!sessionId) return
    await fetch("/api/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }

  async function kill() {
    if (!sessionId) return
    await fetch("/api/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }

  useEffect(() => {
    return () => {
      esRef.current?.close()
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [])

  if (user === undefined) {
    return (
      <div className="container">
        <p className="subtitle">Loading...</p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="container" style={{ maxWidth: 420 }}>
        <h1>URL Preview</h1>
        <p className="subtitle">Paste a URL, see what's behind it. Runs entirely on Solari, nothing touches your machine.</p>
        <form onSubmit={submitAuth} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <input
            className="url-input"
            type="email"
            placeholder="you@example.com"
            value={authEmail}
            onChange={(e) => setAuthEmail(e.target.value)}
            required
          />
          <input
            className="url-input"
            type="password"
            placeholder="password (min 8 characters)"
            value={authPassword}
            onChange={(e) => setAuthPassword(e.target.value)}
            minLength={8}
            required
          />
          {authError && (
            <div className="error-banner">
              <p>{authError}</p>
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={authBusy}>
            {authMode === "login" ? "Log in" : "Sign up"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setAuthMode(authMode === "login" ? "signup" : "login")
              setAuthError(null)
            }}
          >
            {authMode === "login" ? "Need an account? Sign up" : "Have an account? Log in"}
          </button>
        </form>
      </div>
    )
  }

  const guessedMode = guessMode(url)
  const effectiveMode = modeOverride ?? guessedMode

  const active = sessionState && !["done", "failed", "killed"].includes(sessionState.status)
  const terminal = sessionState && ["done", "failed", "killed"].includes(sessionState.status)

  return (
    <div className="container">
      <div className="actions-bar" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <div>
          <h1>URL Preview</h1>
          <p className="subtitle">Runs entirely on Solari infrastructure — nothing touches your machine.</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="info-row">
            <span className="info-label">{user.email}</span>
          </div>
          <div className="info-row">
            <span className="info-value">{user.dailyMinutesUsed}/{user.dailyMinutesLimit} min today</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={logout}>
            Log out
          </button>
        </div>
      </div>

      {!sessionId && (
        <form onSubmit={startSession}>
          <div className="url-form">
            <input
              className="url-input"
              type="url"
              placeholder="https://github.com/owner/repo or any page URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? "Starting..." : "Preview"}
            </button>
          </div>
          {effectiveMode && (
            <div className="mode-indicator">
              Detected:
              <span className={`mode-badge mode-${guessedMode}`}>{guessedMode}</span>
              {modeOverride && modeOverride !== guessedMode && <span>(overridden to {modeOverride})</span>}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setModeOverride(effectiveMode === "repo" ? "site" : "repo")}
              >
                Switch to {effectiveMode === "repo" ? "site" : "repo"} mode
              </button>
            </div>
          )}
          {submitError && (
            <div className="error-banner">
              <p>{submitError}</p>
            </div>
          )}
        </form>
      )}

      {sessionId && sessionState && (
        <div style={{ marginTop: "1rem" }}>
          <div className="actions-bar" style={{ marginBottom: "1rem", justifyContent: "space-between" }}>
            <div className="mode-indicator" style={{ marginBottom: 0 }}>
              <span className={`mode-badge mode-${sessionMode}`}>{sessionMode}</span>
              <span className={`status-badge status-${sessionState.status === "awaiting_confirm" || sessionState.status === "detecting" ? "pending" : sessionState.status}`}>
                {sessionState.status.replace("_", " ")}
              </span>
              {active && <span>Time left: {formatCountdown(sessionState.expiresAt)}</span>}
            </div>
            <div className="actions-bar">
              {sessionMode === "repo" && sessionState.status === "running" && sessionState.serverReady && (
                <button className="btn btn-secondary btn-sm" onClick={extend}>
                  Extend +15 min
                </button>
              )}
              {active && (
                <button className="btn btn-danger btn-sm" onClick={kill}>
                  Kill session
                </button>
              )}
              {terminal && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    resetSession()
                    setUrl("")
                  }}
                >
                  New preview
                </button>
              )}
            </div>
          </div>

          {sessionState.outOfScopeReason && (
            <div className="error-banner">
              <h4>Out of scope</h4>
              <p>{sessionState.outOfScopeReason}</p>
            </div>
          )}
          {!sessionState.outOfScopeReason && sessionState.status === "failed" && sessionState.errorSummary && (
            <div className="error-banner">
              <h4>Failed</h4>
              <p>{sessionState.errorSummary}</p>
            </div>
          )}

          {sessionMode === "repo" && sessionState.status === "awaiting_confirm" && (
            <form onSubmit={confirmRun} className="session-info" style={{ marginBottom: "1rem" }}>
              <h3>Detected — review before running</h3>
              <div className="info-row">
                <span className="info-label">Framework</span>
                <span className="info-value">{sessionState.detectedFramework}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Package manager</span>
                <span className="info-value">{sessionState.detectedPkgManager}</span>
              </div>
              <label>Install command</label>
              <input
                className="url-input"
                value={confirmForm.installCmd}
                onChange={(e) => setConfirmForm({ ...confirmForm, installCmd: e.target.value })}
                placeholder="(none — static site)"
              />
              <label>Build command</label>
              <input
                className="url-input"
                value={confirmForm.buildCmd}
                onChange={(e) => setConfirmForm({ ...confirmForm, buildCmd: e.target.value })}
                placeholder="(none)"
              />
              <label>Start command</label>
              <input
                className="url-input"
                value={confirmForm.startCmd}
                onChange={(e) => setConfirmForm({ ...confirmForm, startCmd: e.target.value })}
              />
              <label>Port</label>
              <input
                className="url-input"
                value={confirmForm.port}
                onChange={(e) => setConfirmForm({ ...confirmForm, port: e.target.value })}
              />
              <button className="btn btn-primary" type="submit" disabled={confirmSent} style={{ marginTop: "0.75rem" }}>
                Run
              </button>
            </form>
          )}

          <div className="preview-container">
            <div className="preview-frame">
              {sessionMode === "repo" && sessionState.status === "running" && sessionState.serverReady ? (
                <iframe src={`/api/preview/${sessionId}/`} title="preview" />
              ) : (
                <div className="log-panel" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
                  {sessionMode === "repo" ? "Preview appears once the server is live" : "Site mode reports behaviour, not a live preview"}
                </div>
              )}
            </div>
            <div className="preview-sidebar">
              <div className="log-panel" style={{ flex: 1 }}>
                <div className="log-header">
                  <h3>Log</h3>
                </div>
                <div className="log-body" ref={logBodyRef}>
                  {logs.map((l) => (
                    <div key={l.id} className="log-entry">
                      <span className="log-time">{new Date(l.timestamp).toLocaleTimeString()}</span>
                      <span className={`log-level log-level-${l.level}`}>{l.level}</span>
                      <span className="log-phase">{l.phase}</span>
                      <span className="log-message">{l.message}</span>
                    </div>
                  ))}
                </div>
              </div>

              {sessionMode === "site" && report && (
                <div className="session-info">
                  <h3>Behaviour report</h3>
                  <div className="info-row">
                    <span className="info-label">Downloads it started</span>
                    <span className="info-value">{report.downloads.length}</span>
                  </div>
                  {report.downloads.map((d, i) => (
                    <div key={i} className="info-row" style={{ flexDirection: "column", alignItems: "flex-start" }}>
                      <strong>{d.filename}</strong>
                      <span>{d.sizeBytes} bytes — {d.mimeType}</span>
                      <span style={{ wordBreak: "break-all" }}>from {d.url}</span>
                      <span style={{ wordBreak: "break-all" }}>sha256 {d.sha256}</span>
                    </div>
                  ))}
                  <div className="info-row">
                    <span className="info-label">Clipboard write attempts</span>
                    <span className="info-value">{report.clipboardEvents.length}</span>
                  </div>
                  {report.clipboardEvents.map((c, i) => (
                    <div key={i} className="info-row" style={{ flexDirection: "column", alignItems: "flex-start" }}>
                      <span>"{c.text}"</span>
                    </div>
                  ))}
                  {report.screenshotKinds.includes("load") && (
                    <>
                      <p style={{ marginTop: "0.5rem" }}>At load:</p>
                      <img src={`/api/screenshot/${sessionId}/load`} alt="screenshot at load" style={{ width: "100%", borderRadius: 8 }} />
                    </>
                  )}
                  {report.screenshotKinds.includes("settle") && (
                    <>
                      <p style={{ marginTop: "0.5rem" }}>After settle:</p>
                      <img src={`/api/screenshot/${sessionId}/settle`} alt="screenshot after settle" style={{ width: "100%", borderRadius: 8 }} />
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
