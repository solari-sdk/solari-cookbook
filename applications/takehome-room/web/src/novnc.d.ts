// noVNC ships no TypeScript types. This covers only what RoomScreen uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: Element, url: string, options?: Record<string, unknown>)
    scaleViewport: boolean
    background: string
    focus(): void
    disconnect(): void
  }
}
