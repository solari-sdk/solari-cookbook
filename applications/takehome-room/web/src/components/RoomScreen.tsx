import RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'

/**
 * The live desktop. This uses noVNC directly: the SDK's mountDesktop() does the
 * same few lines, but it loads "@novnc/novnc/lib/rfb.js" through a dynamic import
 * that bundlers cannot follow, and noVNC 1.7 no longer exports that path.
 */
export function RoomScreen({ streamUrl }: { streamUrl: string }) {
  const screen = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const target = screen.current
    if (!target) return
    let rfb: RFB | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const connect = () => {
      rfb = new RFB(target, streamUrl)
      rfb.scaleViewport = true
      rfb.background = '#0d1524'
      rfb.addEventListener('connect', () => {
        setConnected(true)
        rfb?.focus()
      })
      // Networks drop. Keep trying until this component goes away (the
      // Interview ended or the page changed).
      rfb.addEventListener('disconnect', () => {
        setConnected(false)
        if (!stopped) retry = setTimeout(connect, 2000)
      })
    }
    connect()

    return () => {
      stopped = true
      clearTimeout(retry)
      rfb?.disconnect()
    }
  }, [streamUrl])

  return (
    <div className="relative min-h-0 flex-1 bg-[#0d1524]">
      <div ref={screen} className="absolute inset-0" />
      {!connected && (
        <div className="absolute inset-0 grid place-items-center text-sm text-white/80" role="status">
          Connecting to your desktop…
        </div>
      )}
    </div>
  )
}
