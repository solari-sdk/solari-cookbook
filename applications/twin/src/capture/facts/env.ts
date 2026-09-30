import type { EnvFact } from '../../capsule/schema.ts';
import type { Redactor } from '../../redact/redactor.ts';
import { hmacSha256Hex } from '../../util/hash.ts';

/**
 * Variables whose values are safe to share and commonly change program behavior. They are also
 * recorded as "absent" when unset, because unset-vs-set is itself a difference worth bisecting.
 */
export const SAFE_VALUE_VARS: readonly string[] = [
  'CI',
  'NODE_ENV',
  'NODE_OPTIONS',
  'TZ',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'PYTHONHASHSEED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONIOENCODING',
  'PYTHONUTF8',
  'GOFLAGS',
  'CGO_ENABLED',
  'RUST_BACKTRACE',
];

/** Other locale categories (LC_PAPER, LC_MONETARY, ...) are just as safe to share. */
export function isSafeValue(name: string): boolean {
  return SAFE_VALUE_VARS.includes(name) || name.startsWith('LC_');
}

/**
 * Session and launcher noise that differs on every machine without affecting programs. Dropping
 * it keeps capsule diffs focused. `npm_*`, INIT_CWD and NODE are injected by `npx` itself.
 */
const NOISE = [
  /^(?:SSH_|XDG_|DBUS_|GPG_|GNOME_|KDE_|QT_|GTK_|WAYLAND_|HYPRLAND_|ITERM_|VSCODE_|KITTY_|WEZTERM_|ALACRITTY_|GHOSTTY_|WT_|TMUX|ZELLIJ|STARSHIP_|ATUIN_|MCFLY_|__CF|npm_)/,
  /^(?:_|PWD|OLDPWD|SHLVL|HOME|USER|LOGNAME|HOSTNAME|MAIL|DISPLAY|WINDOWID|COLORTERM|LS_COLORS|LSCOLORS|STY|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|SESSION_MANAGER|DESKTOP_SESSION|SECURITYSESSIONID|COMMAND_MODE|INIT_CWD|NODE|COLOR|EDITOR|VISUAL|PAGER|LESS|MANPAGER|MANROFFOPT|MOTD_SHOWN|TERMINAL|Apple_PubSub_Socket_Render)$/,
];

export function isNoise(name: string): boolean {
  return NOISE.some((pattern) => pattern.test(name));
}

export interface EnvOptions {
  /** Extra variables whose values the reporter chose to share. */
  include: readonly string[];
  /** When set, other set variables get an HMAC of their value for disclosure-free comparison. */
  salt: string | null;
}

export interface EnvResult {
  env: Record<string, EnvFact>;
  valuesIncluded: string[];
}

/**
 * Records every meaningful variable by name and state. Values are kept only for the safe allowlist
 * and explicit includes, and even those pass through the redactor.
 */
export function collectEnv(
  source: NodeJS.ProcessEnv,
  options: EnvOptions,
  redactor: Redactor,
): EnvResult {
  const included = new Set(options.include);
  const names = new Set([
    ...Object.keys(source).filter((name) => !isNoise(name)),
    ...SAFE_VALUE_VARS,
    ...options.include,
  ]);
  const env: Record<string, EnvFact> = {};
  const valuesIncluded: string[] = [];

  for (const name of [...names].sort()) {
    const value = source[name];
    if (value === undefined) {
      env[name] = { state: 'absent' };
    } else if (value === '') {
      env[name] = { state: 'empty' };
    } else if (isSafeValue(name) || included.has(name)) {
      env[name] = { state: 'set', value: redactor.scrub(value) };
      valuesIncluded.push(name);
    } else if (options.salt) {
      env[name] = { state: 'set', hash: hmacSha256Hex(options.salt, value).slice(0, 32) };
    } else {
      env[name] = { state: 'set' };
    }
  }
  return { env, valuesIncluded };
}
