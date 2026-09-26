// SPDX-License-Identifier: AGPL-3.0-only
// A host a place can dial, for tests on either side of the link: a real ws
// server with a real ed25519 pair, so the handshake a daemon runs is the one
// this answers and nothing here fakes a signature. The bytes both sides sign
// come from the protocol, as they do on the wire.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLACE_FILE_MODE, placeFileText, placeLinkTranscript, placeRefusalTranscript, type PlaceFile } from "@wsp/protocol";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret, type Seal } from "@wsp/runtime";

export interface PlacePair {
  publicKey: string;
  privateKeyPem: string;
}

export function placePair(): PlacePair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

const dirs: string[] = [];
const servers: WebSocketServer[] = [];

/** Everything a test made here, taken down: the ws servers and the folders the place files sit in. */
export async function closeFakePlaceHosts(): Promise<void> {
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The place file at the one mode a join ever keeps it at, which is what the daemon reads it back at. */
export function writePlaceFile(path: string, file: PlaceFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, placeFileText(file), { mode: PLACE_FILE_MODE });
  chmodSync(path, PLACE_FILE_MODE);
}

/** A place file in a folder of its own, with the private key beside it. */
export function testPlaceFile(hostUrls: string[], hostPublicKey: string, keyPem: string, placeId = "p_ab12cd34"): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-link-"));
  dirs.push(dir);
  const keyPath = join(dir, "place-key.pem");
  writeFileSync(keyPath, keyPem);
  const file: PlaceFile = { placeId, name: "old-macbook", hostName: "zingzy-mbp", hostUrls, hostPublicKey, keyPath, joinedAt: new Date(0).toISOString() };
  const path = join(dir, "place.json");
  writePlaceFile(path, file);
  return path;
}

/** A host that answers the handshake with a real signature. `wrongTranscript` signs the place's own half instead of
 * its own, which is the one thing a place must refuse. */
export interface FakeHost {
  url: string;
  /** How many sockets the place has opened to it. */
  dials: () => number;
  /** Every frame the place sent after the handshake, in order. */
  frames: Record<string, unknown>[];
  /** Every place.prove the place sent, report and all. */
  proofs: Record<string, unknown>[];
  /** The socket the place is holding, once it has proved, with the seal its frames ride inside. */
  socket: Promise<{ ws: ServerSocket; seal: Seal }>;
  publicKey: string;
}

export async function fakePlaceHost(opts: { key?: PlacePair; wrongTranscript?: boolean; refuse?: string; signRefusal?: boolean; unsealed?: boolean } = {}): Promise<FakeHost> {
  const key = opts.key ?? placePair();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
  const proofs: Record<string, unknown>[] = [];
  let dials = 0;
  let held!: (s: { ws: ServerSocket; seal: Seal }) => void;
  const socket = new Promise<{ ws: ServerSocket; seal: Seal }>(done => (held = done));
  wss.on("connection", ws => {
    dials++;
    ws.on("error", () => {});
    /** Set once this host has answered the handshake: from the prove on the link is sealed both ways. */
    let seal: Seal | undefined;
    const say = (payload: Record<string, unknown>): void => {
      const text = JSON.stringify(payload);
      ws.send(seal === undefined ? text : seal.seal(text));
    };
    const read = (raw: unknown): void => {
      const frame = JSON.parse(seal === undefined ? String(raw) : seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
      if (frame["op"] === "place.auth") {
        if (opts.refuse !== undefined) {
          // A host that signs its refusal gives its own word before it has proved anything else, over the place
          // it was asked for, the nonce this dial challenged with and the sentence; one that does not is every
          // host before this and anybody else who answers at the address.
          const signed = opts.signRefusal !== true ? {} : {
            hostPublicKey: key.publicKey,
            signature: sign(null, placeRefusalTranscript(String(frame["placeId"]), String(frame["nonce"]), opts.refuse), createPrivateKey(key.privateKeyPem)).toString("base64"),
          };
          say({ id: frame["id"], ok: false, error: opts.refuse, kind: "auth", ...signed });
          ws.close(4401, "unauthorized");
          return;
        }
        const placeId = String(frame["placeId"]);
        const placeNonce = String(frame["nonce"]);
        const nonce = Buffer.alloc(32, 9).toString("base64");
        // A host that agrees no key of its own is what this stands in for when `unsealed` is set: the computer
        // passes the address over rather than holding a link neither end can seal.
        const mine = freshEphemeral();
        const ephemerals = { challenger: String(frame["ephemeral"]), answerer: mine.publicKey };
        const bytes = opts.wrongTranscript === true ? placeLinkTranscript("place", placeId, placeNonce, nonce, ephemerals) : placeLinkTranscript("host", placeId, placeNonce, nonce, ephemerals);
        const signature = sign(null, bytes, createPrivateKey(key.privateKeyPem)).toString("base64");
        say({ id: frame["id"], ok: true, nonce, hostPublicKey: key.publicKey, signature, ...(opts.unsealed === true ? {} : { ephemeral: mine.publicKey }) });
        if (opts.unsealed !== true) seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, String(frame["ephemeral"])), placeId), "host");
        return;
      }
      if (frame["op"] === "place.prove") {
        proofs.push(frame);
        say({ id: frame["id"], ok: true });
        // The socket and its seal go to whoever asked for them: a seal counts the frames it opens, so this host
        // stops reading the moment it hands them over.
        ws.off("message", read);
        held({ ws, seal: seal! });
        return;
      }
      frames.push(frame);
    };
    ws.on("message", read);
  });
  const port = await listening(wss);
  return { url: `http://127.0.0.1:${port}`, dials: () => dials, frames, proofs, socket, publicKey: key.publicKey };
}

/** The port a fresh server bound, once it has: address() answers null until the loop turns. */
export const listening = (wss: WebSocketServer): Promise<number> =>
  new Promise((done, fail) => {
    wss.once("listening", () => done((wss.address() as { port: number }).port));
    wss.once("error", fail);
  });

export const settled = (ms = 50): Promise<void> => new Promise(done => setTimeout(done, ms));
