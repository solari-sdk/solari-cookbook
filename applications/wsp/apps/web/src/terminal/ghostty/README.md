<!-- Adapted from pingdotgg/t3code apps/web/src/terminal/ghostty/README.md at 57a66608 (MIT). -->
# Ghostty web terminal

This directory is the browser adapter for the official `libghostty-vt` C ABI.
It is intentionally not an xterm compatibility layer.

- `runtime.ts` owns the singleton WebAssembly instance and runtime ABI layouts.
- `ghostty-write-pty.wasm` is a 112-byte callback trampoline for terminal-generated PTY replies.
- `core.ts` owns per-terminal Ghostty handles and translates the C ABI into render snapshots.
- `renderer.ts` batches backgrounds and style runs into a Canvas 2D frame.
- `surface.ts` owns browser input, IME, selection, scrolling, sizing, links, and cursor blinking;
  its options take the padding, cursor defaults and background opacity that `../ghosttyConfig.ts`
  maps from the person's own Ghostty config, which the host reads and serves.
- `fontChain.ts` builds the canvas font list: the chosen family, the installed faces
  `localFonts.ts` registered for it (the desktop shell reads them from the computer's font
  directories), then the bundled symbols face. No Nerd Font is named that nobody chose.
- `fonts/` vendors the symbols-only Nerd Font (MIT) the surface registers lazily as the last
  fallback, so prompt glyphs render without a locally installed Nerd Font.
- `vendor/` holds only the two wasm artifacts, taken as-is from pingdotgg/t3code at 57a66608,
  whose `native/libghostty-vt/VERSION` pins ghostty at
  `9f62873bf195e4d8a762d768a1405a5f2f7b1697`. This repo has no build script for them; a newer
  ghostty means taking t3code's rebuilt pair and updating THIRD_PARTY_NOTICES.

Keep browser behavior here and terminal transport in `terminal/link.ts` and `terminal/pty-io.ts`.
Do not add React state to the render loop. Both WASM artifacts are ordinary read-only assets, not
executables.
