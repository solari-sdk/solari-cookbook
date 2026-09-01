# Optional desktop packaging evaluation

The static/PWA console is the primary local single-user experience. It already provides installable/offline-capable browser behavior without creating a second application stack.

## Tauri

Tauri is the preferred future wrapper if a demonstrated requirement needs OS-native credential storage, tighter filesystem integration, or a signed desktop package while preserving the existing HTML/CSS/ES-module frontend. A wrapper should remain thin: the portable case format and browser-compatible frontend stay canonical, while native commands are limited to capabilities unavailable or unsafe in browser JavaScript.

**Decision:** evaluated and deferred. Do not add Tauri until an actual requirement needs OS keychain/filesystem integration. If that requirement appears, use the same static frontend rather than fork the UI.

## Electron

Electron can provide the same broad desktop integration but ships a separate Chromium/Node runtime and creates a larger update/security surface. The existing browser/PWA mode covers the current demonstration, and Tauri is a smaller first candidate for future native bridging.

**Decision:** evaluated and not justified for the current project. Reconsider only if Tauri and browser APIs cannot satisfy a concrete required capability. Do not maintain both wrappers in parallel without a documented reason.
