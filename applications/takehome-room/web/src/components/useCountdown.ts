import { useEffect, useState } from 'react'

/**
 * Seconds left, ticking locally between server answers. The server owns the
 * clock: each fetch resets the starting point, so the display never drifts far.
 */
export function useCountdown(secondsLeft: number | undefined, fetchedAt: number): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (secondsLeft === undefined) return undefined
  return Math.max(0, Math.round(secondsLeft - (now - fetchedAt) / 1000))
}

export const formatClock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
