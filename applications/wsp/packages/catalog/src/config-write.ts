// SPDX-License-Identifier: AGPL-3.0-only
// The one write of an agent's config file on any computer, as a line for that
// computer's own sh, since a machine need carry no node: the new bytes are
// staged in a temp file beside the real one carrying its mode, then renamed
// over it, so the file is what was read or the whole new text. A file with a
// second hard link is refused, since the rename would leave the other name on
// the old text; a file the agent wrote since the read is left as it wrote it;
// a link inside the base is written through and stays a link. A temp file a
// killed write left beside a config is swept by the next write there.
import { configChangedRefusal, configHardLinkRefusal, configLinkRefusal, shellQuote } from "@wsp/protocol";

/** The exit a write takes, with the file and where it points on stdout, when the file is a link out of its base. */
export const CONFIG_LINK_EXIT = 4;
/** The exit a write takes when the file is not what was read. */
export const CONFIG_CHANGED_EXIT = 5;
/** The exit a write takes when the file has another hard link. */
export const CONFIG_LINKS_EXIT = 6;

/** Every temp file the write stages beside a config: this, then mktemp's six letters and digits or a landing's
 * twelve hex digits. The sweep takes those two shapes and nothing else, since the folder may be the person's home. */
const TEMP = ".wsp-config-tmp.";
const MINTED = [`${TEMP}${"[A-Za-z0-9]".repeat(6)}`, `${TEMP}${"[0-9a-f]".repeat(12)}`];
/** A temp file older than this belongs to a write that was killed; a live one takes milliseconds. */
const STALE_MINUTES = 10;

export interface ConfigWrite {
  /** The file as named, absolute. */
  file: string;
  /** The folder the file, the target of a link to it and a folder made for it must stand inside. */
  base: string;
  /** The file's checksum as read (configSum); absent where there was no file, and then one that is there now is left. */
  sum?: string;
  /** How long the new text is, in bytes. */
  bytes: number;
  /** A file beside the config the bytes already wait in (configLanding), taken with the write; absent, stdin. */
  from?: string;
}

/** Where bytes a road uploads wait beside the config before the write takes them; `id` is twelve hex digits, the
 * shape the sweep takes. */
export function configLanding(file: string, id: string): string {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("a landing's id is twelve hex digits");
  return `${file.slice(0, file.lastIndexOf("/"))}/${TEMP}${id}`;
}

/** A shell check that the real path `$r` stands inside the base's real path `$b`, else says the path and exits. */
export const insideBase = (said: string): string => `case $r/ in "$b"/*) ;; *) printf '%s\\000%s\\000' ${said} "$r"; exit ${CONFIG_LINK_EXIT};; esac`;

/** A refusal's exit, the file named on stdout so a line holding several writes says which one refused. Every path a
 * line says ends in a NUL, the one byte no path holds. */
const refuse = (code: number): string => `{ printf '%s\\000' "$f"; exit ${code}; }`;

export function configWriteLine(w: ConfigWrite): string {
  const q = shellQuote;
  const there = '{ [ -e "$r" ] || [ -L "$r" ]; }';
  const landing = w.from === undefined ? "" : ' "$l"';
  return [
    "umask 077",
    ...(w.from === undefined ? [] : [`l=${q(w.from)}`, `trap 'rm -f --${landing}' EXIT`]),
    `b=$(realpath ${q(w.base)}) || exit 1`,
    `f=${q(w.file)}`,
    'if [ -e "$f" ] || [ -L "$f" ]; then',
    `  ${w.sum === undefined ? refuse(CONFIG_CHANGED_EXIT) : ":"}`,
    `  r=$(realpath "$f" 2>/dev/null) || { printf '%s\\000%s\\000' "$f" "$(readlink "$f")"; exit ${CONFIG_LINK_EXIT}; }`,
    `  ${insideBase('"$f"')}`,
    `  [ -z "$(find "$r" -links +1)" ] || ${refuse(CONFIG_LINKS_EXIT)}`,
    "else",
    `  ${w.sum === undefined ? ":" : refuse(CONFIG_CHANGED_EXIT)}`,
    '  d=${f%/*}; a=$d',
    '  while [ -n "$a" ] && [ ! -e "$a" ]; do a=${a%/*}; done',
    '  r=$(realpath "${a:-/}") || exit 1',
    `  ${insideBase('"$a"')}`,
    '  mkdir -p "$d" || exit 1',
    "  r=$f",
    "fi",
    `for s in "\${f%/*}" "\${r%/*}"; do LC_ALL=C find "$s" -maxdepth 1 -type f \\( ${MINTED.map(m => `-name '${m}'`).join(" -o ")} \\) -mmin +${STALE_MINUTES} -exec rm -f {} + 2>/dev/null; done`,
    `n=$(mktemp "\${r%/*}/${TEMP}XXXXXX") || exit 1`,
    `trap 'rm -f -- "$n"${landing}' EXIT`,
    `if ${there}; then cp -p "$r" "$n" || exit 1; fi`,
    `cat${landing} > "$n" || exit 1`,
    `[ "$(wc -c < "$n" | tr -d ' ')" = ${w.bytes} ] || exit 1`,
    w.sum === undefined ? `${there} && ${refuse(CONFIG_CHANGED_EXIT)}` : `[ "$(cksum < "$r")" = ${q(w.sum)} ] || ${refuse(CONFIG_CHANGED_EXIT)}`,
    'mv -f "$n" "$r" || exit 1',
  ].join("\n");
}

/** The sentence for a write the line refused, each path said by `shown`: the file the line named on stdout, else
 * `file`. Nothing for any other exit. */
export function configRefusal(res: { exitCode: number; stdout: string }, file: string, shown: (path: string) => string): string | undefined {
  const [named, to = ""] = res.stdout.split("\0");
  const at = shown(named || file);
  if (res.exitCode === CONFIG_LINK_EXIT) return configLinkRefusal(at, shown(to));
  if (res.exitCode === CONFIG_CHANGED_EXIT) return configChangedRefusal(at);
  if (res.exitCode === CONFIG_LINKS_EXIT) return configHardLinkRefusal(at);
  return undefined;
}

const CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

/** What POSIX cksum prints for the bytes, which is what the write compares the file on disk with. */
export function configSum(bytes: Uint8Array): string {
  let crc = 0;
  const step = (b: number): void => void (crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xff]!) >>> 0);
  for (const b of bytes) step(b);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return `${~crc >>> 0} ${bytes.length}`;
}
