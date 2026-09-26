// SPDX-License-Identifier: AGPL-3.0-only
// The images a composer is holding, and the images a send carried, both in
// memory only. Nothing here is persisted: the draft store writes to local
// storage and an image would fill it, and the ticket's rule is that nothing an
// image is made of lands on this computer's disk. The bytes go to the host on
// the send and to an object URL for the thumbnail, and both go when the tab
// does. The bank keyed by request id is what lets the transcript draw the
// images of a message this browser sent; a transcript replayed after a reload
// has the records the runtime kept and draws their words instead.
import { create } from "zustand";
import { IMAGE_TYPES, imageTypeOf, imagesRefusal, notAnImageLine, type ImageAttachment, type ImageRecord } from "@wsp/protocol";
import { newId } from "./composerDraftStore";

export interface ComposerImage {
  readonly id: string;
  readonly mediaType: string;
  readonly name: string;
  /** The image's bytes, base64, exactly what the wire carries. */
  readonly bytes: string;
  /** An in-memory URL over the same bytes, for the thumbnail and the full-size view; revoked when the image leaves. */
  readonly url: string;
  /** What the image weighs, so the row and the transcript say it without decoding the base64 again. */
  readonly size: number;
}

const NONE: ReadonlyArray<ComposerImage> = [];

/** How many sends of one tab keep their images in memory. Beyond this the oldest let go and their rows read as any
 * other client's do. A message at both caps is fifty megabytes, so this bounds what one tab holds. */
const SENT_KEPT = 10;

/** Base64 in chunks: one spread of ten million bytes into fromCharCode overflows the argument stack. */
const CHUNK = 0x8000;
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
}

/** The record form of an image the composer holds, for the one refusal rule the whole product shares. */
export const recordOf = (image: ComposerImage): ImageRecord => ({ mediaType: image.mediaType, bytes: image.size, name: image.name });

/** What the wire carries for an image the composer holds. */
export const attachmentOf = (image: ComposerImage): ImageAttachment => ({ mediaType: image.mediaType, bytes: image.bytes, name: image.name });

/** A blob's bytes through FileReader, the one road every browser has; Blob.arrayBuffer is newer than the oldest
 * engine the app runs in and than the jsdom the component tests run under. */
function bytesOf(blob: Blob): Promise<{ bytes: Uint8Array; buffer: ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      resolve({ bytes: new Uint8Array(buffer), buffer });
    };
    reader.onerror = () => reject(reader.error ?? new Error("that file could not be read"));
    reader.readAsArrayBuffer(blob);
  });
}

/** The head every image type is told apart by; the longest of the four is twelve bytes. */
const HEAD_BYTES = 12;

/** What one file the person pasted, dropped or picked is, without reading it whole: its type off its own first
 * bytes rather than its name, and its weight off the file, so naming a video does not pull it into memory to be
 * refused. The same reading the command line does. Null when the bytes are none of the four types a message
 * carries. */
export async function imageFactsOf(file: File): Promise<ImageRecord | null> {
  const { bytes } = await bytesOf(file.slice(0, HEAD_BYTES));
  const mediaType = imageTypeOf(bytes);
  if (mediaType === null) return null;
  return { mediaType, bytes: file.size, name: file.name === "" ? `pasted.${IMAGE_TYPES[mediaType]?.ext ?? "png"}` : file.name };
}

/** One file read whole, once its facts have passed the caps. */
export async function imageOf(file: File, facts: ImageRecord): Promise<ComposerImage> {
  const { bytes, buffer } = await bytesOf(file);
  return {
    id: newId(),
    mediaType: facts.mediaType,
    name: facts.name ?? file.name,
    bytes: toBase64(bytes),
    url: URL.createObjectURL(new Blob([buffer], { type: facts.mediaType })),
    size: bytes.length,
  };
}

interface ImagesState {
  /** Keyed by workspace, as the draft is: what the composer will send next. */
  pending: Record<string, ReadonlyArray<ComposerImage>>;
  /** Keyed by the request id the composer minted for a send: what that message carried, for this tab's lifetime. */
  sent: Record<string, ReadonlyArray<ComposerImage>>;
  /** Adds what the person gave, answering with the refusal that turned them away, or null when every one was taken. */
  add(workspaceId: string, files: readonly File[]): Promise<string | null>;
  remove(workspaceId: string, id: string): void;
  /** Moves this workspace's images onto the request id its send carried; the composer opens empty. */
  sendAs(workspaceId: string, requestId: string): void;
  /** Puts back what a refused send took, so the person's images are not lost with the request. */
  restore(workspaceId: string, requestId: string): void;
}

export const useComposerImagesStore = create<ImagesState>()((set, get) => ({
  pending: {},
  sent: {},
  async add(workspaceId, files) {
    // The heads first, so a file that is not an image, or is over the cap, is turned away before it is read whole.
    const read = await Promise.all(files.map(async file => ({ file, facts: await imageFactsOf(file) })));
    const rejected = read.find(r => r.facts === null);
    if (rejected !== undefined) return notAnImageLine(rejected.file.name || "that file");
    const held = get().pending[workspaceId] ?? NONE;
    const facts = read.map(r => r.facts!);
    const refusal = imagesRefusal([...held.map(recordOf), ...facts]);
    if (refusal !== null) return refusal;
    const taken = await Promise.all(read.map(r => imageOf(r.file, r.facts!)));
    let dropped = false;
    set(s => {
      const now = s.pending[workspaceId] ?? NONE;
      // Two adds can be in flight (a paste while a drop is still reading); the second checks the caps again against
      // what the first left, and gives its own bytes back rather than putting the composer over them.
      if (imagesRefusal([...now.map(recordOf), ...facts]) !== null) {
        dropped = true;
        return s;
      }
      return { pending: { ...s.pending, [workspaceId]: [...now, ...taken] } };
    });
    if (!dropped) return null;
    for (const image of taken) URL.revokeObjectURL(image.url);
    return imagesRefusal([...(get().pending[workspaceId] ?? NONE).map(recordOf), ...facts]);
  },
  remove(workspaceId, id) {
    set(s => {
      const rows = s.pending[workspaceId] ?? NONE;
      const going = rows.find(r => r.id === id);
      if (going === undefined) return s;
      URL.revokeObjectURL(going.url);
      const kept = rows.filter(r => r.id !== id);
      const { [workspaceId]: _gone, ...rest } = s.pending;
      return { pending: kept.length === 0 ? rest : { ...s.pending, [workspaceId]: kept } };
    });
  },
  sendAs(workspaceId, requestId) {
    set(s => {
      const rows = s.pending[workspaceId] ?? NONE;
      if (rows.length === 0) return s;
      const { [workspaceId]: _gone, ...rest } = s.pending;
      // A tab left open all day would otherwise hold every image it ever sent; the oldest sends let go of theirs,
      // and their rows in the transcript fall back to the runtime's records, as another client's already do.
      const sent = { ...s.sent, [requestId]: rows };
      const keys = Object.keys(sent);
      for (const old of keys.slice(0, Math.max(0, keys.length - SENT_KEPT))) {
        for (const image of sent[old] ?? NONE) URL.revokeObjectURL(image.url);
        delete sent[old];
      }
      return { pending: rest, sent };
    });
  },
  restore(workspaceId, requestId) {
    set(s => {
      const rows = s.sent[requestId];
      if (rows === undefined) return s;
      const { [requestId]: _gone, ...rest } = s.sent;
      return { sent: rest, pending: { ...s.pending, [workspaceId]: [...rows, ...(s.pending[workspaceId] ?? NONE)] } };
    });
  },
}));

export function useComposerImages(workspaceId: string): ReadonlyArray<ComposerImage> {
  return useComposerImagesStore(s => s.pending[workspaceId] ?? NONE);
}

/** The images this tab sent under that request id, or none when the message came from another client or a reload. */
export function useSentImages(requestId: string | undefined): ReadonlyArray<ComposerImage> {
  return useComposerImagesStore(s => (requestId === undefined ? NONE : s.sent[requestId] ?? NONE));
}
