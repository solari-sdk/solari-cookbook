// SPDX-License-Identifier: AGPL-3.0-only
// jsdom lays nothing out, so a virtualized list measures a 0px viewport and
// renders no rows. This gives every element a size (a 600px viewport for the
// list's scroll node, 90px for everything else) and a ResizeObserver that
// reports it, which is enough for the list to window rows the way a browser
// would. Opt in per test file; the terminal surface's own measuring must not see it.
const VIEWPORT_CLASS = "overscroll-y-contain";
const VIEWPORT_PX = 600;
const ROW_PX = 90;

const sizeOf = (el: Element) => (el.classList.contains(VIEWPORT_CLASS) ? VIEWPORT_PX : ROW_PX);
const rectOf = (el: Element): DOMRect => {
  const height = sizeOf(el);
  return { width: 800, height, top: 0, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
};

class FakeResizeObserver {
  readonly #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
  observe(el: Element): void {
    queueMicrotask(() =>
      this.#cb([{ target: el, contentRect: rectOf(el) } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

export function installFakeLayout(): () => void {
  const proto = HTMLElement.prototype;
  const saved = {
    rect: proto.getBoundingClientRect,
    ro: globalThis.ResizeObserver,
    props: ["clientHeight", "clientWidth", "offsetHeight", "offsetWidth"].map(name => [name, Object.getOwnPropertyDescriptor(proto, name)] as const),
  };
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return sizeOf(this as Element); } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return sizeOf(this as Element); } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 800; } });
  proto.getBoundingClientRect = function () { return rectOf(this); };
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    proto.getBoundingClientRect = saved.rect;
    globalThis.ResizeObserver = saved.ro;
    for (const [name, desc] of saved.props) {
      if (desc) Object.defineProperty(proto, name, desc);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  };
}
