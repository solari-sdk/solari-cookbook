/**
 * The time rail: Setup time (hatched, not counted) followed by work time.
 * Segment widths follow the real minutes, so a 10 min setup beside a 60 min
 * task looks exactly that much smaller. `filled` marks how much of each is used.
 */
export function Rail({
  setupMinutes,
  workMinutes,
  setupUsed = 0,
  workUsed = 0,
  compact = false,
}: {
  setupMinutes: number
  workMinutes: number
  /** 0..1 of Setup time used. */
  setupUsed?: number
  /** 0..1 of work time used. */
  workUsed?: number
  compact?: boolean
}) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const height = compact ? 'h-2' : 'h-3'
  return (
    <div className="w-full" role="img" aria-label={`${setupMinutes} minutes of setup, not counted, then ${workMinutes} minutes of work`}>
      <div className="flex gap-1">
        {setupMinutes > 0 && (
          <div className={`hatched relative ${height} overflow-hidden rounded-full`} style={{ flexGrow: setupMinutes }}>
            <div className="absolute inset-y-0 left-0 bg-graphite/60" style={{ width: `${clamp(setupUsed) * 100}%` }} />
          </div>
        )}
        <div className={`relative ${height} overflow-hidden rounded-full border border-ink/40`} style={{ flexGrow: workMinutes }}>
          <div className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-1000 ease-linear" style={{ width: `${clamp(workUsed) * 100}%` }} />
        </div>
      </div>
      {!compact && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-graphite">
          {setupMinutes > 0 && (
            <span className="inline-flex items-center gap-2">
              <span className="hatched inline-block h-2 w-5 rounded-full" aria-hidden />
              {setupMinutes} min setup, not counted
            </span>
          )}
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-2 w-5 rounded-full border border-ink/40" aria-hidden />
            {workMinutes} min work
          </span>
        </div>
      )}
    </div>
  )
}
