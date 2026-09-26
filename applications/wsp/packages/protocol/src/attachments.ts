// SPDX-License-Identifier: AGPL-3.0-only
// One image on its way from a person's clipboard to an agent's turn: what the
// wire carries, the types and caps every road checks it against, the words a
// refusal says, and the line a transcript prints for one. The composer, the
// command line and the MCP server check here before a byte leaves this
// computer, and the runtime checks again before it asks a machine, so a road
// that skipped the check cannot land an image on a machine. The types a
// harness takes are the same four everywhere, so they sit here once and the
// adapters read them rather than each naming its own.
import { z } from "zod";
import type { AttachmentRoad } from "./adapter-port.js";
import { GUEST_WSP_HOME } from "./daemon-contract.js";
import { fmtBytes } from "./format.js";

/** The image types a message carries, each with the word a transcript prints and the extension its copy on a machine
 * lands under. A type outside this table is refused before it travels: the harnesses take these four. */
export const IMAGE_TYPES: Readonly<Record<string, { word: string; ext: string }>> = {
  "image/png": { word: "png", ext: "png" },
  "image/jpeg": { word: "jpeg", ext: "jpg" },
  "image/gif": { word: "gif", ext: "gif" },
  "image/webp": { word: "webp", ext: "webp" },
};

/** What one image may weigh. A harness reads an image whole into its request, and the bytes travel base64 on our own
 * wire, so the cap bounds both. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** How many images one message carries. */
export const IMAGES_MAX = 5;

/** One image as the wire carries it: the type the harness is told and the bytes themselves, base64. The name is what
 * the person's file or paste was called, for the transcript's alt text only; nothing on a machine is keyed by it. */
export const ImageAttachment = z.object({
  mediaType: z.string(),
  bytes: z.string(),
  name: z.string().optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

/** What an image weighs, from the base64 the wire carries, without decoding it. */
export function imageBytes(image: { bytes: string }): number {
  const b64 = image.bytes;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
}

/** One image of a person's message as a transcript keeps it: what it was, what it weighed and what it was called.
 * The pixels are not here. They go to the harness and nowhere else, so a transcript costs the same however large the
 * image was, and nothing image-shaped is written to this computer's disk. */
export const ImageRecord = z.object({
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  name: z.string().optional(),
});
export type ImageRecord = z.infer<typeof ImageRecord>;

/** What a transcript keeps of one image the wire carried. */
export function imageRecord(image: ImageAttachment): ImageRecord {
  return { mediaType: image.mediaType, bytes: imageBytes(image), ...(image.name !== undefined ? { name: image.name } : {}) };
}

/** The four types as a person reads them, in one string. Every sentence that names what a message carries reads this
 * rather than spelling the list again: a fifth type is then one row in IMAGE_TYPES and this line. */
export const IMAGE_TYPE_WORDS = "PNG, JPEG, GIF or WebP";

/** The four types as a file picker's accept attribute takes them, off the same table. */
export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(",");

/** The size cap as a person reads it. Every sentence that names the cap reads this rather than spelling a number
 * beside it, so the words a person is told and the rule the code enforces cannot drift apart. */
export const IMAGE_MAX_WORDS = fmtBytes(IMAGE_MAX_BYTES);

/** The first bytes each of the four types starts with; WebP's is a RIFF header whose length comes before the word
 * that names the format, so its check is the head and a second run eight bytes in. */
const MAGIC: readonly { mediaType: string; head: readonly number[]; at8?: readonly number[] }[] = [
  { mediaType: "image/png", head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", head: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", head: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: "image/webp", head: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

/** What image these bytes are, read off the bytes themselves and never off a file's name, which lies; null when they
 * are none of the four a message carries. The command line and the MCP server read a person's file with this, so a
 * screenshot saved as .txt still travels and a .png that is a PDF is refused. */
export function imageTypeOf(bytes: Uint8Array): string | null {
  const starts = (at: number, want: readonly number[]): boolean => want.every((byte, i) => bytes[at + i] === byte);
  return MAGIC.find(m => starts(0, m.head) && (m.at8 === undefined || starts(8, m.at8)))?.mediaType ?? null;
}

/** The refusal of a file the person named that is not one of the four types, said before it travels. */
export function notAnImageLine(path: string): string {
  return `${path} is not ${IMAGE_TYPE_WORDS}; a message carries those four`;
}

/** The refusal of a path the person named that this computer has no file at, or has something other than a file at:
 * the road answers in a sentence, as every other refusal on it does, rather than in the reader's own error. */
export function notAFileLine(path: string): string {
  return `there is no file at ${path} on this computer`;
}

/** What a transcript prints in place of an image: its weight and its type, in one bracket. The command line prints
 * this on the person's turn, and the app prints it wherever it has no pixels of its own to draw. */
export function imageLine(image: ImageRecord): string {
  return `[image ${fmtBytes(image.bytes)} ${IMAGE_TYPES[image.mediaType]?.word ?? image.mediaType}]`;
}

/** Why these images cannot travel, in the person's words, or null when they can: too many for one message, one over
 * the size cap, one of a type no harness reads, or an empty one. The first thing wrong is the whole answer, since a
 * person fixes one image at a time. Takes the records, so a road that has the file's size and not its bytes yet (the
 * command line reading a path) asks the same question as one holding the bytes. */
export function imagesRefusal(images: readonly ImageRecord[]): string | null {
  if (images.length > IMAGES_MAX) return `only ${IMAGES_MAX} images fit one message; this one carries ${images.length}`;
  for (const [index, image] of images.entries()) {
    const at = image.name ?? `image ${index + 1}`;
    if (IMAGE_TYPES[image.mediaType] === undefined) return `${at} is ${image.mediaType || "of no stated type"}; a message carries ${IMAGE_TYPE_WORDS}`;
    if (image.bytes === 0) return `${at} is empty`;
    if (image.bytes > IMAGE_MAX_BYTES) return `${at} is ${fmtBytes(image.bytes)}, over the ${IMAGE_MAX_WORDS} an image may be`;
  }
  return null;
}

/** The refusal of a message with an image while the thread's turn is still running: a queued row keeps only its
 * words, so the images would leave the composer and reach nothing. */
export const IMAGES_AFTER_TURN = "the thread's turn is still running; an image goes with a message that starts a turn, so wait for this one to end";

/** The refusal of a message with an image to an agent that takes none, said before the machine is asked. */
export function noImagesLine(harness: string): string {
  return `${harness} takes no image with a message; describe it in words, or open the thread on an agent that reads images`;
}

/** Why these images cannot go to this agent, or null when they can: the caps first, since a person fixes those
 * whatever the agent is, then the agent itself, whose adapter may read no image at all. Every road that carries an
 * image asks this before a machine is asked for anything: the composer before the send, the command line and the MCP
 * server before the request, and the runtime again before the turn. */
export function imagesBlocked(images: readonly ImageRecord[], road: AttachmentRoad | undefined, harness: string): string | null {
  if (images.length === 0) return null;
  return imagesRefusal(images) ?? (road === undefined ? noImagesLine(harness) : null);
}

/** Where one thread's image copies live on a machine: every send of that thread has a folder under this one, so a
 * thread's copies go together and removing the thread removes all of them at once. Under the folder the daemon
 * inside a machine keeps its own files in, which on a computer somebody joined is the workspace's own. */
export function threadImagesDir(threadId: string): string {
  return `${GUEST_WSP_HOME}/threads/${threadId}/images`;
}

/** A folder name that is one path segment and nothing else. A request id is a string a client chose, and it travels
 * into a path on a machine, so one shaped like anything else is not used. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where one send's images live on a machine: its own folder under its thread's, named by the request id the client
 * minted for it, so two sends on one thread never write to the same path and the first turn cannot be handed the
 * second's picture. `minted` stands in when the send carried no request id, and when the one it carried is not a
 * plain id, since that string would otherwise be a path of the client's choosing. */
export function turnImagesDir(threadId: string, requestId: string | undefined, minted: string): string {
  const name = requestId !== undefined && PLAIN_ID.test(requestId) ? requestId : minted;
  return `${threadImagesDir(threadId)}/${name}`;
}

/** Where one image of a message lands inside its send's folder: named by its place in the message and its own type,
 * so the folder read in order is the message read in order. A type outside the table has no name here; imagesRefusal
 * is what turns that away, and this throws for a caller that never asked it. */
export function imagePathIn(dir: string, index: number, mediaType: string): string {
  const type = IMAGE_TYPES[mediaType];
  if (type === undefined) throw new Error(`${mediaType} is not an image type a message carries`);
  return `${dir}/${index + 1}.${type.ext}`;
}
