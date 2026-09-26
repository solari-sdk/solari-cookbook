// Adapted from pingdotgg/t3code apps/web/src/keybindings.ts at 57a66608 (MIT).
// Kept: the event matcher, when-clause evaluation, the effective-shortcut
// lookup and the platform labels. Left out: the thread-jump and model-picker
// hint helpers and the raw terminal key sequences, which belong to features
// this shell does not have. Contract types come from keybindingTypes.ts.
import { DEFAULT_RESOLVED_KEYBINDINGS } from "./keybindingDefaults.js";
import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "./keybindingTypes.js";
import { isDesktopShell } from "./lib/desktopShell.js";
import { isMacPlatform } from "./lib/utils.js";

export interface ShortcutEventLike {
  type?: string;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  previewFocus: boolean;
  previewOpen: boolean;
  /**
   * Derived, never passed: a focused terminal owns mod chords where mod is
   * Control, which the shell reads. On macOS mod is Command, which no shell
   * reads, so a Command chord the app binds fires whatever has focus.
   */
  terminalOwnsMod: boolean;
  /** The desktop shell holds the page, so the chords a browser keeps for its own tabs reach it. */
  desktopShell: boolean;
  [key: string]: boolean;
}

export interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

const EVENT_CODE_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  BracketLeft: ["["],
  BracketRight: ["]"],
  Digit0: ["0"],
  Digit1: ["1"],
  Digit2: ["2"],
  Digit3: ["3"],
  Digit4: ["4"],
  Digit5: ["5"],
  Digit6: ["6"],
  Digit7: ["7"],
  Digit8: ["8"],
  Digit9: ["9"],
  // The plus of a zoom chord is the shifted equals on most layouts, and the rule names the unshifted key.
  Equal: ["=", "+"],
};

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  // The physical-position fallback exists for layouts that type non-Latin
  // letters (Cyrillic, Greek) and for Option-modified symbols on macOS.
  // When the layout already produces a Latin letter, match on it alone;
  // otherwise a remapped physical key triggers shortcuts for two different
  // letters at once and shadows system shortcuts on non-QWERTY layouts.
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  const aliases = event.code ? EVENT_CODE_KEY_ALIASES[event.code] : undefined;
  if (!aliases) return keys;

  for (const alias of aliases) {
    keys.add(alias);
  }
  return keys;
}

/** What mod comes to on this platform: Command on macOS, Control elsewhere. */
function effectiveModifiers(
  shortcut: KeybindingShortcut,
  platform: string,
): { metaKey: boolean; ctrlKey: boolean } {
  const useMetaForMod = isMacPlatform(platform);
  return {
    metaKey: shortcut.metaKey || (shortcut.modKey && useMetaForMod),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod),
  };
}

/** Whether the chord holds the platform's mod, Command on macOS and Control elsewhere, and not the other of the two. */
function holdsModAlone(shortcut: KeybindingShortcut, platform: string): boolean {
  const { metaKey, ctrlKey } = effectiveModifiers(shortcut, platform);
  return isMacPlatform(platform) ? metaKey && !ctrlKey : ctrlKey && !metaKey;
}

/** The keys a browser takes with the platform's mod alone: a digit picks one of its tabs, t opens a new one. Not the
 * same fact as how many sidebar slots this shell binds: WORKSPACE_SELECT_SLOTS moves on its own. */
const BROWSER_TAB_KEYS: ReadonlySet<string> = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "t"]);

/** The side arrows a macOS browser keeps for its own tabs, held with Command and Option. */
const BROWSER_TAB_ARROWS: ReadonlySet<string> = new Set(["arrowleft", "arrowright"]);

/**
 * The chords a browser keeps for its own tabs: Control with Tab, the
 * platform's mod with a digit or with T, and on macOS Command and Option with a
 * side arrow. A page in a tab never receives them, so the rules must not fire on
 * them and no label may offer them there. The desktop shell has no tab strip
 * and the page gets them. Two chords that look like these are not: Control
 * with a digit, which macOS browsers leave to the page, and Control with Alt
 * and an arrow, which is what the mod arrows come to off macOS and reaches the
 * page there.
 */
export function browserTabClaimsShortcut(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const { metaKey, ctrlKey } = effectiveModifiers(shortcut, platform);
  if (shortcut.altKey) {
    return isMacPlatform(platform) && BROWSER_TAB_ARROWS.has(shortcut.key) && holdsModAlone(shortcut, platform) && !shortcut.shiftKey;
  }
  if (shortcut.key === "tab") return ctrlKey && !metaKey;
  return BROWSER_TAB_KEYS.has(shortcut.key) && holdsModAlone(shortcut, platform) && !shortcut.shiftKey;
}

/** Whether a rule's chord can reach this shell at all, whatever its when clause says. */
function shortcutReachesShell(
  shortcut: KeybindingShortcut,
  platform: string,
  context: ShortcutMatchContext,
): boolean {
  return context.desktopShell || !browserTabClaimsShortcut(shortcut, platform);
}

function matchesShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const { metaKey: expectedMeta, ctrlKey: expectedCtrl } = effectiveModifiers(shortcut, platform);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(
  options: ShortcutMatchOptions | undefined,
  platform: string,
): ShortcutMatchContext {
  const terminalFocus = options?.context?.terminalFocus ?? false;
  return {
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    desktopShell: isDesktopShell(),
    ...options?.context,
    terminalFocus,
    terminalOwnsMod: terminalFocus && !isMacPlatform(platform),
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

function shortcutConflictKey(shortcut: KeybindingShortcut, platform = navigator.platform): string {
  const { metaKey, ctrlKey } = effectiveModifiers(shortcut, platform);
  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function findEffectiveShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options, platform);
  const claimedShortcuts = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!shortcutReachesShell(binding.shortcut, platform, context)) continue;

    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      return binding.shortcut;
    }
  }

  return null;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options, platform);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!shortcutReachesShell(binding.shortcut, platform, context)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

/**
 * A Command chord the rules bind while a terminal has focus. The surface lets
 * it bubble to the dispatcher instead of encoding it. Control and Option
 * chords are the terminal's on every platform, so a Control-based mod never
 * claims one.
 */
export function isTerminalAppShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS,
  platform = navigator.platform,
): boolean {
  if (!event.metaKey) return false;
  return resolveShortcutCommand(event, keybindings, { platform, context: { terminalFocus: true } }) !== null;
}

function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const { metaKey: showMeta, ctrlKey: showCtrl } = effectiveModifiers(shortcut, platform);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "⌃" : ""}${showAlt ? "⌥" : ""}${showShift ? "⇧" : ""}${showMeta ? "⌘" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

/**
 * The modifier keys an event is holding down, as KeyboardEvent.key spells them. A chord that puts a hold-to-walk
 * overlay up reads its hold here, off the event that opened it, so a command bound to two chords ends on whichever
 * one was pressed. Shift is left out: the two directions of such a chord differ by Shift alone, so a step back
 * would otherwise commit the walk it is still stepping through.
 */
export function eventHoldKeys(event: ShortcutModifierStateLike): string[] {
  const names: string[] = [];
  if (event.ctrlKey) names.push("Control");
  if (event.altKey) names.push("Alt");
  if (event.metaKey) names.push("Meta");
  return names;
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, resolvedOptions);
  return shortcut ? formatShortcutLabel(shortcut, platform) : null;
}

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = { " ": "Space", escape: "Escape", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right" };

/** The same chord in Electron's spelling, for a native menu row; mod reads CommandOrControl on every platform. */
export function formatAccelerator(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("CommandOrControl");
  if (shortcut.ctrlKey) parts.push("Control");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  if (shortcut.metaKey) parts.push("Meta");
  parts.push(ACCELERATOR_KEYS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key));
  return parts.join("+");
}

export function acceleratorForCommand(keybindings: ResolvedKeybindingsConfig, command: KeybindingCommand, options?: ShortcutMatchOptions): string | null {
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, options);
  return shortcut ? formatAccelerator(shortcut) : null;
}
