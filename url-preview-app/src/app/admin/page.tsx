"use client"

import { useState } from "react"

type AdminStats = {
  totalSessions: number
  activeSessions: number
  failedSessions: number
  totalCostCents: number
  usersOverQuota: number
  recentJobs: { id: string; mode: string; status: string; inputUrl: string; costCents: number; createdAt: string }[]
}

export default function AdminPage() {
  const [secret, setSecret] = useState("")
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const res = await fetch("/api/admin", { headers: { "x-admin-secret": secret } })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? "Failed to load")
      setStats(null)
      return
    }
    setStats(data)
  }

  return (
    <div className="container">
      <h1>Admin</h1>
      <p className="subtitle">Cumulative spend and recent jobs. Cost figures are estimates — see src/lib/cost.ts.</p>

      <form onSubmit={load} className="url-form">
        <input
          className="url-input"
          type="password"
          placeholder="admin secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <button className="btn btn-primary" type="submit">
          Load
        </button>
      </form>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
        </div>
      )}

      {stats && (
        <div className="session-info" style={{ marginTop: "1rem" }}>
          <div className="info-row">
            <span className="info-label">Total sessions</span>
            <span className="info-value">{stats.totalSessions}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Active now</span>
            <span className="info-value">{stats.activeSessions}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Failed</span>
            <span className="info-value">{stats.failedSessions}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Users over daily quota</span>
            <span className="info-value">{stats.usersOverQuota}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Cumulative spend (estimate)</span>
            <span className="info-value">${(stats.totalCostCents / 100).toFixed(2)}</span>
          </div>

          <h3 style={{ marginTop: "1rem" }}>Recent jobs</h3>
          {stats.recentJobs.map((j) => (
            <div key={j.id} className="info-row">
              <span className="info-label">
                [{j.mode}] {j.status} — {j.inputUrl}
              </span>
              <span className="info-value">${(j.costCents / 100).toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
