// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_BEAT_MS,
  ADDRESS_NEXT_START,
  NOT_UP_YET,
  NO_HOSTS_LINE,
  hostBeatWord,
  hostDroppedLine,
  hostKeyMovedLine,
  hostsTable,
  relayQuietLine,
  backgroundTasksLine,
  taskFinishedLine,
  psCpuSeconds,
  biggerSizeLine,
  catalogSourceLine,
  codexNotSignedInLine,
  THIS_COMPUTER,
  PERMISSION_DENIED_LINE,
  ACCESS_REFUSED_LINE,
  ACCESS_REFUSED_WORDS,
  accessReachLine,
  askingLine,
  permissionAskLine,
  permissionPromptWords,
  permissionModeOptionLabel,
  permissionOutcomeLine,
  QUESTION_TOOL,
  askedQuestions,
  questionOptions,
  questionAnswerInput,
  pickedOptions,
  pickedOptionId,
  internalToolResult,
  subagentTaskLine,
  subagentAskerLine,
  waitingAskerLine,
  noModelsLine,
  type HarnessCatalog,
  MEMORY_NEAR_FULL,
  memoryNearFull,
  outOfMemoryLine,
  outOfMemoryRowLine,
  stillWorkingLine,
  stopFailedLine,
  sendNowFailedLine,
  TURN_IN_FLIGHT,
  foreignFlagLine,
  refusalLine,
  runForTheList,
  sayOnce,
  unknownWordLine,
  unknownAgentLine,
  cutLine,
  IDLE_REASON,
  LINEAGE_MARKS,
  NO_TEMPLATES_LINE,
  templateFailedLine,
  templateRecordedLine,
  templateSkippedLine,
  templateStatusLine,
  templateWaitedLine,
  REPO_STATE_WORDS,
  missingToolRow,
  behindGoldenLine,
  builderStaysLine,
  DAEMON_INSTALL_FAILED,
  DAEMON_INSTALLING,
  DAEMON_UPDATE_FAILED,
  DAEMON_UPDATING,
  DISK_SYNC_LINE,
  diskSyncFailedLine,
  diskUnsettledLine,
  RECORD_RESTORED,
  nameDeletingRefusal,
  nameTakenRefusal,
  recordRestoredLine,
  execFailedLine,
  execFolderLine,
  folderRefusalLine,
  fmtBytes,
  fmtCost,
  fmtDuration,
  fmtElapsed,
  fmtMemGb,
  fmtRate,
  fmtSize,
  boxRoomLines,
  placeFactsLine,
  fmtThreads,
  fmtUptime,
  forgetNotice,
  goldenBuildLine,
  goneWords,
  harnessExitLine,
  isCodeSearchTool,
  guestUnusableLine,
  kindWords,
  listedName,
  loginPathLine,
  machineCapRefusal,
  machineUnreachableLine,
  machineUnreachedLine,
  napRefusedLine,
  mcpServerCommandLine,
  moveTimedOutLine,
  RESUME_UNANSWERED,
  wakeAsksIn,
  WAKE_STOPPED,
  wakeAskingAgainLine,
  wakeGaveUpLine,
  workspaceAwakeLine,
  nameList,
  nextInsideAgentLine,
  notifyBody,
  notifyLine,
  notifyTail,
  offeredSize,
  sizeOffer,
  plural,
  PROVIDER_UNREACHED_LINE,
  providerAnswerLine,
  providerRoadRetryLine,
  SEAL_FAILED_BUILDER_GONE_LINE,
  SEAL_FAILED_LINE,
  sealFailedBuilderStaysLine,
  sealFailedBuilderUnreadLine,
  INSTALLER_MOVED_LINE,
  NO_ROAD_WORDS,
  installedHereLine,
  installsByLine,
  leftOutLine,
  notHereLine,
  thisComputer,
  SUM_SHOWN,
  pinMismatchLine,
  pinWords,
  pinsReadLine,
  sealedPinLine,
  INSTALLS_LATEST,
  roadMovedLine,
  shortSum,
  sizeFromWord,
  sizeRefusal,
  sizeWord,
  snapshotAttemptLine,
  snapshotFailedLine,
  stepRetryLine,
  timedOutLine,
  lastLine,
  waitTimedOutLine,
  generatedTitle,
  GENERATED_TITLE_MAX,
  openingTitle,
  storedTitleSource,
  titlePrompt,
  titleLine,
  toolActivityLine,
  toolDoneLine,
  validatorRefusal,
  toolCallFacts,
  toolResultLine,
  TURN_IDLE_MS,
  TURN_WALL_MS,
  turnCutLine,
  turnEndLine,
  LIST_PRICE_WORD,
  openedSpendPart,
  turnSpendPart,
  turnSettledLine,
  turnSettledParts,
  waitedOnYouPart,
  refusedTurn,
  signInRefusalLine,
  upgradeSealFailedGoneLine,
  upgradeSealFailedStaysLine,
  upgradeSealFailedUnreadLine,
  imageKeptLine,
  IMAGE_ALREADY_NEWEST,
  IMAGE_MOVE_CONFIRM,
  vaultKeptLine,
  HOSTNAME_KEPT,
  hostnameSetLine,
  startingLine,
  imageHomeKeptLine,
  CREATE_READY,
  vaultStaleLine,
  vaultOverCapLine,
  importIntoLine,
  importProgress,
  exportProgress,
  exportFromLine,
  EXPORT_SESSIONS_NOTE,
  NO_THREADS_NOTE,
  NOT_GONE,
  NOT_LANDED_WORD,
  repoLine,
  secretsNote,
  secretSignalsLine,
  SESSIONS_NOTE,
  shellVersionNotice,
  type GoldenMissingTool,
} from "../src/index.js";
import * as format from "../src/format.js";
import * as protocol from "../src/index.js";
import { ROOT, sourceFiles } from "./source-files.js";

describe("the package's index", () => {
  it("carries every value format.ts exports, the same binding: a local declaration in index.ts would shadow a star export in silence", () => {
    const names = Object.keys(format).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(names.map(name => [name, (protocol as Record<string, unknown>)[name] === (format as Record<string, unknown>)[name]])).toEqual(names.map(name => [name, true]));
  });
});

// One describe per helper family, in format.ts order, so two tickets' tests land in different hunks.

describe("fmtBytes and fmtMemGb", () => {
  it("reads whole units under a gigabyte, then GB with one decimal unless whole", () => {
    expect([0, 12, 1023, 1024, 2_048, 1536, 3 * 1024 * 1024, 38.2 * 1024 * 1024, 38.6 * 1024 * 1024, 2.3 * 1024 ** 3, 20 * 1024 ** 3, 32_000_000_000].map(fmtBytes)).toEqual([
      "0 B", "12 B", "1023 B", "1 KB", "2 KB", "2 KB", "3 MB", "38 MB", "39 MB", "2.3 GB", "20 GB", "29.8 GB",
    ]);
  });

  it("a machine size's memory reads as GB, whole when it is whole and with the fraction when there is one", () => {
    expect([1536, 2048, 3000, 4096, 32768].map(fmtMemGb)).toEqual(["1.5 GB", "2 GB", "2.9 GB", "4 GB", "32 GB"]);
  });

  it("has a GB tier with a decimal, and whole megabytes under it: a tenth of a megabyte is noise at that scale", () => {
    expect(fmtBytes(3000 * 1024 * 1024)).toBe("2.9 GB");
    expect(fmtBytes(2048 * 1024 * 1024)).toBe("2 GB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(fmtBytes(250.4 * 1024 * 1024)).toBe("250 MB");
  });
});

describe("a computer of the person's own in one line", () => {
  it("names its cores, its memory and the room left where its threads work, as one unbreakable phrase", () => {
    const line = placeFactsLine({ cpu: 4, memMb: 8192 }, 97_710_505_984);
    expect(line).toBe("4 cores, 8 GB, 91 GB free".replace(/ /g, "\u00a0"));
    // A computer that would not say how much room it has says the rest.
    expect(placeFactsLine({ cpu: 8, memMb: 16384 })).toBe("8 cores, 16 GB".replace(/ /g, "\u00a0"));
    // Cores, never vCPU: a computer somebody owns has the cores it has.
    expect(line).not.toContain("vCPU");
  });
});

describe("the room left on a box, as the doctor reads it back", () => {
  const box = { cores: 2, memMb: 4096 };
  it("counts the forks that exist and leaves the rest free", () => {
    // Two forks on a two core box, one core and one gigabyte each: the box is full of cores and has memory left.
    expect(boxRoomLines({ ...box, cpuTaken: 2, memTakenMb: 2048 })).toEqual(["2 cores, 2 in use by forks, 0 free", "4 GB, 2 GB in use by forks, 2 GB free"]);
    expect(boxRoomLines({ ...box, cpuTaken: 1, memTakenMb: 1024 })).toEqual(["2 cores, 1 in use by forks, 1 free", "4 GB, 1 GB in use by forks, 3 GB free"]);
    // A box with nothing on it, and the one core singular.
    expect(boxRoomLines({ cores: 1, memMb: 2048, cpuTaken: 0, memTakenMb: 0 })).toEqual(["1 core, 0 in use by forks, 1 free", "2 GB, 0 GB in use by forks, 2 GB free"]);
  });

  it("says nothing at all where the computer counts neither", () => {
    expect(boxRoomLines(box)).toEqual([]);
    expect(boxRoomLines({ ...box, cpuTaken: 1 })).toEqual([]);
  });

  it("never reads back less than nothing free when the forks hold more than the box has", () => {
    expect(boxRoomLines({ ...box, cpuTaken: 3, memTakenMb: 8192 })).toEqual(["2 cores, 3 in use by forks, 0 free", "4 GB, 8 GB in use by forks, 0 GB free"]);
  });
});

describe("a machine that stopped answering with its memory near full", () => {
  const GiB = 1024 ** 3;
  const offers = [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
    { cpu: 4, memMb: 16384, rateUsdPerHour: 0.3 },
  ];

  it("near full is the measured share, on the number only", () => {
    expect(MEMORY_NEAR_FULL).toBe(0.9);
    expect(memoryNearFull({ used: 3.59 * GiB, total: 3.94 * GiB })).toBe(true);
    expect(memoryNearFull({ used: 90, total: 100 })).toBe(true);
    expect(memoryNearFull({ used: 89, total: 100 })).toBe(false);
    expect(memoryNearFull({ used: 0, total: 0 })).toBe(false);
  });

  it("the line carries the last figures and says the work took the memory, never that the machine failed", () => {
    expect(outOfMemoryLine({ used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.42 })).toBe(
      "Out of memory (3.6 GB of 3.9 GB used, load 6.4) when the task last answered; the work on it took the memory, not a fault of the computer it runs on",
    );
  });

  it("the row form says the unit once when both sides share it, so the sidebar's second line holds it whole", () => {
    expect(outOfMemoryRowLine({ used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.42 })).toBe("out of memory, 3.6 of 3.9 GB");
    expect(outOfMemoryRowLine({ used: 900 * 1024 ** 2, total: 3.94 * GiB, load1: 1 })).toBe("out of memory, 900 MB of 3.9 GB");
  });

  it("the size line names the smallest offer with more memory and its rate, or that there is none", () => {
    expect(biggerSizeLine({ cpu: 2, memMb: 4096 }, offers)).toBe("A task on 2 vCPU, 8 GB ($0.15/hr) fits more; pick it when you make the next one");
    expect(biggerSizeLine({ cpu: 2, memMb: 8192 }, offers)).toBe("A task on 4 vCPU, 16 GB ($0.30/hr) fits more; pick it when you make the next one");
    expect(biggerSizeLine({ cpu: 4, memMb: 16384 }, offers)).toBe("No size with more memory is offered; run less in the task at once");
    // Order in the table does not pick the offer; memory does.
    expect(biggerSizeLine({ cpu: 2, memMb: 4096 }, [...offers].reverse())).toContain("2 vCPU, 8 GB");
  });
});

describe("one copy of the rule", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // Snapshot storage prints the decimal GB the provider lists and bills in.
  const EXCEPTIONS = new Set([join("packages", "host", "src", "storage.ts")]);
  // A byte count divided by a unit constant and closed with a unit suffix, or a table of unit suffixes.
  const RULE = /\/ ?(1024|1e9|1_000_000_000|\(1024 \* 1024\)|1024 \*\* [23]|[KMGT]I?B|[KMGT]iB)\)?[^`\n]*\} ?[KMGT]?i?B`|\[("[KMGT]?i?B?",? ?){3,}\]/;

  const hits = (rel: string): number => [...readFileSync(join(ROOT, rel), "utf8").matchAll(new RegExp(RULE.source, "g"))].length;

  it("no other source file spells out a byte formatter", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && !EXCEPTIONS.has(rel) && hits(rel) > 0);
    expect(copies).toEqual([]);
  });

  it("each recorded exception holds exactly one formatter: a folded one leaves the list, a second one is a copy", () => {
    expect([...EXCEPTIONS].map(rel => [rel, hits(rel)])).toEqual([...EXCEPTIONS].map(rel => [rel, 1]));
  });
});

describe("the cumulative cpu ps prints", () => {
  it("reads days, hours, minutes, seconds and this Mac's hundredths, and nothing else as no cpu at all", () => {
    // Fixture provenance: Linux prints whole seconds (00:02:17), macOS hundredths (12:31.07), and either adds a day
    // field past 24 hours. The runtime's turn clock and the daemon's processes module both read this one parser.
    expect(psCpuSeconds("00:00:03")).toBe(3);
    expect(psCpuSeconds("00:02:17")).toBe(137);
    expect(psCpuSeconds("12:31.07")).toBeCloseTo(751.07, 5);
    expect(psCpuSeconds("1-18:19:15")).toBe(86_400 + 18 * 3600 + 19 * 60 + 15);
    expect(psCpuSeconds("-")).toBe(0);
    expect(psCpuSeconds("")).toBe(0);
    expect(psCpuSeconds("what")).toBe(0);
  });
});

describe("one copy of the image caps", () => {
  const HOME = join("packages", "protocol", "src", "attachments.ts");
  // The caps as a person reads them and as the code counts them: what a message may carry, and what one image may
  // weigh. A second spelling anywhere drifts from the constant the code enforces, which is how "10 MB each" came to
  // sit beside a rule that says 10 MB. attachments.ts exports IMAGES_MAX, IMAGE_MAX_BYTES, IMAGE_MAX_WORDS and
  // IMAGE_TYPE_WORDS for every sentence to read.
  const RULE = /\b10(\.0)? ?MB\b|10 \* 1024 \* 1024|\b(five|5) images\b|PNG, JPEG, GIF or WebP|image\/png,\s*image\/jpeg/;

  it("no source file outside attachments.ts spells an image cap or the type list out again", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });

  it("attachments.ts is where they are written, so the rule is watching something real", () => {
    expect(RULE.test(readFileSync(join(ROOT, HOME), "utf8"))).toBe(true);
  });
});

describe("one registry for the tools a harness reports", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // One row per tool name there carries its line, the input field a client shows for the call and the kind of item it is.
  const RULE = /"(file_path|notebook_path|MultiEdit|NotebookEdit|WebSearch|WebFetch)"/;

  it("no other source file names a tool of a harness or the input field a client shows for it", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});

describe("where the composer's model lists came from, in one line", () => {
  const TABLE: HarnessCatalog = {
    harness: "codex",
    label: "Codex",
    source: "table",
    version: "app-server 0.153.0, 2026-09-07",
    models: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
    efforts: [],
    contextWindows: [],
    permissionModes: [],
    steers: false,
    renames: false,
    images: false,
  };

  it("names the agent's own binary and its own pin when its table stood in, never another agent's", () => {
    expect(catalogSourceLine(TABLE, THIS_COMPUTER)).toBe("codex table, app-server 0.153.0, 2026-09-07");
    expect(catalogSourceLine({ ...TABLE, harness: "claude", label: "Claude Code", version: "--help 2.1.257, 2026-09-05" }, THIS_COMPUTER)).toBe("claude table, --help 2.1.257, 2026-09-05");
    // One line at the popup's width: 48 characters of the 10px mono the footer draws in, measured in Chromium.
    expect(catalogSourceLine(TABLE, THIS_COMPUTER).length).toBeLessThanOrEqual(48);
  });

  it("says the adapter's own reason where the binary answered and named one, in place of naming the table", () => {
    expect(catalogSourceLine({ ...TABLE, refusal: codexNotSignedInLine("codex login") }, THIS_COMPUTER)).toBe(
      "Codex is not signed in where this workspace runs; run codex login there, app-server 0.153.0, 2026-09-07",
    );
  });

  it("a table with no pin of its own claims none, and the binary that answered carries the version and where it ran", () => {
    expect(catalogSourceLine({ ...TABLE, harness: "gemini", label: "Gemini CLI", version: null }, THIS_COMPUTER)).toBe("gemini table");
    expect(catalogSourceLine({ ...TABLE, source: "harness", version: "0.153.0" }, THIS_COMPUTER)).toBe("Codex 0.153.0 on this computer");
    expect(catalogSourceLine({ ...TABLE, source: "harness", version: null }, "hetzner")).toBe("Codex on hetzner");
    // The reason belongs to the fallback: a binary that filled the lists has nothing to explain.
    expect(catalogSourceLine({ ...TABLE, source: "harness", version: "0.153.0", refusal: "not signed in" }, THIS_COMPUTER)).toBe("Codex 0.153.0 on this computer");
  });

  it("an empty model list reads as the source that gave it: what the binary reported, or what the table holds", () => {
    expect(noModelsLine({ ...TABLE, source: "harness", models: [] })).toBe("Codex reported no models");
    expect(noModelsLine({ ...TABLE, models: [] })).toBe("No model in the Codex table");
  });

  it("the foot names the agent, its version and where the turn runs, and nothing else", () => {
    const claude: HarnessCatalog = { ...TABLE, harness: "claude", label: "Claude Code", source: "harness", version: "2.1.257" };
    expect(catalogSourceLine(claude, THIS_COMPUTER)).toBe("Claude Code 2.1.257 on this computer");
    expect(catalogSourceLine(claude, "hetzner")).toBe("Claude Code 2.1.257 on hetzner");
  });

  it("neither foot says machine, the word the app never uses to a person", () => {
    const kinds: HarnessCatalog[] = [
      { ...TABLE, source: "harness", version: "2.1.257" },
      { ...TABLE, source: "harness", version: null },
      { ...TABLE, refusal: codexNotSignedInLine("codex login") },
      { ...TABLE, models: [] },
      TABLE,
    ];
    for (const where of [THIS_COMPUTER, "hetzner"]) {
      for (const catalog of kinds) {
        for (const line of [catalogSourceLine(catalog, where)]) expect(line).not.toMatch(/machine/i);
      }
    }
  });
});

describe("one home for the words under the composer's model lists", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // A footer assembled anywhere else took its binary word from whichever agent's catalog it was written against,
  // and a second copy of the sentences about whose sign-in pays would be the one a screen was left reading.
  const RULE = /\} table`|reported no models|no model in the|costs this wsp nothing|list prices, not a bill/;

  it("no other source file spells the footer's words", () => {
    expect(sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")))).toEqual([]);
  });
});

describe("fmtDuration, fmtElapsed and fmtCost", () => {
  it("fmtDuration's short style reads ms under a second, tenths under ten, whole seconds under a minute, then minutes and seconds", () => {
    expect([0, 7, 999, 1500, 9960, 10458, 59_400, 59_600, 60_000, 101_515, 492_000, 862_399, 3_665_000, -5, NaN, 4000].map(ms => fmtDuration(ms))).toEqual([
      "1ms", "7ms", "999ms", "1.5s", "10s", "10s", "59s", "60s", "1m", "1m 42s", "8m 12s", "14m 22s", "61m 5s", "0ms", "0ms", "4.0s",
    ]);
  });

  it("fmtDuration's clock style reads minutes and two-digit seconds, hours ahead once there are any, and nothing sensible as zero", () => {
    expect([0, 999, 61_000, 900_000, 3_599_499, 3_600_000, 6 * 3_600_000 + 65_000, -5, NaN].map(ms => fmtDuration(ms, "clock"))).toEqual([
      "0m 00s", "0m 01s", "1m 01s", "15m 00s", "59m 59s", "1h 00m 00s", "6h 01m 05s", "0m 00s", "0m 00s",
    ]);
  });

  it("fmtUptime reads minutes under an hour, hours and minutes under a day, then days and hours, and nothing sensible as zero", () => {
    expect([0, 59_000, 60_000, 12 * 60_000, 3_600_000, 4 * 3_600_000 + 12 * 60_000, 24 * 3_600_000, 3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000, -5, NaN].map(ms => fmtUptime(ms))).toEqual([
      "0m", "0m", "1m", "12m", "1h 0m", "4h 12m", "1d 0h", "3d 4h", "0m", "0m",
    ]);
  });

  it("both styles round the same instant to the same minute and second", () => {
    for (const ms of [60_499, 60_500, 119_999, 3_599_999, 5_400_500]) {
      const short = fmtDuration(ms);
      const clock = fmtDuration(ms, "clock");
      const [, sm, ss] = /^(\d+)m(?: (\d+)s)?$/.exec(short) ?? [];
      const [, ch, cm, cs] = /^(?:(\d+)h )?(\d+)m (\d+)s$/.exec(clock) ?? [];
      expect([Number(sm), Number(ss ?? 0)]).toEqual([Number(ch ?? 0) * 60 + Number(cm), Number(cs)]);
    }
  });

  it("fmtElapsed is a running clock: whole seconds, then minutes and seconds, never tenths that would flicker on a redrawn row", () => {
    expect([0, 999, 1000, 3_400, 9_999, 10_458, 59_600, 60_000, 73_000, 314_200, -5, NaN].map(fmtElapsed)).toEqual(["0s", "0s", "1s", "3s", "9s", "10s", "59s", "1m", "1m 13s", "5m 14s", "0s", "0s"]);
  });

  it("fmtCost reads cents at every size, so two figures in one thread are never in two shapes", () => {
    expect([1.94, 0.22, 0.01, 0.0042, 0].map(fmtCost)).toEqual(["$1.94", "$0.22", "$0.01", "$0.00", "$0.00"]);
  });
});

describe("notifyLine", () => {
  const THREAD = "c452d1e8-7a1b-4f2c-9e3d-000000000001";

  it("names the thread by its first eight characters, then the outcome, duration and cost, then the reply's last non-empty line", () => {
    expect(notifyLine(THREAD, { status: "completed", durationMs: 492_000, costUsd: 1.94, text: "Ran the gate.\n\nAll 12 tests green.\n" })).toBe("thread c452d1e8 finished (completed, 8m 12s, $1.94): All 12 tests green.");
  });

  it("failed and interrupted carry their words; an error stands in for a reply that has none, and facts the harness did not report are left out", () => {
    expect(notifyLine(THREAD, { status: "failed", durationMs: 3_000, error: "the harness died" })).toBe("thread c452d1e8 finished (failed, 3.0s): the harness died");
    expect(notifyLine(THREAD, { status: "interrupted", durationMs: 12_000, costUsd: 0.03, text: "Stopped mid-way." })).toBe("thread c452d1e8 finished (interrupted, 12s, $0.03): Stopped mid-way.");
    expect(notifyLine(THREAD, { status: "failed", error: "machine paused while the agent was working" })).toBe("thread c452d1e8 finished (failed): machine paused while the agent was working");
    expect(notifyLine(THREAD, { status: "interrupted" })).toBe("thread c452d1e8 finished (interrupted)");
  });

  it("a turn that did not complete says why over its reply's last line; one that did says its last line", () => {
    expect(notifyLine(THREAD, { status: "failed", durationMs: 12_000, costUsd: 0.02, text: "Waiting for the gate to finish.", error: "ended with 1 background task running" })).toBe("thread c452d1e8 finished (failed, 12s, $0.02): ended with 1 background task running");
    expect(notifyLine(THREAD, { status: "completed", durationMs: 12_000, text: "All green.", error: "[ede_diagnostic] noise" })).toBe("thread c452d1e8 finished (completed, 12s): All green.");
  });

  it("notifyTail is the line's tail alone, the one rule the wait's reply field reads", () => {
    expect(notifyTail({ status: "completed", text: "Ran the gate.\n\nAll 12 tests   green.\n" })).toBe("All 12 tests green.");
    expect(notifyTail({ status: "failed", text: "Waiting for the gate.", error: "ended with 1 background task running" })).toBe("ended with 1 background task running");
    expect(notifyTail({ status: "completed", text: "All green.", error: "[ede_diagnostic] noise" })).toBe("All green.");
    expect(notifyTail({ status: "interrupted" })).toBeUndefined();
  });

  it("the whole length carries the final message entire, line breaks and all, under the same facts and the same rule about the error", () => {
    expect(notifyLine(THREAD, { status: "completed", durationMs: 492_000, costUsd: 1.94, text: "Ran the gate.\n\nAll 12 tests green.\n" }, "whole")).toBe(
      "thread c452d1e8 finished (completed, 8m 12s, $1.94): Ran the gate.\n\nAll 12 tests green.",
    );
    // A turn that did not complete still says why first, and a reply with nothing in it still leaves the line bare.
    expect(notifyLine(THREAD, { status: "failed", durationMs: 12_000, text: "Waiting for the gate.\nStill waiting.", error: "ended with 1 background task running" }, "whole")).toBe(
      "thread c452d1e8 finished (failed, 12s): ended with 1 background task running",
    );
    expect(notifyLine(THREAD, { status: "completed", text: "   \n\n  " }, "whole")).toBe("thread c452d1e8 finished (completed)");
    // Tail is the length a line takes when none is named, so every reader that had one keeps it.
    expect(notifyLine(THREAD, { status: "completed", text: "one\ntwo" })).toBe(notifyLine(THREAD, { status: "completed", text: "one\ntwo" }, "tail"));
  });

  it("notifyBody is the one rule both lengths read: the tail is the whole cut to its last line", () => {
    const result = { status: "completed", text: "Ran the gate.\n\nAll 12 tests   green.\n" } as const;
    expect(notifyBody(result, "whole")).toBe("Ran the gate.\n\nAll 12 tests   green.");
    expect(notifyBody(result, "tail")).toBe("All 12 tests green.");
    expect(notifyBody(result)).toBe(notifyTail(result));
  });
});

describe("waitTimedOutLine", () => {
  const THREAD = "c452d1e8-7a1b-4f2c-9e3d-000000000001";

  it("names one thread by its first eight characters and counts more, then says how long was waited", () => {
    expect(waitTimedOutLine([THREAD], 600_000)).toBe("thread c452d1e8 still running after 10m");
    expect(waitTimedOutLine([THREAD, "5e6f7a8b-0000"], 30_000)).toBe("2 threads still running after 30s");
    expect(waitTimedOutLine([THREAD], 50)).toBe("thread c452d1e8 still running after 50ms");
  });
});

describe("a turn's activity in one line each", () => {
  it("reads a shell call behind a prompt, its first line only, whatever the harness calls the tool", () => {
    expect(toolActivityLine("Bash", JSON.stringify({ command: "git status" }))).toBe("$ git status");
    expect(toolActivityLine("Bash", JSON.stringify({ command: "  git   log \n  | head -3" }))).toBe("$ git log");
    expect(toolActivityLine("command_execution", JSON.stringify({ command: "pnpm test" }))).toBe("$ pnpm test");
  });

  it("reads a file behind the verb that touched it, and a search behind what it looked for", () => {
    expect(toolActivityLine("Read", JSON.stringify({ file_path: "packages/engine/src/golden-mcp.ts" }))).toBe("reading packages/engine/src/golden-mcp.ts");
    expect(toolActivityLine("Write", JSON.stringify({ file_path: "src/a.ts" }))).toBe("writing src/a.ts");
    expect(toolActivityLine("Edit", JSON.stringify({ file_path: "src/a.ts" }))).toBe("editing src/a.ts");
    expect(toolActivityLine("NotebookEdit", JSON.stringify({ notebook_path: "run.ipynb" }))).toBe("editing run.ipynb");
    expect(toolActivityLine("Grep", JSON.stringify({ pattern: "shellQuote" }))).toBe("searching code for shellQuote");
    expect(toolActivityLine("WebSearch", JSON.stringify({ query: "solari snapshot" }))).toBe("searching the web for solari snapshot");
    expect(toolActivityLine("WebFetch", JSON.stringify({ url: "https://example.com" }))).toBe("fetching https://example.com");
    expect(toolActivityLine("Task", JSON.stringify({ description: "review the diff" }))).toBe("agent: review the diff");
  });

  it("counts the paths of a change call that carries several, and names the one it carries alone", () => {
    const one = [{ kind: "edit", path: "src/a.ts" }];
    expect(toolActivityLine("file_change", JSON.stringify({ changes: one }))).toBe("editing src/a.ts");
    expect(toolDoneLine("file_change", JSON.stringify({ changes: one }))).toBe("edited src/a.ts");
    expect(toolActivityLine("file_change", JSON.stringify({ changes: [...one, { kind: "add", path: "src/b.ts" }] }))).toBe(`editing ${plural(2, "file")}`);
  });

  it("says what a call is doing while it runs and what it did once its result landed, never the past before the fact", () => {
    const write = JSON.stringify({ file_path: "kai.txt" });
    expect(toolActivityLine("Write", write)).toBe("writing kai.txt");
    expect(toolDoneLine("Write", write)).toBe("wrote kai.txt");
    expect(toolActivityLine("Read", JSON.stringify({ file_path: "src/a.ts" }))).toBe("reading src/a.ts");
    expect(toolDoneLine("Read", JSON.stringify({ file_path: "src/a.ts" }))).toBe("read src/a.ts");
    expect(toolActivityLine("Edit", JSON.stringify({ file_path: "src/a.ts" }))).toBe("editing src/a.ts");
    expect(toolDoneLine("Edit", JSON.stringify({ file_path: "src/a.ts" }))).toBe("edited src/a.ts");
    expect(toolActivityLine("Grep", JSON.stringify({ pattern: "shellQuote" }))).toBe("searching code for shellQuote");
    expect(toolDoneLine("Grep", JSON.stringify({ pattern: "shellQuote" }))).toBe("searched code for shellQuote");
  });

  it("a call whose row reads the same either way has no line of its own for its result, and its answer stands", () => {
    expect(toolDoneLine("Bash", JSON.stringify({ command: "git status" }))).toBeUndefined();
    expect(toolDoneLine("Task", JSON.stringify({ description: "review the diff" }))).toBeUndefined();
    expect(toolDoneLine("TodoWrite", JSON.stringify({ todos: [] }))).toBeUndefined();
    expect(toolDoneLine("Write", "{\"file_pa")).toBeUndefined();
  });

  it("falls back to the tool's own name when there is no row for it, when its input carries nothing the row needs, and when the input is not an object", () => {
    expect(toolActivityLine("TodoWrite", JSON.stringify({ todos: [] }))).toBe("TodoWrite");
    expect(toolActivityLine("mcp__wsp__send", JSON.stringify({ id: "t1" }))).toBe("mcp__wsp__send");
    expect(toolActivityLine("Bash", JSON.stringify({ description: "list them" }))).toBe("Bash");
    expect(toolActivityLine("Bash", "{\"comm")).toBe("Bash");
    expect(toolActivityLine("Bash", JSON.stringify(null))).toBe("Bash");
    expect(toolActivityLine(undefined, JSON.stringify({ command: "ls" }))).toBe("tool");
  });

  it("ends a turn on the same words the app's footer shows, in the app's order, and leaves out what the harness did not report", () => {
    expect(turnSettledLine({ status: "completed", durationMs: 72_000, costUsd: 0.22 })).toBe("completed  Worked for 1m 12s  $0.22");
    expect(turnSettledLine({ status: "failed" })).toBe("failed");
    expect(turnSettledLine({ status: "interrupted", durationMs: 1_500 })).toBe("interrupted  Worked for 1.5s");
    expect(turnSettledParts({ durationMs: null, costUsd: null })).toEqual([]);
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 0.22 })).toEqual(["Worked for 1m 12s", "$0.22"]);
  });

  it("counts work in Worked for: the minutes a turn stood on a question come off it, and are said where they are most of it", () => {
    // The harness reports wall time from launch to result, prompts included; the person's minutes are not the turn's.
    expect(turnSettledParts({ durationMs: 215_000, waitedMs: 211_000, costUsd: 0.05 })).toEqual(["Worked for 4.0s", "waited on you 3m 31s", "$0.05"]);
    // A wait that is not most of the turn is taken off all the same; the turn has nothing to explain.
    expect(turnSettledParts({ durationMs: 72_000, waitedMs: 12_000 })).toEqual(["Worked for 1m"]);
    // A turn nothing of it waited on reads exactly as it did before.
    expect(turnSettledParts({ durationMs: 72_000, waitedMs: null })).toEqual(["Worked for 1m 12s"]);
    // A harness whose figure is shorter than the wait the runtime clocked cannot make a turn work negative time.
    expect(turnSettledParts({ durationMs: 1_000, waitedMs: 60_000 })).toEqual(["Worked for 1ms", "waited on you 1.0s"]);
    expect(waitedOnYouPart(211_000)).toBe("waited on you 3m 31s");
    // The line a thread's end sends counts the same minutes the footer does; two readings of one turn cannot differ.
    expect(notifyLine("thr_abcd1234", { status: "completed", durationMs: 215_000, waitedMs: 211_000, costUsd: 0.05, text: "done" })).toBe("thread thr_abcd finished (completed, 4.0s, $0.05): done");
  });

  it("says what the threads a thread opened spent beside its own figure, and says what each figure counts, so neither reads as the other", () => {
    expect(openedSpendPart(2.3)).toBe("$2.30 in threads it opened");
    expect(turnSpendPart(1.14)).toBe("$1.14 this turn");
    // One turn against whole threads: with both on the line each says its own scope.
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 1.14 }, 2.3)).toEqual(["Worked for 1m 12s", "$1.14 this turn", "$2.30 in threads it opened"]);
    // Nothing opened anything, so there is no second figure to weigh the first against and the cost stands bare.
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 1.14 })).toEqual(["Worked for 1m 12s", "$1.14"]);
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 1.14 }, 0)).toEqual(["Worked for 1m 12s", "$1.14"]);
  });

  it("a surface whose turns cost the person nothing puts the word on the turn's own figure and on no other", () => {
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 0.13 }, null, LIST_PRICE_WORD)).toEqual(["Worked for 1m 12s", "$0.13 list price"]);
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 1.14 }, 2.3, LIST_PRICE_WORD)).toEqual(["Worked for 1m 12s", "$1.14 list price this turn", "$2.30 in threads it opened"]);
    // The line a stream with no footer prints never carries a second figure, so it is untouched.
    expect(turnSettledLine({ status: "completed", durationMs: 72_000, costUsd: 1.14 })).toBe("completed  Worked for 1m 12s  $1.14");
  });
});

describe("what a tool call answered, in one line", () => {
  it("is the result's first line, cut by the rule that cuts the call's own line", () => {
    expect(toolResultLine("On branch main\nnothing to commit")).toBe("On branch main");
    expect(toolResultLine("  total   0 \nfoo")).toBe("total 0");
  });

  it("marks a failed result in words, with what the harness said when it said anything", () => {
    expect(toolResultLine("exit 1: no such file", true)).toBe("failed: exit 1: no such file");
    expect(toolResultLine("", true)).toBe("failed");
    expect(toolResultLine("\n  \n", true)).toBe("failed");
  });

  it("has nothing to say for a result that answered with nothing", () => {
    expect(toolResultLine("")).toBeUndefined();
    expect(toolResultLine("\n  \n")).toBeUndefined();
  });
});

describe("the one registry every client reads a tool call from", () => {
  it("says which field a call's row shows, what kind of item it is and what it changed, Claude's names and Codex's alike", () => {
    expect(toolCallFacts("Bash", JSON.stringify({ command: "git status", description: "Show working tree status" })))
      .toEqual({ itemType: "command_execution", requestKind: "command", detail: "Show working tree status", command: "git status", description: "Show working tree status" });
    expect(toolCallFacts("command_execution", JSON.stringify({ command: "pnpm test" })))
      .toEqual({ itemType: "command_execution", requestKind: "command", command: "pnpm test" });
    expect(toolCallFacts("Read", JSON.stringify({ file_path: "/x/a.ts" }))).toEqual({ requestKind: "file-read", detail: "/x/a.ts" });
    expect(toolCallFacts("Edit", JSON.stringify({ file_path: "/x/a.ts", old_string: "a" })))
      .toEqual({ itemType: "file_change", requestKind: "file-change", detail: "/x/a.ts", changedFiles: ["/x/a.ts"] });
    expect(toolCallFacts("NotebookEdit", JSON.stringify({ notebook_path: "run.ipynb" })))
      .toEqual({ itemType: "file_change", requestKind: "file-change", detail: "run.ipynb", changedFiles: ["run.ipynb"] });
    expect(toolCallFacts("file_change", JSON.stringify({ changes: [{ kind: "edit", path: "src/a.ts" }, { kind: "add", path: "src/b.ts" }] })))
      .toEqual({ itemType: "file_change", requestKind: "file-change", changedFiles: ["src/a.ts", "src/b.ts"] });
    expect(toolCallFacts("Grep", JSON.stringify({ pattern: "shellQuote", path: "src" }))).toEqual({ detail: "shellQuote" });
    expect(toolCallFacts("web_search", JSON.stringify({ query: "solari snapshot" }))).toEqual({ itemType: "web_search", detail: "solari snapshot" });
    expect(toolCallFacts("Task", JSON.stringify({ description: "scan repo", prompt: "find every caller" }))).toEqual({ itemType: "collab_agent_tool_call", detail: "scan repo" });
  });

  it("reads a name with no row by the general field order, and an mcp call by its name", () => {
    expect(toolCallFacts("TodoWrite", JSON.stringify({ todos: [] }))).toEqual({});
    expect(toolCallFacts("mcp__wsp__send", JSON.stringify({ prompt: "hello" }))).toEqual({ itemType: "mcp_tool_call", detail: "hello" });
    expect(toolCallFacts("Wombat", JSON.stringify({ query: "grey fur" }))).toEqual({ detail: "grey fur" });
  });

  it("shows input still arriving as it stands, and reads an empty input as a call with nothing said about it yet", () => {
    expect(toolCallFacts("Bash", "{\"comm")).toEqual({ itemType: "command_execution", requestKind: "command", detail: "{\"comm" });
    expect(toolCallFacts("Bash", "")).toEqual({ itemType: "command_execution", requestKind: "command" });
    expect(toolCallFacts("Bash", JSON.stringify(null))).toEqual({ itemType: "command_execution", requestKind: "command", detail: "null" });
  });

  it("names the calls that looked through the code, for the client that folds them into one row", () => {
    expect(["Grep", "Glob"].map(name => isCodeSearchTool(name))).toEqual([true, true]);
    expect(["Bash", "Read", "WebSearch", undefined].map(name => isCodeSearchTool(name))).toEqual([false, false, false, false]);
  });
});

describe("plural, fmtThreads and forgetNotice", () => {
  it("is the one rule for a count and its noun, and fmtThreads reads it", () => {
    expect([0, 1, 2].map(n => plural(n, "row"))).toEqual(["0 rows", "1 row", "2 rows"]);
    expect(plural(1, "tool call")).toBe("1 tool call");
    expect([1, 2].map(fmtThreads)).toEqual([plural(1, "thread"), plural(2, "thread")]);
  });

  it("counts anything with its noun, plural by an s", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "secret-shaped file")).toBe("2 secret-shaped files");
  });

  it("counts threads with the noun, and names what a forget takes off this computer", () => {
    expect([0, 1, 2].map(fmtThreads)).toEqual(["0 threads", "1 thread", "2 threads"]);
    expect(forgetNotice(1)).toBe("Its record and 1 thread leave this computer; the computer it ran on is already gone.");
  });
});

describe("listedName and nameList", () => {
  it("leaves a name that carries no comma alone and joins a list with the separator", () => {
    expect(listedName("ripgrep")).toBe("ripgrep");
    expect(nameList(["ripgrep", "just", "GitHub CLI"])).toBe("ripgrep, just, GitHub CLI");
    expect(nameList([])).toBe("");
  });

  it("quotes a name that carries the separator, so a free-text label reads as one entry and not as two", () => {
    expect(listedName("swift-format, swiftlint")).toBe('"swift-format, swiftlint"');
    expect(nameList(["swift-format, swiftlint", "just"])).toBe('"swift-format, swiftlint", just');
    // A plain join leaves the label's own comma reading as a third entry; that is what the quotes take away.
    expect(["swift-format, swiftlint", "just"].join(", ").split(", ")).toHaveLength(3);
  });

  it("escapes a quote the name itself carries, so the quoting cannot be read as the end of the name", () => {
    expect(listedName('the "fast", grep')).toBe('"the \\"fast\\", grep"');
  });
});

describe("titleLine", () => {
  it("is the prompt's first non-empty line with its whitespace collapsed, so a multi-paragraph brief is one line everywhere", () => {
    expect(titleLine("You are a builder for the wsp repo.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix.")).toBe("You are a builder for the wsp repo.");
    expect(titleLine("\r\n  \n\tReply  with\texactly   the word pong.  \r\n")).toBe("Reply with exactly the word pong.");
    expect(titleLine("one line")).toBe("one line");
    expect(titleLine("\n \n")).toBe("");
  });
});

describe("openingTitle", () => {
  const brief = "You are a builder for the wsp repo, which is at /Users/dev/wsp on this Mac: read the ticket, then run `pnpm test` and report.\n\nTicket: Zingzy/wsp-map#408.";

  it("is the opening turn's first sentence, so a brief that starts with a whole paragraph never titles a thread with all of it", () => {
    expect(openingTitle("Bump the lockfile. Then run the gate.")).toBe("Bump the lockfile.");
    expect(openingTitle("Is the gate green? Say so.")).toBe("Is the gate green?");
    expect(openingTitle("You are a builder for the wsp repo.\n\nTicket: Zingzy/wsp-map#292.")).toBe("You are a builder for the wsp repo.");
    expect(openingTitle("\r\n  \n\tReply  with\texactly   the word pong.  \r\n")).toBe("Reply with exactly the word pong.");
    expect(openingTitle("Bump to 1.2.3 and run the gate")).toBe("Bump to 1.2.3 and run the gate");
  });

  it("cuts a long first sentence at a word boundary to at most 48 characters with the ellipsis counted, and only then", () => {
    expect(openingTitle(brief)).toBe("You are a builder for the wsp repo, which is at…");
    expect(openingTitle(brief).length).toBeLessThanOrEqual(48);
    const exact = "Rename the thread by its opening words and stop.";
    expect(exact).toHaveLength(48);
    expect(openingTitle(exact)).toBe(exact);
    expect(openingTitle(`${exact.slice(0, -1)} now.`)).toBe("Rename the thread by its opening words and stop…");
    expect(openingTitle("Ticket: wsp-map#408, four fixes in one round, the header glyph first.")).toBe("Ticket: wsp-map#408, four fixes in one round…");
  });

  it("cuts one word longer than the room inside it, and an empty turn is an empty title", () => {
    const token = "a".repeat(60);
    expect(openingTitle(token)).toBe(`${"a".repeat(47)}…`);
    expect(openingTitle("\n \n")).toBe("");
  });
});

describe("cutLine", () => {
  it("leaves a line inside the room whole and cuts a longer one at a word boundary, the ellipsis counted inside the room", () => {
    expect(cutLine("no answer 2 h, threads go on", 30)).toBe("no answer 2 h, threads go on");
    expect(cutLine("putting the helper back on this machine", 30)).toBe("putting the helper back on…");
    expect(cutLine("putting the helper back on this machine", 30).length).toBeLessThanOrEqual(30);
    // One word longer than the room is cut inside itself rather than dropped.
    expect(cutLine("a".repeat(40), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("takes the separator the cut broke on off the edge", () => {
    expect(cutLine("$0.00 today, edge slow, naps in 14m", 24)).toBe("$0.00 today, edge slow…");
    expect(cutLine("one, two, three, four, five, six", 20)).toBe("one, two, three…");
    // A thread title cut on a comma reads the same rule, since both lines read this one cut.
    expect(openingTitle("Ship the sidebar row and the composer line, then the word cut")).toBe("Ship the sidebar row and the composer line…");
  });
});

describe("IDLE_REASON", () => {
  it("writes the nap's reason and reads its window back, and reads nothing out of a reason of any other shape", () => {
    expect(IDLE_REASON.of(20 * 60_000)).toBe("idle 20 min");
    expect(IDLE_REASON.windowIn(IDLE_REASON.of(20 * 60_000))).toBe("20 min");
    expect(IDLE_REASON.windowIn(IDLE_REASON.of(30 * 60_000))).toBe("30 min");
    expect(IDLE_REASON.windowIn(undefined)).toBeUndefined();
    expect(IDLE_REASON.windowIn("machine replaced")).toBeUndefined();
    expect(IDLE_REASON.windowIn("idle")).toBeUndefined();
  });
});

describe("titlePrompt", () => {
  it("asks for a short title in words from the opening turn alone, cut so a brief never rides whole", () => {
    const prompt = titlePrompt("a".repeat(900));
    expect(prompt).toContain("3 to 6 words");
    expect(prompt).toContain("The opening turn:");
    expect(prompt).not.toContain("The reply:");
    expect(prompt).toContain(`${"a".repeat(600)}…`);
    expect(prompt).not.toContain("a".repeat(601));
  });

  it("carries the reply too when the caller has one, cut the same way", () => {
    const prompt = titlePrompt("a".repeat(900), "b".repeat(900));
    expect(prompt).toContain("The reply:");
    expect(prompt).toContain(`${"b".repeat(600)}…`);
    expect(prompt).not.toContain("b".repeat(601));
  });
});

describe("generatedTitle", () => {
  it("takes a one-line answer, with the quotes and the stop a model wraps it in taken off", () => {
    expect(generatedTitle("  Seed thread titles from opening turn\n")).toBe("Seed thread titles from opening turn");
    expect(generatedTitle('"Thread titles through the harness"')).toBe("Thread titles through the harness");
    expect(generatedTitle("\u201cThread titles through the harness\u201d")).toBe("Thread titles through the harness");
    expect(generatedTitle("Thread titles through the harness.")).toBe("Thread titles through the harness");
  });

  it("cuts an over-long one-line answer to its first words under the cap rather than refusing it", () => {
    // 45 characters, the longest a claude-sonnet-5 answer ran when asked for 34 (measured over 80 threads).
    const long = "Wire the sidebar rows to the daemon's streams";
    expect(long).toHaveLength(45);
    expect(generatedTitle(long)).toBe("Wire the sidebar rows to the daemon's");
    expect(generatedTitle(long)!.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    // A word that ends exactly at the cap is kept whole, and a comma left at the cut comes off with it.
    expect(generatedTitle(`${"a".repeat(GENERATED_TITLE_MAX)} tail`)).toBe("a".repeat(GENERATED_TITLE_MAX));
    expect(generatedTitle(`${"a".repeat(GENERATED_TITLE_MAX - 2)}, and then some`)).toBe("a".repeat(GENERATED_TITLE_MAX - 2));
    expect(generatedTitle("a".repeat(GENERATED_TITLE_MAX))).toBe("a".repeat(GENERATED_TITLE_MAX));
  });

  it("refuses an answer that is not a title, so the thread keeps the words its opening turn seeded it with", () => {
    expect(generatedTitle("Sure! Here is a title:\nThread titles through the harness")).toBeNull();
    expect(generatedTitle("Thread titles\nthrough the harness")).toBeNull();
    // One word longer than the cap has no boundary to cut at, and its head would be no title.
    expect(generatedTitle("a".repeat(GENERATED_TITLE_MAX + 1))).toBeNull();
    expect(generatedTitle("   ")).toBeNull();
    expect(generatedTitle('"."')).toBeNull();
  });
});

describe("storedTitleSource", () => {
  it("reads a store title that is the opening words, or their head, as the seed, and any other as a person's", () => {
    const opening = "make a server, and its tests\nwith a health route";
    expect(storedTitleSource("make a server, and its tests", opening)).toBe("seed");
    expect(storedTitleSource("make a server", opening)).toBe("seed");
    expect(storedTitleSource("  make   a server,  ", opening)).toBe("seed");
    expect(storedTitleSource("Building the server", opening)).toBe("person");
    expect(storedTitleSource("make a server, and its tests, please", opening)).toBe("person");
    expect(storedTitleSource("make a server", undefined)).toBe("person");
  });
});

describe("lastLine", () => {
  it("is the text's last non-empty line with its whitespace collapsed, which is what a notify line ends with", () => {
    expect(lastLine("Ran the gate.\n\nAll 12 tests green.\n")).toBe("All 12 tests green.");
    expect(lastLine("  Server  is\tlive at :3000.  \r\n\n")).toBe("Server is live at :3000.");
    expect(lastLine("one line")).toBe("one line");
    expect(lastLine("\n \n")).toBeUndefined();
    expect(lastLine("")).toBeUndefined();
  });
});

describe("turnCutLine", () => {
  it("names the rule, how long the turn ran in the clock style and the limit, in the words the ticket row shows", () => {
    expect(turnCutLine("idle", 900_000, TURN_IDLE_MS)).toBe("stopped after 15m 00s with no output for 10m");
    expect(turnCutLine("wall", TURN_WALL_MS, TURN_WALL_MS)).toBe("stopped after 6h 00m 00s at the 6h cap on one turn");
  });
});

describe("timedOutLine and stepRetryLine", () => {
  it("names the seconds, says when it happened twice, and says in words that the step is tried once more", () => {
    expect(timedOutLine(300)).toBe("timed out after 300s");
    expect(timedOutLine(300, 2)).toBe("timed out after 300s, twice");
    expect(stepRetryLine(300)).toBe("timed out after 300s; trying once more");
  });
});

describe("refusedTurn", () => {
  it("a refused turn reads failed and carries the agent's sentence with wsp's half, the cause it is classed by, and no reply of its own", () => {
    const road = signInRefusalLine({ kind: "local" });
    const refused = refusedTurn({ status: "completed", durationMs: 88, costUsd: 0, text: "Not logged in · Please run /login" }, { road, cause: "sign-in" });
    expect(refused).toEqual({
      status: "failed",
      durationMs: 88,
      costUsd: 0,
      error: "Not logged in · Please run /login; sign in from a terminal on this computer, then send again",
      refusal: "sign-in",
    });
    expect(turnEndLine(refused)).toBe(`failed  Worked for 88ms  $0.00: ${refused.error!}`);
    expect(notifyTail(refused)).toBe(refused.error);
  });

  it("a refusal wsp knows no road out of keeps the agent's sentence alone and is classed by nothing; one with neither sentence nor road says only failed", () => {
    expect(refusedTurn({ status: "completed", text: "  Overloaded  ", usage: { input_tokens: 0 } }, { road: "" })).toEqual({ status: "failed", usage: { input_tokens: 0 }, error: "Overloaded" });
    expect(refusedTurn({ status: "completed", error: "the provider refused" })).toEqual({ status: "failed", error: "the provider refused" });
    expect(refusedTurn({ status: "completed" })).toEqual({ status: "failed" });
  });

  it("a result carrying both a reply and a harness error entry says the reply, once: the entry is the harness's telemetry beside the same sentence", () => {
    expect(refusedTurn({ status: "completed", text: "Not logged in", error: "Not logged in" })).toEqual({ status: "failed", error: "Not logged in" });
  });
});

describe("a refusal the host's own validator wrote", () => {
  const issues = (rows: unknown[]): string => JSON.stringify(rows, null, 2);

  it("reads an op the host does not know as the two builds differing, and never prints the ops it listed", () => {
    const refusal = issues([{ code: "invalid_union_discriminator", options: ["auth", "status.list", "workspaces.exec"], path: ["op"], message: "Invalid discriminator value. Expected 'auth' | 'status.list' | 'workspaces.exec'" }]);
    const line = validatorRefusal(refusal);
    expect(line).toBe("the host does not serve this line; it runs another version of wsp, restart it with wsp up");
    expect(line).not.toContain("workspaces.exec");
    expect(line).not.toContain("discriminator");
  });

  it("names the argument the host refused, in the words the line was typed in", () => {
    expect(validatorRefusal(issues([{ code: "invalid_type", expected: "string", received: "number", path: ["cwd"], message: "Expected string, received number" }]))).toBe("the host would not read --cwd on this line");
    expect(validatorRefusal(issues([{ code: "invalid_type", path: ["workspaceId"], message: "Required" }, { code: "invalid_type", path: ["argv", 0], message: "Required" }]))).toBe("the host would not read the workspace and the command on this line");
  });

  it("says the line alone where the field it named is one no line carries", () => {
    expect(validatorRefusal(issues([{ code: "invalid_type", path: ["turnToken"], message: "Required" }]))).toBe("the host would not read this line");
  });

  it("leaves every refusal wsp writes itself alone", () => {
    expect(validatorRefusal("no workspace nope")).toBeUndefined();
    expect(validatorRefusal("[]")).toBeUndefined();
    expect(validatorRefusal(JSON.stringify([{ message: "Required" }]))).toBeUndefined();
    expect(validatorRefusal(JSON.stringify({ code: "invalid_type", path: ["cwd"] }))).toBeUndefined();
  });
});

describe("harnessExitLine", () => {
  it("exit 127 names the binary the shell could not find and the PATH it searched, never the bare code alone", () => {
    const path = "/root/.local/bin:/usr/bin:/bin";
    expect(harnessExitLine("claude", 127, path)).toBe("claude was not found on PATH (exit 127); PATH searched: /root/.local/bin:/usr/bin:/bin");
    expect(harnessExitLine("codex", 127, path)).toBe("codex was not found on PATH (exit 127); PATH searched: /root/.local/bin:/usr/bin:/bin");
  });

  it("exit 127 with no PATH exported says the machine's own was searched", () => {
    expect(harnessExitLine("claude", 127, undefined)).toBe("claude was not found on PATH (exit 127); the launch exported no PATH, the machine's own was searched");
  });

  it("any other exit reads as the code", () => {
    expect(harnessExitLine("claude", 1, "/usr/bin")).toBe("claude exited with code 1 before emitting a result");
  });

  it("a run that ended on a signal says the agent was killed, and names the signal where the host saw one", () => {
    expect(harnessExitLine("claude", null, "/usr/bin", { reached: true, signal: "SIGKILL" })).toBe("claude was killed (SIGKILL) before it answered");
    expect(harnessExitLine("claude", -1, "/usr/bin", { reached: true, signal: "SIGTERM" })).toBe("claude was killed (SIGTERM) before it answered");
    expect(harnessExitLine("claude", null, "/usr/bin", { reached: true })).toBe("claude was killed before it answered");
  });

  it("a launch that never reached the agent says that instead of naming a code", () => {
    expect(harnessExitLine("claude", null, "/usr/bin", { reached: false })).toBe("the launch never reached claude: its run ended before the agent said a word");
    expect(harnessExitLine("claude", 127, "/usr/bin", { reached: false })).toBe("claude was not found on PATH (exit 127); PATH searched: /usr/bin");
  });
});

describe("loginPathLine", () => {
  it("names why the login shell gave no PATH and says the one the launch handed the host stands", () => {
    expect(loginPathLine("/bin/zsh printed nothing")).toBe("login shell: no PATH read (/bin/zsh printed nothing); this host keeps the PATH it was started with");
    expect(loginPathLine("SHELL names no login shell")).toBe("login shell: no PATH read (SHELL names no login shell); this host keeps the PATH it was started with");
  });
});

describe("guestUnusableLine", () => {
  it("names the provider, the machine it left running and what the guest said when nothing on it would run", () => {
    expect(guestUnusableLine("Box by ASCII", "bx_tumrjngm", "bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file: Error 24"))
      .toBe("Box by ASCII left bx_tumrjngm running but nothing on it can run: bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file: Error 24");
  });
});

describe("machineUnreachableLine", () => {
  it("quotes the provider's words and names the two roads open on a running machine, with no machine id", () => {
    expect(machineUnreachableLine("Sandbox is not reachable")).toBe("the provider cannot reach the machine (Sandbox is not reachable); pause and wake the workspace, or delete it");
  });
});

describe("execFailedLine", () => {
  it("quotes the provider's words, says the threads may still be running and puts waiting first, with no machine id", () => {
    expect(execFailedLine("exec failed")).toBe("the provider cannot run commands on the machine (exec failed) while the machine and its threads may still be running; wait, or pause and wake the workspace, or delete it");
  });
});

describe("napRefusedLine", () => {
  it("quotes the provider's words, says why it will not pause and names the road left", () => {
    expect(napRefusedLine("Not pausable")).toBe("the provider does not pause this machine (Not pausable): its memory and disk together are over what it pauses; it runs until you delete it");
  });
});

describe("machineUnreachedLine", () => {
  it("says the machine could not be reached from this computer, with the attempts counted and the time they took", () => {
    expect(machineUnreachedLine(6, 23_400)).toBe("the machine could not be reached from this computer after 6 attempts over 23s");
    expect(machineUnreachedLine(1, 800)).toBe("the machine could not be reached from this computer after 1 attempt over 800ms");
  });
});

describe("machine size words", () => {
  const offers = [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
  ];

  it("fmtSize is the one line for a size in the app: the cpus in the kind's word, a dot, the GB", () => {
    expect([{ cpu: 2, memMb: 4096 }, { cpu: 4, memMb: 1536 }].map(size => fmtSize(size))).toEqual(["2 vCPU, 4 GB", "4 vCPU, 1.5 GB"]);
    // A provider's cpus are virtual and this computer's are not: the same line, the kind's own word for them.
    expect(fmtSize({ cpu: 10, memMb: 16384 }, kindWords("local").cpu)).toBe("10 cores, 16 GB");
    expect(fmtSize({ cpu: 2, memMb: 4096 }, kindWords("cloud").cpu)).toBe("2 vCPU, 4 GB");
  });

  it("sizeWord spells vCPUs, an x and the GB the size table names, and sizeFromWord reads the same word back", () => {
    expect([{ cpu: 2, memMb: 4096 }, { cpu: 4, memMb: 8192 }, { cpu: 1, memMb: 512 }].map(sizeWord)).toEqual(["2x4", "4x8", "1x0.5"]);
    expect(["2x4", " 4x8 ", "1x0.5"].map(sizeFromWord)).toEqual([{ cpu: 2, memMb: 4096 }, { cpu: 4, memMb: 8192 }, { cpu: 1, memMb: 512 }]);
    for (const s of offers) expect(sizeFromWord(sizeWord(s))).toEqual({ cpu: s.cpu, memMb: s.memMb });
  });

  it("sizeFromWord names nothing for a word that is not a size", () => {
    expect(["big", "2", "x4", "2x", "0x4", "2x0", "2 x 4", "2x4x8", "-2x4"].map(sizeFromWord)).toEqual(Array(9).fill(undefined));
  });

  it("fmtRate reads a rate a provider computed, not only one written down: the price to the places it needs and no more", () => {
    // Solari prices per vCPU-hour plus per GB-hour (solari-backend.ts), so every rate it offers carries float noise:
    // 2x2 lands on 0.09000000000000001. A rule that compares the cent form back to the number reads noise as a
    // third place and prints $0.090/hr on every live size.
    const solari = (cpu: number, memGb: number): number => cpu * 0.035 + memGb * 0.01;
    expect(fmtRate(solari(2, 2))).toBe("$0.09/hr");
    expect(fmtRate(solari(2, 4))).toBe("$0.11/hr");
    expect(fmtRate(solari(4, 8))).toBe("$0.22/hr");
    expect(fmtRate(solari(8, 32))).toBe("$0.60/hr");
    // Box quotes its classes outright (box-backend.ts), and those need the third place to say the price at all.
    expect([0.018, 0.036, 0.072].map(fmtRate)).toEqual(["$0.018/hr", "$0.036/hr", "$0.072/hr"]);
    expect([0.1, 1.234, 2.5].map(fmtRate)).toEqual(["$0.10/hr", "$1.234/hr", "$2.50/hr"]);
  });

  it("offeredSize is the one membership rule, and the refusal names the word as given and every offer with its rate", () => {
    expect(offeredSize(offers, { cpu: 2, memMb: 8192 })).toBe(true);
    expect(offeredSize(offers, { cpu: 4, memMb: 8192 })).toBe(false);
    expect(offeredSize([], { cpu: 2, memMb: 4096 })).toBe(false);
    // The same match answers with the row itself, which is where a picker reads the rate it quotes.
    expect(sizeOffer(offers, { cpu: 2, memMb: 8192 })).toEqual({ cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 });
    expect(sizeOffer(offers, { cpu: 4, memMb: 8192 })).toBeUndefined();
    expect(fmtRate(0.11)).toBe("$0.11/hr");
    expect(sizeRefusal("4x8", offers)).toBe("4x8 is not a size this provider offers; the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr)");
    expect(sizeRefusal("big", offers)).toBe("big is not a size this provider offers; the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr)");
  });
});

describe("machineCapRefusal", () => {
  it("names the machines holding the slots and the move that frees one, without saying how many slots the plan has", () => {
    expect(machineCapRefusal(["first", "t-cap"])).toBe("both machine slots are in use: first, t-cap. Pause one or wait for a nap.");
    // A slot held by a machine this host cannot name is still held, so one holder is no proof of a one-slot plan.
    expect(machineCapRefusal(["first"])).toBe("a machine slot is in use: first. Pause it or wait for a nap.");
    expect(machineCapRefusal(["a", "b", "c"])).toBe("machine slots are in use: a, b, c. Pause one or wait for a nap.");
    expect(machineCapRefusal(["a", "b", "c", "d"])).toBe("machine slots are in use: a, b, c, d. Pause one or wait for a nap.");
  });

  it("names a builder as one, since the pause on offer is a workspace's move", () => {
    expect(machineCapRefusal(["first"], ["wsp-golden"])).toBe("both machine slots are in use: first, wsp-golden (builder). Pause one or wait for a nap.");
  });

  it("says so plainly when nothing of this computer holds a slot, instead of naming an empty list", () => {
    expect(machineCapRefusal([])).toBe("the provider is at its machine cap and no machine of this computer holds a slot; free one at the provider and try again");
  });
});

describe("goneWords", () => {
  it("names the machine alone when nobody saw the provider lose it", () => {
    expect(goneWords("m1")).toBe("machine m1 is gone at the provider");
  });

  it("names the call that found it gone and the second it did, quoting the provider's answer when the call had one", () => {
    const at = Date.parse("2026-09-07T01:21:10.500Z");
    expect(goneWords("sb_1", { by: "pause", at, answer: "404 Not found" })).toBe("machine sb_1 is gone at the provider: the pause found it gone at 2026-09-07T01:21:10Z (404 Not found)");
    expect(goneWords("sb_1", { by: "status poll", at })).toBe("machine sb_1 is gone at the provider: the status poll found it gone at 2026-09-07T01:21:10Z");
    expect(goneWords("sb_1", { by: "sweep", at, answer: "" })).toBe("machine sb_1 is gone at the provider: the sweep found it gone at 2026-09-07T01:21:10Z");
  });

});

describe("NOT_GONE", () => {
  it("says the record follows the state read, whichever state it holds the machine in", () => {
    expect(NOT_GONE).toBe("not gone at the provider after all; the record follows the state read");
  });
});

describe("mcpServerCommandLine", () => {
  it("names the command every agent's config now runs, as one shell line a person can paste", () => {
    expect(mcpServerCommandLine("npx", ["-y", "@zingzy/wsp@0.1.2", "mcp", "--state", "/Users/p/.wsp/state.json"])).toBe("The server command is npx -y @zingzy/wsp@0.1.2 mcp --state /Users/p/.wsp/state.json");
    expect(mcpServerCommandLine("/Users/p/.local/bin/wsp", ["mcp", "--state", "/Users/p/my wsp/state.json"])).toBe("The server command is /Users/p/.local/bin/wsp mcp --state '/Users/p/my wsp/state.json'");
  });
});

describe("nextInsideAgentLine", () => {
  it("names the agent's own command and what to type at its prompt, a slash form as it stands", () => {
    expect(nextInsideAgentLine("claude", "/wsp set up wsp for me")).toBe("Next: run claude in this folder and say: /wsp set up wsp for me");
    expect(nextInsideAgentLine("codex", "set up wsp for me")).toBe("Next: run codex in this folder and say: set up wsp for me");
  });
});

describe("folderRefusalLine", () => {
  it("carries this Mac's own reason after the words that say the level was not read", () => {
    expect(folderRefusalLine("EACCES: permission denied, scandir '/Users/dev/Documents'")).toBe("No folders read. EACCES: permission denied, scandir '/Users/dev/Documents'");
    expect(folderRefusalLine("/etc is outside the folders wsp browses on this computer: /Users/dev")).toBe("No folders read. /etc is outside the folders wsp browses on this computer: /Users/dev");
  });

  it("is one line whatever the host said, so the slot the level line shares keeps its height", () => {
    expect(folderRefusalLine("  EPERM: operation not permitted\n  scandir '/Users/dev/Desktop'  ")).toBe("No folders read. EPERM: operation not permitted scandir '/Users/dev/Desktop'");
  });
});

describe("execFolderLine", () => {
  it("names the folder a failing command ran in, or the home folder when it had none of its own", () => {
    expect(execFolderLine("/root/work/proj")).toBe("ran in /root/work/proj");
    expect(execFolderLine(undefined)).toBe("ran in the home folder");
  });
});

describe("backgroundTasksLine", () => {
  it("counts the tasks the harness still had running when its process was cut", () => {
    expect(backgroundTasksLine(1)).toBe("ended with 1 background task running");
    expect(backgroundTasksLine(2)).toBe("ended with 2 background tasks running");
  });
});

describe("taskFinishedLine", () => {
  it("names the command, how it ended and how long after the reply, in the one duration every door reads", () => {
    expect(taskFinishedLine("pnpm test", "completed", 14 * 60_000)).toBe("`pnpm test` completed, 14m after the reply");
    // Under a minute it is seconds, as a turn's own duration is: a task that ended in twenty seconds says so
    // rather than rounding to nothing.
    expect(taskFinishedLine("Sleep 20 seconds then echo done", "completed", 20_400)).toBe("`Sleep 20 seconds then echo done` completed, 20s after the reply");
    expect(taskFinishedLine("gate", "failed", 90_000)).toBe("`gate` failed, 1m 30s after the reply");
  });

  it("keeps a description the harness wrote with backticks in it whole, since the agent's own words are in it", () => {
    expect(taskFinishedLine("echo `date`", "completed", 1_000)).toBe("`echo `date`` completed, 1.0s after the reply");
  });
});

describe("a provider out of reach from this computer", () => {
  it("names what could not be reached, not the computer", () => {
    expect(PROVIDER_UNREACHED_LINE).toBe("Solari cannot be reached from this computer");
  });

  it("logs one retry per line, naming the call, the road's own code and the try about to go", () => {
    expect(providerRoadRetryLine("GET /sandboxes/x", "ENOTFOUND", 2, 3)).toBe("GET /sandboxes/x did not leave this computer (ENOTFOUND); try 2 of 3");
    expect(providerRoadRetryLine("POST /sandboxes", "EAI_AGAIN", 3, 3)).toBe("POST /sandboxes did not leave this computer (EAI_AGAIN); try 3 of 3");
  });
});

describe("a record the sweep restored, and a name a fork cannot take", () => {
  it("names the machine, the workspace and the verb that removes it", () => {
    expect(RECORD_RESTORED).toBe("record restored from the provider's listing");
    expect(recordRestoredLine("sbx_1", "first", "ws_1")).toBe("reap: recorded sbx_1 as workspace first (ws_1): a machine from this setup that no record claimed; it bills until wsp delete first");
  });

  it("refuses a taken name and a name being deleted in words a person can act on", () => {
    expect(nameTakenRefusal("first")).toBe("first is already a workspace; pick another name, or delete it first");
    expect(nameDeletingRefusal("first")).toBe("first is being deleted; wait for the delete to finish, then fork it again");
  });
});

describe("stillWorkingLine", () => {
  it("names the thread by its title, says the reply is in but the agent is still working, and says where a message sent now goes", () => {
    expect(stillWorkingLine("Fix the port list")).toBe("Fix the port list replied, still working; the message runs as its next turn once that process exits");
    // A caller with no title for the thread names it as the person looking at it would: an id names no thread.
    expect(stillWorkingLine()).toBe("This thread replied, still working; the message runs as its next turn once that process exits");
    expect(stillWorkingLine("  ")).toBe(stillWorkingLine());
    // Nothing in it tells the caller to wait or says the send was refused: the send is never refused.
    expect(stillWorkingLine()).not.toMatch(/wait|refus/);
  });
});

describe("stopFailedLine and sendNowFailedLine", () => {
  it("prefix the runtime's own words for a stop or a send-now that did not go, so the composer's line says which click failed", () => {
    expect(stopFailedLine("the runtime does not know this session")).toBe("Could not stop: the runtime does not know this session");
    expect(sendNowFailedLine("Workspace is pausing; wake it to send")).toBe("Could not send now: Workspace is pausing; wake it to send");
  });

  it("the send key's label while a turn runs is one constant", () => {
    expect(TURN_IN_FLIGHT).toBe("Turn in flight");
  });
});

describe("the shape a refusal takes on a terminal", () => {
  it("is two halves, what happened and then what to do, on one line", () => {
    expect(refusalLine("wsp run takes one task; api reads as a second one.", "Name the workspace with --in api.")).toBe(
      "wsp run takes one task; api reads as a second one. Name the workspace with --in api.",
    );
    expect(refusalLine("a.", "b.").split("\n")).toHaveLength(1);
    // A first half written for the app too, where nothing follows it, closes itself here.
    expect(refusalLine("no agent called codx; the catalog knows claude, codex", "Name one of those.")).toBe(
      "no agent called codx; the catalog knows claude, codex. Name one of those.",
    );
    expect(refusalLine("wsp thread read takes one thread. ", "usage: wsp thread read <thread>")).toBe("wsp thread read takes one thread. usage: wsp thread read <thread>");
  });

  it("says the command's name once, whether or not the sentence opens with it", () => {
    expect(sayOnce("wsp run: ", "wsp run takes one task")).toBe("wsp run takes one task");
    expect(sayOnce("wsp delete: ", "no workspace nope")).toBe("wsp delete: no workspace nope");
    expect(sayOnce("", "no workspace nope")).toBe("no workspace nope");
    // The name is matched whole: a sentence that merely opens with the same letters keeps its prefix.
    expect(sayOnce("wsp stop: ", "wsp stopped nothing")).toBe("wsp stop: wsp stopped nothing");
    expect(sayOnce("wsp stop: ", "wsp stop")).toBe("wsp stop");
  });

  it("answers a word no command has with the word and where the list is, and never with the list itself", () => {
    expect(refusalLine(unknownWordLine("ls"), runForTheList("wsp --help"))).toBe("unknown command: ls. Run wsp --help for the list.");
    expect(refusalLine(unknownWordLine("ls"), runForTheList("wsp --help")).split("\n")).toHaveLength(1);
  });
});

describe("foreignFlagLine", () => {
  it("names the verb or verbs that read the flag, then the one that does not", () => {
    expect(foreignFlagLine("--tick", ["wsp recipe"], "wsp recipe scan")).toBe("--tick belongs to wsp recipe; wsp recipe scan does not read it");
    expect(foreignFlagLine("--agent", ["wsp fork", "wsp run"], "wsp send")).toBe("--agent belongs to wsp fork and wsp run; wsp send does not read it");
  });
});

describe("DAEMON_UPDATING and DAEMON_UPDATE_FAILED", () => {
  it("says what is being done and that it failed, in fixed words: no daemon named, no reason quoted, and short enough for the row", () => {
    expect(DAEMON_UPDATING).toBe("updating the helper");
    expect(DAEMON_UPDATE_FAILED).toBe("could not update the helper");
    // The row's second line fits about thirty characters at the default sidebar width (measured in Chromium at
    // 159px), and a deploy's own reason is an npm log hundreds wide that names the daemon in its own words.
    for (const line of [DAEMON_UPDATING, DAEMON_UPDATE_FAILED]) {
      expect(line).not.toContain("daemon");
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("has its own pair for the first daemon a machine takes, since nothing that machine had is being replaced", () => {
    expect(DAEMON_INSTALLING).toBe("installing the helper");
    expect(DAEMON_INSTALL_FAILED).toBe("could not install the helper");
    for (const line of [DAEMON_INSTALLING, DAEMON_INSTALL_FAILED]) {
      expect(line).not.toContain("daemon");
      expect(line).not.toContain("updat");
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("the nap's words when its vault was not stored", () => {
  it("vaultOverCapLine reads the export and the cap in the one byte rule", () => {
    expect(vaultOverCapLine(797_760_137, 209_715_200)).toBe("the export was 761 MB, over the 200 MB cap");
    expect(vaultOverCapLine(6_000, 5_000)).toBe("the export was 6 KB, over the 5 KB cap");
  });

  it("the verdict says what the nap did and what stands, which is nothing where no nap ever stored one", () => {
    expect(vaultKeptLine({ vaultedAt: "2026-09-08T07:10:04.444Z" })).toBe("the nap saved no backup; what was saved before is kept");
    // A workspace whose first nap failed has no earlier backup to keep, and the row beside this one says "no
    // backup" with no day: a line promising one kept would be the app inventing a file.
    expect(vaultKeptLine({})).toBe("the nap saved no backup; nothing is saved off the machine");
    // Whatever refused the export stays on the line's title: a shell's own words are evidence, not a sentence.
    for (const why of [vaultOverCapLine(797_760_137, 209_715_200), "vault enumeration failed: ls: /root: No such file or directory"]) {
      for (const w of [{ vaultedAt: "2026-09-08T07:10:04.444Z" }, {}]) expect(vaultKeptLine(w)).not.toContain(why);
    }
  });

  it("vaultStaleLine is the one word every surface shows for a machine whose files are not backed up, short enough for the row, and nothing while the last nap stored a vault", () => {
    const refused = vaultOverCapLine(677_178_573, 209_715_200);
    expect(vaultStaleLine({ vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: refused })).toBe("no backup since 2026-09-08");
    // The day is the whole of it: the vault that stands can be days old, and the row has about thirty characters.
    expect(vaultStaleLine({ vaultedAt: "2026-09-01T23:59:59Z", vaultRefused: refused })).toBe("no backup since 2026-09-01");
    expect(vaultStaleLine({ vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: refused })!.length).toBeLessThanOrEqual(29);
    expect(vaultStaleLine({ vaultRefused: refused })).toBe("no backup");
    expect(vaultStaleLine({ vaultedAt: "2026-09-08T07:10:04.444Z" })).toBeNull();
    expect(vaultStaleLine({})).toBeNull();
  });
});

describe("wsp init --on once an image stands", () => {
  it("says in one sentence that the image is built at its own place when --on named another, and nothing when it named that place by id or name", () => {
    const home = { id: "p_abc", name: "spoo" };
    expect(imageHomeKeptLine("solari", home)).toBe("your image lives on spoo, so it is built there and not on solari");
    expect(imageHomeKeptLine("spoo", home)).toBeUndefined();
    expect(imageHomeKeptLine("p_abc", home)).toBeUndefined();
    expect(imageHomeKeptLine(undefined, home)).toBeUndefined();
  });
});

describe("a create's own words", () => {
  it("the fork's line names the workspace and the computer it starts on, and nothing of the image it copies", () => {
    expect(startingLine("spoo-fix", "hetzner")).toBe("starting spoo-fix on hetzner");
    expect(startingLine("clone-test", "ascii")).toBe("starting clone-test on ascii");
    for (const word of ["fork", "golden", "image", "machine"]) expect(startingLine("spoo-fix", "hetzner")).not.toContain(word);
    // The row draws this line while a fork boots, and it holds thirty mono characters.
    expect(startingLine("clone-test", "ascii").length).toBeLessThanOrEqual(30);
  });

  it("every line of the log is written one way: lower case, no full stop, no machine's id", () => {
    const lines = [startingLine("clone-test", "box"), hostnameSetLine("clone-test"), HOSTNAME_KEPT, CREATE_READY];
    for (const line of lines) {
      expect(line[0]).toBe(line[0]!.toLowerCase());
      expect(line.endsWith(".")).toBe(false);
      expect(line).not.toMatch(/\bfk_/);
    }
    expect(hostnameSetLine("clone-test")).toBe("hostname set to clone-test");
    expect(CREATE_READY).toBe("ready");
  });

  it("a refused hostname reads as what it means for the workspace, with no shell's words in it", () => {
    expect(HOSTNAME_KEPT).toBe("hostname not set; the workspace keeps the machine's own name");
    expect(HOSTNAME_KEPT).not.toContain("sethostname");
    expect(HOSTNAME_KEPT).not.toContain("failed");
  });
});

describe("what a move onto a newer image says about the files", () => {
  it("the confirm says what moves, what does not and what it costs, without naming a file", () => {
    expect(IMAGE_MOVE_CONFIRM).toContain("Your home folder moves to the new copy");
    expect(IMAGE_MOVE_CONFIRM).toContain("minus the files the image itself wrote and you never changed");
    expect(IMAGE_MOVE_CONFIRM).toContain("Anything installed outside your home comes from the new image");
    expect(IMAGE_MOVE_CONFIRM).toContain("everything running in this workspace stops with it");
    // An archive carries no deletion, so a person is told before the move and not after.
    expect(IMAGE_MOVE_CONFIRM).toContain("a file you deleted from a folder the image writes into comes back with it");
  });

  it("a move that had nowhere to go says so rather than saying the image's files came across", () => {
    expect(IMAGE_ALREADY_NEWEST).toBe("already on the newest version of its image, so nothing moved");
  });

  it("the kept line names the workspace's own edits, counted and sorted, and says the rest came from the new image", () => {
    expect(imageKeptLine([".zshrc"])).toBe("kept 1 changed file: .zshrc; every other file the image wrote came from the new image");
    expect(imageKeptLine([".zshrc", ".claude/settings.json"])).toBe("kept 2 changed files: .claude/settings.json, .zshrc; every other file the image wrote came from the new image");
  });

  it("a move that changed nothing says so rather than printing an empty list", () => {
    expect(imageKeptLine([])).toBe("every file the image wrote came from the new image; none of them had been changed here");
  });

  it("a version that recorded no files of its own says the whole home came across, whatever the kept list holds", () => {
    expect(imageKeptLine([], true)).toBe("the image it stood on lists no files of its own, so its whole home came across and none of the new image's copies stand");
  });
});

describe("a pause or a wake the provider never answered", () => {
  it("names the move, how long it was given in all, and what the provider reads about the machine after it", () => {
    expect(moveTimedOutLine("wake", 361_000, "paused")).toBe("wake did not complete in 6m 1s; the provider did not answer and reads the machine paused; try again");
    expect(moveTimedOutLine("pause", 480_000, "running")).toBe("pause did not complete in 8m; the provider did not answer and reads the machine running; try again");
  });
  it("says when the provider could not be read about the machine either", () => {
    expect(moveTimedOutLine("pause", 240_000, undefined)).toBe("pause did not complete in 4m; the provider did not answer and could not be read about the machine; try again");
  });
});

describe("a resume the provider does not take", () => {
  it("says the provider has not answered and that the machine is being read, since a hung call is not a failed resume", () => {
    expect(RESUME_UNANSWERED).toBe("the provider has not answered the resume request; reading the machine");
    // Neither a refusal nor a retry of the person's: the machine's own state settles it and the host asks again.
    for (const word of ["try again", "failed", "refused"]) expect(RESUME_UNANSWERED).not.toContain(word);
  });

  it("ends the asking with what the provider did, where the work is, and the one road to a machine now", () => {
    expect(wakeGaveUpLine(30, 30 * 60_000)).toBe(
      "the provider answered none of 30 resume requests over 30m; the work on this machine's disk stays with the provider, and a rebuild starts a new machine from the image",
    );
    expect(wakeGaveUpLine(1, 30_000)).toContain("none of 1 resume request over 30s");
  });

  it("counts the host's own asks on the row, of the number it will make", () => {
    expect(wakeAskingAgainLine(3, wakeAsksIn(30 * 60_000, 60_000))).toBe("waking, asking again (3 of 30)");
    expect(wakeAskingAgainLine(1, 2)).toBe("waking, asking again (1 of 2)");
  });

  it("fits as many asks in the asking as the cadence leaves room for, since the window is wall time", () => {
    expect(wakeAsksIn(30 * 60_000, 60_000)).toBe(30);
    // The last ask starts inside the window, so a window of one cadence holds one ask and half a cadence more holds two.
    expect(wakeAsksIn(60_000, 60_000)).toBe(1);
    expect(wakeAsksIn(90_000, 60_000)).toBe(2);
    expect(wakeAsksIn(0, 60_000)).toBe(0);
  });

  it("says the machine is still paused when the person stopped the asking", () => {
    expect(WAKE_STOPPED).toBe("waking stopped; the machine is still paused");
  });

  it("names the workspace in what the needs-you road says outside the app", () => {
    expect(workspaceAwakeLine("b1")).toBe("b1 is awake");
  });
});

describe("goldenBuildLine", () => {
  it("names the version it builds and the one it builds on top of, then what it changes", () => {
    expect(goldenBuildLine(2, 3, [{ count: 2, noun: "tool", word: "added" }])).toBe("Builds version 3 on top of version 2: 2 tools added");
  });

  it("pluralises each noun on its own count and drops what did not change", () => {
    expect(goldenBuildLine(1, 2, [{ count: 1, noun: "tool", word: "added" }, { count: 0, noun: "agent", word: "added" }, { count: 3, noun: "row", word: "retired" }])).toBe(
      "Builds version 2 on top of version 1: 1 tool added, 3 rows retired",
    );
  });

  it("a build with no version under it names no version to build on, and a build that changes nothing says only what it makes", () => {
    expect(goldenBuildLine(0, 1, [{ count: 4, noun: "tool", word: "added" }])).toBe("Builds version 1: 4 tools added");
    expect(goldenBuildLine(2, 3, [{ count: 0, noun: "tool", word: "added" }])).toBe("Builds version 3 on top of version 2");
  });
});

describe("REPO_STATE_WORDS", () => {
  it("says no word for a folder outside any repository or one not yet asked, and one short lowercase word or two for a read the machine refused", () => {
    expect(REPO_STATE_WORDS.unknown).toEqual({ word: "", note: "", pane: "" });
    expect(REPO_STATE_WORDS.none.word).toBe("");
    expect(REPO_STATE_WORDS.none.note).toBe("");
    expect(REPO_STATE_WORDS.refused.word).toBe("git unread");
    expect(REPO_STATE_WORDS.refused.word).toMatch(/^[a-z]+( [a-z]+)?$/);
    expect(REPO_STATE_WORDS.refused.word.length).toBeLessThanOrEqual(12);
  });

  it("explains the word beside it in one dry sentence about the machine and this folder's git state", () => {
    expect(REPO_STATE_WORDS.refused.note).toBe("The task could not read this folder's git state, so no branch is shown.");
    expect(REPO_STATE_WORDS.refused.note).toMatch(/^[^.]+\.$/);
  });

  it("gives an empty diff pane one dry sentence only for a folder outside any repository; a refused read shows its own cause", () => {
    expect(REPO_STATE_WORDS.none.pane).toBe("This folder is not inside a git repository, so there is nothing to diff.");
    expect(REPO_STATE_WORDS.none.pane).toMatch(/^[^.]+\.$/);
    expect(REPO_STATE_WORDS.refused.pane).toBe("");
  });
});

describe("LINEAGE_MARKS", () => {
  it("names every outcome a missing tool can carry and every state a lineage row shows, each as one short lowercase word or two", () => {
    const outcomes: GoldenMissingTool["outcome"][] = ["skipped", "failed"];
    for (const o of outcomes) expect(LINEAGE_MARKS[o]).toBe(o);
    expect(LINEAGE_MARKS).toEqual({ now: "now", head: "newest", fork: "this one", failed: "failed", skipped: "skipped", volatile: "snapshot only" });
    for (const word of Object.values(LINEAGE_MARKS)) {
      expect(word).toMatch(/^[a-z]+( [a-z]+)?$/);
      expect(word.length).toBeLessThanOrEqual(13);
    }
  });
});

describe("template words", () => {
  it("says the image is being saved and whether the seal asks again, never the template's id; ready is final", () => {
    expect(templateStatusLine("building")).toBe("saving the image, the provider says building; asking again");
    expect(templateStatusLine("ready")).toBe("the image is saved");
  });

  it("names a failed template with the provider's reason, or that none was given, and a wait that ran out with the last status and the time", () => {
    expect(templateFailedLine("tpl_a", "restore copy failed")).toBe("the provider failed the template tpl_a: restore copy failed");
    expect(templateFailedLine("tpl_a", undefined)).toBe("the provider failed the template tpl_a: no reason given");
    expect(templateWaitedLine("tpl_a", "building", 300_000)).toBe("the template tpl_a still reads building after 5m");
  });

  it("the doctor's line per version names the template it promoted and, when other templates already carry the name, how many", () => {
    expect(templateRecordedLine("default", 2, "tpl_0f1e", 0)).toBe("image default v2: template tpl_0f1e promoted and recorded");
    expect(templateRecordedLine("default", 1, "tpl_0f1e", 1)).toBe("image default v1: template tpl_0f1e promoted and recorded; 1 other template carries its name");
    expect(templateRecordedLine("default", 1, "tpl_0f1e", 2)).toBe("image default v1: template tpl_0f1e promoted and recorded; 2 other templates carry its name");
    expect(templateRecordedLine("default", 1, "tpl_0f1e", undefined)).toBe("image default v1: template tpl_0f1e promoted and recorded");
    expect(templateSkippedLine("default", 1, "its snapshot is gone at the provider")).toBe("image default v1: no template recorded, its snapshot is gone at the provider");
    expect(NO_TEMPLATES_LINE).toBe("this backend has no templates; image versions stay as snapshots");
  });
});

describe("missingToolRow", () => {
  it("shows a record as its name, reason and outcome, and one sealed without a name or an outcome by its id and as failed, so no row renders blank", () => {
    expect(missingToolRow({ id: "tools/brew/gopls", name: "gopls", outcome: "skipped", note: "no Linux bottle" })).toEqual({ name: "gopls", note: "no Linux bottle", mark: "skipped" });
    expect(missingToolRow({ id: "base/docker", note: "E: Unable to locate package docker-compose-v2" })).toEqual({ name: "base/docker", note: "E: Unable to locate package docker-compose-v2", mark: "failed" });
    expect(missingToolRow({ id: "base/docker", name: "", outcome: "failed", note: "E: Unable to locate package docker-compose-v2" }).name).toBe("base/docker");
  });
});

describe("behindGoldenLine", () => {
  it("names the version it is on and the one available, in words short enough for the row", () => {
    expect(behindGoldenLine(11, 12)).toBe("on image v11, v12 available");
    expect(behindGoldenLine(11, 12).length).toBeLessThanOrEqual(30);
  });
});

describe("DISK_SYNC_LINE, diskUnsettledLine and diskSyncFailedLine", () => {
  it("the sync's stage line, what a writer left after it, and the refusal when the guest's sync failed", () => {
    expect(DISK_SYNC_LINE).toBe("syncing the disk");
    expect(diskUnsettledLine({ dirtyKb: 12288, writebackKb: 0 })).toBe("synced, Dirty 12 MB and Writeback 0 B remain; a writer is still running");
    expect(diskSyncFailedLine("it exited 1 and said: sync: Input/output error")).toBe("the disk could not be synced (it exited 1 and said: sync: Input/output error); nothing was snapshotted");
  });
});

describe("providerAnswerLine, snapshotAttemptLine and snapshotFailedLine", () => {
  const refused = { status: 502, message: "Failed to snapshot sandbox", requestId: "req_7", at: "2026-09-07T01:19:43.352Z" };

  it("providerAnswerLine carries the status, the message and the request id; without one it says so and gives the UTC time of the reply instead, never an empty id", () => {
    expect(providerAnswerLine(refused)).toBe("502 Failed to snapshot sandbox (request req_7)");
    expect(providerAnswerLine({ status: 502, message: "Failed to snapshot sandbox", at: "2026-09-07T01:19:43.352Z" })).toBe("502 Failed to snapshot sandbox (no request id from the provider, at 2026-09-07T01:19:43.352Z)");
  });

  it("an attempt line names the attempt, the answer, what the builder reads and when the next attempt is", () => {
    expect(snapshotAttemptLine(1, 3, refused, "running", 60_000)).toBe("attempt 1 of 3 answered 502 Failed to snapshot sandbox (request req_7); the builder reads running, next attempt in 1m");
  });

  it("the failure line counts the attempts and says whether the provider still has the builder", () => {
    expect(snapshotFailedLine(3, refused, "running")).toBe("the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_7) while the builder read running");
    expect(snapshotFailedLine(1, refused, "gone")).toBe("the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_7) and no longer has the builder (404)");
    expect(snapshotFailedLine(1, refused, "unread", "upstream sad (503)")).toBe("the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_7) and could not be read about the builder (upstream sad (503))");
  });
});

describe("builderStaysLine and the seal's and the update's last lines", () => {
  it("the stays-up sentence is one rule, and the failed seal's last line wraps it", () => {
    const stays = builderStaysLine("m1", 0.11, "wsp init --recipe '/tmp/r.json'");
    expect(stays).toBe("Builder m1 stays up at about $0.11/hr; wsp init --recipe '/tmp/r.json' attaches to it again, and the sweep stops it once it is six hours old.");
    expect(sealFailedBuilderStaysLine("m1", 0.11, "wsp init --recipe '/tmp/r.json'")).toBe(`Seal failed; the builder is as you left it. ${stays}`);
    expect(sealFailedBuilderUnreadLine("m1", 0.11, "wsp init --recipe '/tmp/r.json'")).toBe(`Seal failed; the provider could not be read about the builder, so nothing on it was touched. ${stays}`);
    expect(SEAL_FAILED_BUILDER_GONE_LINE).toBe("Seal failed and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again; the recipe is kept.");
  });

  it("the update's last lines say the image stands and whether the provider still has the machine the new version ran on", () => {
    expect(upgradeSealFailedStaysLine(1, "m1", 0.11)).toBe("Image v1 is unchanged. Builder m1 is as it was, up at about $0.11/hr; run wsp init again to retry, and the sweep stops it once it is six hours old.");
    expect(upgradeSealFailedGoneLine(1)).toBe("Image v1 is unchanged and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again to retry.");
    expect(upgradeSealFailedUnreadLine(1, "m1")).toBe("Image v1 is unchanged. The provider could not be read about builder m1, so nothing on it was touched; run wsp init again to retry, and the sweep stops it once it is six hours old.");
    expect(SEAL_FAILED_LINE).toBe("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.");
  });
});

describe("a pinned release that moved", () => {
  it("the failure names the download, its tag, and the recorded and served sums, both cut so the reason line keeps them", () => {
    expect(SUM_SHOWN).toBe(12);
    expect(shortSum("b".repeat(64))).toBe("b".repeat(12));
    expect(pinMismatchLine("gh_2.86.0_linux_amd64.tar.gz", "v2.86.0", shortSum("b".repeat(64)), shortSum("c".repeat(64)))).toBe(
      "gh_2.86.0_linux_amd64.tar.gz at v2.86.0 does not match the checksum recorded on its first install: recorded bbbbbbbbbbbb, served cccccccccccc",
    );
    // With the widest tool and asset names the catalog has, the line stays under the 160 characters the reason rule keeps.
    expect(pinMismatchLine("google-cloud-cli-575.0.0-linux-x86_64.tar.gz", "575.0.0", "b".repeat(12), "c".repeat(12)).length).toBeLessThan(160);
  });

  it("why a tool installs differently now: the road in the roads' words, the lines otherwise", () => {
    expect(roadMovedLine("with Homebrew", "by its own installer")).toBe("now by its own installer, was with Homebrew");
    expect(INSTALLER_MOVED_LINE).toBe("its install lines changed");
    expect(roadMovedLine("with Homebrew", NO_ROAD_WORDS)).toBe("now by no road, was with Homebrew");
  });

  it("a pin in words: the version alone where a copy gets it, with the latest mark where the road installs the current one on every place", () => {
    expect(INSTALLS_LATEST).toBe("installs latest");
    expect(pinWords({ tag: "v2.86.0", sha256: "b".repeat(64) })).toBe("v2.86.0");
    expect(pinWords({ tag: "3.3a-3", latest: true })).toBe("3.3a-3, installs latest");
    // The record's line: the row by name, the version, the checksum where the road hashed one, the latest mark in the road's words.
    expect(sealedPinLine("GitHub CLI", { tag: "v2.86.0", sha256: "b".repeat(64) })).toBe("GitHub CLI  v2.86.0  checksum bbbbbbbbbbbb");
    expect(sealedPinLine("tmux", { tag: "3.3a-3", latest: true }, "by apt")).toBe("tmux  3.3a-3  installs latest by apt");
    expect(sealedPinLine("Claude Code", { tag: "2.1.3", latest: true })).toBe("Claude Code  2.1.3  installs latest");
    expect(sealedPinLine("wrangler", { tag: "4.1.0" })).toBe("wrangler  4.1.0");
    // The stage's one line: the pinned rows, then once the rows that install latest with the version this build got; nothing when nothing was read.
    expect(pinsReadLine([{ name: "wrangler", tag: "4.1.0" }, { name: "GitHub CLI", tag: "v2.86.0" }], [{ name: "tmux", tag: "3.3a-3", words: "by apt" }, { name: "Go", tag: "1.22.1", words: "with Homebrew" }])).toBe(
      "pinned: wrangler 4.1.0, GitHub CLI v2.86.0; installs latest on every place: tmux 3.3a-3 by apt, Go 1.22.1 with Homebrew",
    );
    expect(pinsReadLine([], [{ name: "Claude Code", tag: "2.1.3" }])).toBe("installs latest on every place: Claude Code 2.1.3");
    expect(pinsReadLine([{ name: "a, b", tag: "1" }], [])).toBe('pinned: "a, b" 1');
    expect(pinsReadLine([], [])).toBeUndefined();
  });
});

describe("the computer being read", () => {
  it("is a Mac by name on a Mac and the plain word anywhere else", () => {
    expect(thisComputer("darwin")).toBe("this Mac");
    expect(thisComputer("linux")).toBe("this computer");
  });
});

describe("a tools row outside the catalog", () => {
  it("says it is on this computer, what the build does with it, and when a file's tick has no row here", () => {
    expect(installedHereLine("darwin", undefined)).toBe("installed on this Mac");
    expect(installedHereLine("darwin", "0.1.0")).toBe("installed on this Mac, 0.1.0");
    expect(installedHereLine("linux", "0.1.0")).toBe("installed on this computer, 0.1.0");
    expect(installsByLine("from its release", "the v0.1.0 release of github.com/Zingzy/diskbloom")).toBe("installs from its release: the v0.1.0 release of github.com/Zingzy/diskbloom");
    expect(leftOutLine("no Linux bottle known")).toBe("left out of the build: no Linux bottle known");
    expect(notHereLine("darwin", "zingzy/tap/diskbloom", "/tmp/given.json")).toBe("zingzy/tap/diskbloom is ticked in /tmp/given.json, but this Mac has no row that installs it; it is left out.");
    expect(notHereLine("linux", "direnv", "/tmp/given.json")).toBe("direnv is ticked in /tmp/given.json, but this computer has no row that installs it; it is left out.");
  });
});

describe("the import dialog's words", () => {
  it("names the workspace the folder goes into and that it lands at the same path", () => {
    expect(importIntoLine("dev2")).toBe("Into dev2, at the same path.");
  });

  it("says a repository's history travels in plain words, and when there is none", () => {
    expect(repoLine(true)).toBe("Git repository, history travels");
    expect(repoLine(false)).toBe("No repository");
  });

  it("tells a stranger what the ticks on the secret-shaped rows do, and how many rows there are", () => {
    expect(secretsNote(2)).toBe("2 files look like secrets. Ticked files are copied as they are. Unticked files are left out and listed.");
    expect(secretsNote(1)).toBe("1 file looks like a secret. Ticked files are copied as they are. Unticked files are left out and listed.");
    expect(SESSIONS_NOTE).toBe("Ticked agents' sessions go with the folder. The rest stay here.");
  });

  it("names why a file looks like a secret and its size, the one spelling the CLI's plan column and the dialog's hover share", () => {
    expect(secretSignalsLine({ path: ".env", bytes: 120, signals: ["name", "keys"] })).toBe("name, keys, 120 B");
  });

  const ev = (over: { stage: string; message?: string; bytes?: number; total?: number }) => ({ message: "", ...over }) as Parameters<typeof importProgress>[0][number];
  const dest = "/Users/me/code/proj";
  /** The events one import with travelling sessions makes, in the runtime's order: the project upload lands, then the sessions tar uploads and lands. */
  const TRIP = [
    ev({ stage: "planned", message: "1204 files, 38 MB and the repository; 3 secret-shaped files; 4 caches left behind." }),
    ev({ stage: "consented", message: "Rewriting .git/config to https://github.com/o/r; cut .env. Sessions travel for Claude Code (46 sessions)." }),
    ev({ stage: "packing", message: "Packing 1857 files." }),
    ev({ stage: "uploading", message: "Uploading 32 MB.", bytes: 0, total: 33_449_574 }),
    ev({ stage: "uploading", message: "Part 1 of 2, 16 MB of 32 MB.", bytes: 16_724_787, total: 33_449_574 }),
    ev({ stage: "uploading", message: "Part 2 of 2, 32 MB of 32 MB.", bytes: 33_449_574, total: 33_449_574 }),
    ev({ stage: "landing", message: `Landing at ${dest}.` }),
    ev({ stage: "uploading", message: "Uploading 3 session files and the rows to merge, 1 MB.", bytes: 0, total: 1_258_291 }),
    ev({ stage: "uploading", message: "Part 1 of 1, 1 MB of 1 MB.", bytes: 1_258_291, total: 1_258_291 }),
    ev({ stage: "landing", message: "Merging rows into Codex." }),
    ev({ stage: "landing", message: "Landing sessions: Claude Code moved, Codex transcripts landed." }),
    ev({ stage: "done", message: `1855 files, 38 MB, landed at ${dest}; sessions: Claude Code moved.` }),
  ];

  it("reads the trip's current step in plain words and holds the bar: starting, the runtime's packing count, the upload by its total, the landing by the workspace, the sessions pass named, done", () => {
    expect(importProgress([], "dev2")).toBeNull();
    const seen = TRIP.map((_, i) => importProgress(TRIP.slice(0, i + 1), "dev2"));
    expect(seen.map(p => p?.line)).toEqual([
      "Starting",
      "Starting",
      "Packing 1857 files",
      "Uploading 32 MB",
      "Uploading 32 MB",
      "Uploading 32 MB",
      "Landing on dev2",
      "Uploading sessions, 1 MB",
      "Uploading sessions, 1 MB",
      "Landing on dev2",
      "Landing on dev2",
      "Done",
    ]);
    expect(seen.map(p => p?.fraction)).toEqual([0, 0, 0, 0, 0.5, 1, 1, 1, 1, 1, 1, 1]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.fraction, `step ${i}`).toBeGreaterThanOrEqual(seen[i - 1]!.fraction);
  });

  it("an upload without a total still reads, and a failure has no step since the status line carries it", () => {
    expect(importProgress([ev({ stage: "uploading", message: "Uploading." })], "dev2")).toEqual({ line: "Uploading", fraction: 0 });
    expect(importProgress([ev({ stage: "packing", message: "Packing 2 files." }), ev({ stage: "failed", message: "the machine went away" })], "dev2")).toBeNull();
  });
});

describe("the export dialog's words", () => {
  it("names the workspace the folder comes from and that it lands on this Mac", () => {
    expect(exportFromLine("dev2")).toBe("From dev2, to this Mac.");
  });

  it("tells a stranger what the ticks on the agent rows do, what happens when the workspace has no threads, and why a row is empty before the export", () => {
    expect(EXPORT_SESSIONS_NOTE).toBe("Ticked agents' sessions come home with the folder. The rest stay in the task.");
    expect(NO_THREADS_NOTE).toBe("No threads here. Every agent's sessions for the folder come home with it.");
    expect(NOT_LANDED_WORD).toBe("when it lands");
  });

  const ev = (over: { stage: string; message?: string; bytes?: number; total?: number }) => ({ message: "", ...over }) as Parameters<typeof exportProgress>[0][number];
  /** The events one export with agent state makes, in the runtime's order: the folder packs and downloads, then the agents' state does, then one landing. */
  const TRIP = [
    ev({ stage: "packing", message: "Packing /root/spoo on the machine." }),
    ev({ stage: "downloading", message: "The folder: 0 B of 31 MB.", bytes: 0, total: 32_505_856 }),
    ev({ stage: "downloading", message: "The folder: 16 MB of 31 MB.", bytes: 16_252_928, total: 32_505_856 }),
    ev({ stage: "downloading", message: "The folder: 31 MB of 31 MB.", bytes: 32_505_856, total: 32_505_856 }),
    ev({ stage: "packing", message: "Packing the agents' state for it on the machine." }),
    ev({ stage: "downloading", message: "Agent state: 0 B of 1 MB.", bytes: 0, total: 1_292_000 }),
    ev({ stage: "downloading", message: "Agent state: 1 MB of 1 MB.", bytes: 1_292_000, total: 1_292_000 }),
    ev({ stage: "landing", message: "Landing at /Users/me/code/spoo." }),
    ev({ stage: "done", message: "1202 files, 38 MB, landed at /Users/me/code/spoo; 4 caches left behind; sessions: Claude Code (6 sessions) moved." }),
  ];

  it("reads the trip's current step in plain words and holds the bar: the folder packs and downloads by its total, the sessions are their own named pass, the landing, done", () => {
    expect(exportProgress([])).toBeNull();
    const seen = TRIP.map((_, i) => exportProgress(TRIP.slice(0, i + 1)));
    expect(seen.map(p => p?.line)).toEqual([
      "Packing the folder",
      "Downloading the folder, 31 MB",
      "Downloading the folder, 31 MB",
      "Downloading the folder, 31 MB",
      "Packing sessions",
      "Downloading sessions, 1 MB",
      "Downloading sessions, 1 MB",
      "Landing on this Mac",
      "Done",
    ]);
    expect(seen.map(p => p?.fraction)).toEqual([0, 0, 0.5, 1, 1, 1, 1, 1, 1]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.fraction, `step ${i}`).toBeGreaterThanOrEqual(seen[i - 1]!.fraction);
  });

  it("a download without a total still reads, and a failure has no step since the status line carries it", () => {
    expect(exportProgress([ev({ stage: "packing" }), ev({ stage: "downloading", message: "The folder." })])).toEqual({ line: "Downloading the folder", fraction: 0 });
    expect(exportProgress([ev({ stage: "packing" }), ev({ stage: "failed", message: "the machine went away" })])).toBeNull();
  });
});

describe("unknownAgentLine", () => {
  it("names the id nobody knows and the ids the catalog does, so a typo is a sentence", () => {
    expect(unknownAgentLine("codx", ["claude", "codex"])).toBe("no agent called codx; the catalog knows claude, codex");
  });
});

describe("terminalConfigLines", () => {
  const none = { files: [], fontFamily: [], palette: Array<null>(16).fill(null) };
  it("with no file says so in one line", () => {
    expect(format.terminalConfigLines(none)).toEqual(["No Ghostty config on this computer; the terminal pane keeps its defaults."]);
  });
  it("names the files read, then one line per key the pane honours, in Ghostty's own words, hex for colors and a count for the palette", () => {
    expect(
      format.terminalConfigLines({
        ...none,
        files: ["/Users/dev/.config/ghostty/config", "/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha"],
        fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
        fontSize: 13,
        theme: "Catppuccin Mocha",
        background: { r: 30, g: 30, b: 46 },
        foreground: { r: 205, g: 214, b: 244 },
        palette: [{ r: 69, g: 71, b: 90 }, ...Array<null>(15).fill(null)],
        selectionBackground: { r: 88, g: 91, b: 112 },
        cursorColor: { r: 245, g: 224, b: 220 },
        cursorStyle: "underline",
        cursorStyleBlink: false,
        windowPaddingX: { left: 2, right: 4 },
        windowPaddingY: { top: 6, bottom: 6 },
        backgroundOpacity: 0.85,
        backgroundBlur: 20,
      }),
    ).toEqual([
      "Read /Users/dev/.config/ghostty/config, /Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha",
      "font-family = Berkeley Mono, Symbols Nerd Font Mono",
      "font-size = 13",
      "theme = Catppuccin Mocha",
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 1 of 16 colors",
      "selection-background = #585b70",
      "cursor-color = #f5e0dc",
      "cursor-style = underline",
      "cursor-style-blink = false",
      "window-padding-x = 2,4",
      "window-padding-y = 6",
      "background-opacity = 0.85",
      "background-blur = 20",
    ]);
  });
});

describe("the words a relayed permission prompt shows", () => {
  it("words a file write by the file, the folder holding it and how much is going in", () => {
    // The path and the file's own text are what a person cannot read at a glance; the name, the folder and the size are.
    expect(permissionAskLine("Write", JSON.stringify({ file_path: "/Users/dev/wsp-work/index.html", content: "x".repeat(2_100) }))).toBe(
      "Write index.html in wsp-work (2 KB)",
    );
    expect(permissionAskLine("Write", JSON.stringify({ file_path: "out.txt", content: "hi" }))).toBe("Write out.txt (2 B)");
    // The lead is the whole of it: a write's own words carry no code part, since a file's name is not read character by character.
    expect(permissionPromptWords("Write", JSON.stringify({ file_path: "/root/out.txt", content: "hi" })).code).toBeUndefined();
    // The options under it are the question, so the line never asks one.
    expect(permissionAskLine("Write", JSON.stringify({ file_path: "/root/out.txt", content: "hi" }))).not.toContain("?");
  });

  it("words a command as the whole command, kept apart from the words so a client can draw it as code", () => {
    // A command goes in whole, its later lines and its length alike: one cut anywhere is one nobody can judge.
    const long = `cat > out.py <<'PY'\nprint(${"1 + ".repeat(60)}1)\nPY`;
    expect(permissionAskLine("Bash", JSON.stringify({ command: long, description: "Write and run a sum" }))).toBe(`Run: ${long}`);
    // The two parts are apart, so a face that blurs two hyphens into one dash never draws the command.
    const gate = "pnpm exec vitest run --minWorkers=1 --maxWorkers=1";
    expect(permissionPromptWords("Bash", JSON.stringify({ command: gate }))).toMatchObject({ says: "Run:", code: gate, lead: `Run: ${gate}` });
  });

  it("words a tool a server lends as the server and the tool, and never the server's own paragraph", () => {
    expect(permissionAskLine("mcp__wsp__workspaces", "{}", "wsp runs cloud machines called workspaces, forked in seconds")).toBe("Use the wsp tools: workspaces");
    expect(permissionAskLine("mcp__wsp__run", "{}")).toBe("Use the wsp tools: run");
    expect(permissionPromptWords("mcp__wsp__workspaces", "{}", "wsp runs cloud machines").code).toBeUndefined();
  });

  it("words a skill as its own name, and never the description paragraph the harness sends", () => {
    expect(permissionAskLine("Skill", JSON.stringify({ skill: "agent-browser" }), "Browser automation CLI for AI agents. Use when the user needs")).toBe(
      "Run the skill agent-browser",
    );
  });

  it("falls back to the harness's own phrase under the tool's name for a kind with no rule and for input it cannot read", () => {
    expect(permissionAskLine("Read", JSON.stringify({ file_path: "/root/out.txt" }), "out.txt")).toBe("Permission for Read: out.txt");
    expect(permissionAskLine("Read", "{}")).toBe("Permission for Read");
    expect(permissionAskLine("Read", "{}", "")).toBe("Permission for Read");
    // Input that is not an object yet, and a call whose input carries none of what its rule needs, fall back the same way.
    expect(permissionAskLine("Bash", "{\"comm", "rm -rf build")).toBe("Permission for Bash: rm -rf build");
    expect(permissionAskLine("Write", "{}", "out.txt")).toBe("Permission for Write: out.txt");
  });

  it("folds a file's body away and shows the rest of the input under the lead", () => {
    const body = "line\n".repeat(400);
    const write = permissionPromptWords("Write", JSON.stringify({ file_path: "/Users/dev/wsp-work/index.html", content: body }));
    expect(write.lead).toBe("Write index.html in wsp-work (2 KB)");
    // The file is behind the fold, whole, and nowhere else: the buttons stay in reach.
    expect(write.body).toEqual({ label: "show the file", text: body });
    expect(write.rest).toBe("");
    // The lead already carries the command, and the harness's phrase for it is never the row's words.
    expect(permissionPromptWords("Bash", JSON.stringify({ command: "rm -rf build", description: "Clean the build" })).rest).toBe("");
    expect(permissionPromptWords("Skill", JSON.stringify({ skill: "agent-browser" }), "Browser automation CLI").rest).toBe("");
    // What the lead does not carry still shows, each field apart from the next: this is the row consent is given on.
    expect(permissionPromptWords("Bash", JSON.stringify({ command: "ls", timeout: 5_000 })).rest).toBe("timeout: 5000");
    expect(permissionPromptWords("mcp__wsp__send", JSON.stringify({ threadId: "thr_1", message: "go" })).rest).toBe("threadId: thr_1\nmessage: go");
    // A field a tool really calls description is the call's own, not the harness's paragraph, so it shows like any other.
    expect(permissionPromptWords("mcp__linear__create_issue", JSON.stringify({ title: "Fix login", description: "The button does\n\nnothing on Safari." })).rest).toBe(
      "title: Fix login\ndescription: The button does nothing on Safari.",
    );
    // A tool that carries no file body folds nothing away, and input that is not an object is shown as it stands.
    expect(permissionPromptWords("Bash", JSON.stringify({ command: "ls" })).body).toBeUndefined();
    expect(permissionPromptWords("Bash", "not json").rest).toBe("not json");
  });

  it("says how a closed prompt closed, naming the option only where it says something the outcome does not", () => {
    const allow = { label: "Allow", effect: "allow" as const };
    const deny = { label: "Deny", effect: "deny" as const };
    const mode = { label: "Allow, then Accept edits", effect: "mode" as const };
    // "Allowed: Allow" and "Denied: Deny" name one fact twice; the mode pick is the one that says more.
    expect(permissionOutcomeLine("allowed", allow)).toBe("Allowed");
    expect(permissionOutcomeLine("allowed")).toBe("Allowed");
    expect(permissionOutcomeLine("denied", deny)).toBe("Denied");
    expect(permissionOutcomeLine("allowed", mode)).toBe("Allowed: Allow, then Accept edits");
    // Nobody picked either of these, so neither names an option, whatever it is handed.
    expect(permissionOutcomeLine("unanswered")).toBe("Nobody answered; denied");
    expect(permissionOutcomeLine("cancelled")).toBe("Cancelled with the turn");
    expect(permissionOutcomeLine("unanswered", deny)).toBe("Nobody answered; denied");
    expect(permissionOutcomeLine("cancelled", mode)).toBe("Cancelled with the turn");
  });

  it("reads a call that asks the person as the question it is, with one answer per choice and no consent to give", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "This working directory is not a repository. What should I do?",
          header: "Directory",
          options: [
            { label: "Clone it", description: "Fetch the remote into this folder." },
            { label: "Start fresh", description: "Run git init here." },
            { label: "Stop", description: "Do nothing and wait." },
          ],
          multiSelect: false,
        },
      ],
    });
    const asked = askedQuestions(QUESTION_TOOL, input)!;
    expect(asked).toHaveLength(1);
    expect(asked[0]!.header).toBe("Directory");
    expect(asked[0]!.question).toBe("This working directory is not a repository. What should I do?");
    expect(asked[0]!.multiSelect).toBe(false);
    expect(asked[0]!.options.map(o => [o.label, o.description])).toEqual([
      ["Clone it", "Fetch the remote into this folder."],
      ["Start fresh", "Run git init here."],
      ["Stop", "Do nothing and wait."],
    ]);
    // Three choices, three options on the wire, every one an answer: nothing here offers to allow or refuse a call
    // that only asks.
    const options = questionOptions(QUESTION_TOOL, input);
    expect(options).toHaveLength(3);
    expect(options.map(o => o.label)).toEqual(["Clone it", "Start fresh", "Stop"]);
    expect(new Set(options.map(o => o.effect))).toEqual(new Set(["answer"]));
    expect(options.map(o => o.id)).toEqual([...new Set(options.map(o => o.id))]);
    // The whole prompt is the question; no raw input is left anywhere on it.
    const words = permissionPromptWords(QUESTION_TOOL, input);
    expect(words.questions).toEqual(asked);
    expect(words.rest).toBe("");
    expect(words.body).toBeUndefined();
    expect(words.lead).toBe("This working directory is not a repository. What should I do?");
    // The call itself reads as the question too: the tool's own name is no word a person knows.
    expect(toolActivityLine(QUESTION_TOOL, input)).toBe("asked: This working directory is not a repository. What should I do?");
    expect(toolActivityLine(QUESTION_TOOL, input)).not.toContain(QUESTION_TOOL);
    // And the transcript's own row for it reads the same way: words a person knows, then the question under them.
    const facts = toolCallFacts(QUESTION_TOOL, input);
    expect(facts.title).toBe("Asked you");
    // The prompt under that row is the question, whole, so the row itself repeats none of it.
    expect(facts.detail).toBeUndefined();
    // Every tool a person already knows the word for keeps the harness's own name.
    expect(toolCallFacts("Bash", JSON.stringify({ command: "ls" })).title).toBeUndefined();
    for (const raw of ["multiSelect", "questions:", "{", "}"]) expect(words.lead).not.toContain(raw);
    // Every other kind of call keeps its own words and carries no questions.
    expect(permissionPromptWords("Bash", JSON.stringify({ command: "ls" })).questions).toBeUndefined();
    expect(askedQuestions("Bash", JSON.stringify({ command: "ls" }))).toBeUndefined();
    expect(questionOptions("Bash", JSON.stringify({ command: "ls" }))).toEqual([]);
  });

  it("turns a pick into the answer the harness reads off the call's own input, one label or the several ticked", () => {
    const one = JSON.stringify({
      questions: [{ question: "Tabs or spaces?", header: "Indent", options: [{ label: "Tabs" }, { label: "Spaces" }], multiSelect: false }],
    });
    const options = questionOptions(QUESTION_TOOL, one);
    const spaces = options[1]!.id;
    expect(questionAnswerInput(QUESTION_TOOL, one, [spaces])).toMatchObject({ answers: { "Tabs or spaces?": "Spaces" } });
    // The call's own fields ride back with it: the harness matches the answer to the question it asked.
    expect(questionAnswerInput(QUESTION_TOOL, one, [spaces])!["questions"]).toEqual(JSON.parse(one).questions);
    // One pick closes one prompt, so a question that takes several answers sends them as one id.
    const many = JSON.stringify({
      questions: [{ question: "Which checks?", header: "Checks", options: [{ label: "Types" }, { label: "Tests" }, { label: "Lint" }], multiSelect: true }],
    });
    const picks = questionOptions(QUESTION_TOOL, many);
    const both = pickedOptionId([picks[0]!.id, picks[2]!.id]);
    expect(pickedOptions(picks, both)!.map(o => o.label)).toEqual(["Types", "Lint"]);
    expect(questionAnswerInput(QUESTION_TOOL, many, [picks[0]!.id, picks[2]!.id])).toMatchObject({ answers: { "Which checks?": ["Types", "Lint"] } });
    // A pick naming anything this prompt does not carry names nothing at all.
    expect(pickedOptions(picks, "q9:o9")).toBeUndefined();
    expect(pickedOptions(picks, pickedOptionId([picks[0]!.id, "q9:o9"]))).toBeUndefined();
    // An ordinary prompt's own ids still resolve through the one road every pick takes.
    const plain = [{ id: "allow", label: "Allow", effect: "allow" as const }];
    expect(pickedOptions(plain, "allow")!.map(o => o.id)).toEqual(["allow"]);
    // A closed question says what was picked, since "Allowed" says nothing about an answer.
    expect(permissionOutcomeLine("allowed", { label: "Types, Lint", effect: "answer" })).toBe("You answered: Types, Lint");
  });

  it("shows nobody a tool result the harness marked its own note to the agent, and titles a launch by its task", () => {
    const note = "Async agent launched successfully. (This tool result is internal metadata, never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a057760";
    expect(internalToolResult(note)).toBe(true);
    expect(toolResultLine(note)).toBeUndefined();
    // What a person may read is untouched.
    expect(internalToolResult("acpi\nadduser.conf")).toBe(false);
    expect(toolResultLine("acpi\nadduser.conf")).toBe("acpi");
    // The fold's own line says what was launched, off the call that launched it.
    expect(subagentTaskLine(JSON.stringify({ description: "count alpha files", prompt: "run ls" }))).toBe("count alpha files");
    expect(subagentTaskLine(JSON.stringify({ prompt: "run ls" }))).toBeUndefined();
    expect(subagentAskerLine("count alpha files")).toBe("count alpha files asks");
    // A prompt drawn in a thread that did not raise it names the thread that did, in the row grammar's two parts
    // under a middle dot, so it reads as one line of the same family as the asker line above it.
    expect(waitingAskerLine("read the file")).toBe("read the file asks; this thread waits on the answer");
  });

  it("has one deny line, the person's own, and it points the agent at no other access mode", () => {
    expect(PERMISSION_DENIED_LINE).toBe("the person denied this in the chat");
    for (const word of ["access", "bypass", "mode", "start the thread"]) expect(PERMISSION_DENIED_LINE).not.toContain(word);
  });

  it("what a thread says it is waiting on is the prompt row's own lead, worded in one place off the whole prompt", () => {
    const ask = { toolName: "Write", input: '{"file_path":"/root/out.txt","content":"hi"}', detail: "out.txt" };
    expect(askingLine(ask)).toBe(permissionAskLine(ask.toolName, ask.input, ask.detail));
    // The whole prompt is in hand, so the lead reads the call's own fields and not only the phrase the harness named.
    expect(askingLine(ask)).toContain("out.txt");
    const bare = { toolName: "mcp__wsp__workspaces", input: "{}", detail: undefined };
    expect(askingLine(bare)).toBe(permissionAskLine(bare.toolName, bare.input, bare.detail));
  });

  it("a mode option reads as an allow that also stops the asking, in the picker's own words for the mode", () => {
    expect(permissionModeOptionLabel("Accept edits")).toBe("Allow, then Accept edits");
  });

  it("the access menu says what a pick does to the turn running now, before the pick is made", () => {
    expect(accessReachLine(true)).toBe("Applies to the turn running now");
    expect(accessReachLine(false)).toBe("Applies from the thread's next turn");
    // Said of the pick, not of a failure: the line stands over the list before anything has been picked.
    for (const moves of [true, false]) expect(accessReachLine(moves)).not.toMatch(/could not|failed|unsupported/);
  });

  it("a pick a harness said it would take and then refused is a refusal in two halves, inside the slot's one line", () => {
    expect(ACCESS_REFUSED_WORDS.said).toBe("The turn refused it.");
    expect(ACCESS_REFUSED_WORDS.fix).toBe("The next turn runs at it.");
    expect(ACCESS_REFUSED_LINE).toBe(`${ACCESS_REFUSED_WORDS.said} ${ACCESS_REFUSED_WORDS.fix}`);
    // Both halves: what happened, then where the pick stands, which is the shape every refusal in this app has. A
    // message carries no access, so neither half may say one does.
    expect(ACCESS_REFUSED_WORDS.fix).toMatch(/next turn/);
    expect(ACCESS_REFUSED_LINE).not.toMatch(/message/);
    expect(accessReachLine(false)).not.toMatch(/message/);
    // The slot is one line that truncates from the right; the render test measures the paint, this holds the budget
    // the measurement was against, so the half carrying the answer is never the half that is cut.
    expect(ACCESS_REFUSED_LINE.length).toBeLessThan(54);
  });
});

describe("a desktop shell and the host that served it its page", () => {
  it("says nothing while the two are one release", () => {
    expect(shellVersionNotice("0.1.5", "0.1.5")).toBeUndefined();
  });

  it("names both numbers and points at the new app when the shell is the older half", () => {
    expect(shellVersionNotice("0.1.3", "0.1.5")).toEqual({ line: "this app is 0.1.3, the host is 0.1.5: get the new app", update: true });
  });

  it("names both numbers and asks for the app's own host when the host is the older half, with nothing to download", () => {
    expect(shellVersionNotice("0.1.5", "0.1.3")).toEqual({ line: "this app is 0.1.5, the host is 0.1.3: run the app's own host", update: false });
  });

  it("reads a shell whose bridge carries no version as older than the host, since every shell that has one says so", () => {
    expect(shellVersionNotice(undefined, "0.1.5")).toEqual({ line: "this app is older than the host, which is 0.1.5: get the new app", update: true });
  });

  it("reads the numbers as numbers, so 0.1.10 is after 0.1.9 rather than before it", () => {
    expect(shellVersionNotice("0.1.10", "0.1.9")?.update).toBe(false);
    expect(shellVersionNotice("0.1.9", "0.1.10")?.update).toBe(true);
  });

  it("puts a prerelease before the release it leads to, and a shorter number before a longer one that grows", () => {
    expect(shellVersionNotice("1.0.0-rc.1", "1.0.0")?.update).toBe(true);
    expect(shellVersionNotice("1.0.0", "1.0.0-rc.1")?.update).toBe(false);
    expect(shellVersionNotice("0.2", "0.2.1")?.update).toBe(true);
    expect(shellVersionNotice("0.2", "0.2.0")).toBeUndefined();
  });

  it("tells two prereleases of one release apart, whichever way their tails are spelled, so neither reads as silence", () => {
    expect(shellVersionNotice("0.1.6-alpha", "0.1.6-beta")).toEqual({ line: "this app is 0.1.6-alpha, the host is 0.1.6-beta: get the new app", update: true });
    expect(shellVersionNotice("0.1.6-beta", "0.1.6-alpha")?.update).toBe(false);
    expect(shellVersionNotice("0.1.6-rc1", "0.1.6-rc2")?.update).toBe(true);
    expect(shellVersionNotice("0.1.6-rc2", "0.1.6-rc1")?.update).toBe(false);
    expect(shellVersionNotice("0.1.6-rc1", "0.1.6")?.update).toBe(true);
    // A numbered tail counts as a number, so a tenth candidate is above a second and not below it.
    expect(shellVersionNotice("0.1.6-rc.2", "0.1.6-rc.10")?.update).toBe(true);
    // Build metadata carries no precedence, so two builds of one release say nothing.
    expect(shellVersionNotice("0.1.6+a1b2c3d", "0.1.6+9f8e7d6")).toBeUndefined();
  });
});

describe("the one listing of the hosts a computer can reach", () => {
  it("prints each host on the account with its beat, and marks the one every line takes", () => {
    const cells = hostsTable([
      { host: "macbook", address: "https://h1.singhi.me", awayMs: 12_000, connector: "2026.8.1", hostKey: "SHA256:aaa", deviceId: "d_1", default: true },
      { host: "attic", awayMs: null },
      { host: "box", address: "https://h2.singhi.me", deviceId: "d_2", hostKey: "SHA256:bbb" },
    ]);
    expect(cells[0]).toEqual(["HOST", "ADDRESS", "STATE", "DEVICE", "CONNECTOR", "KEY", ""]);
    expect(cells[1]).toEqual(["macbook", "https://h1.singhi.me", "up 12s", "d_1", "2026.8.1", "SHA256:aaa", "default"]);
    // A host on the account that has not said where it is: there is nothing to dial and the row says so.
    expect(cells[2]).toEqual(["attic", NOT_UP_YET, "not yet", "", "", "", ""]);
    // A row read off this computer's records while the relay did not answer says nothing of a beat, so its state is
    // left empty rather than read as away.
    expect(cells[3]).toEqual(["box", "https://h2.singhi.me", "", "d_2", "", "SHA256:bbb", ""]);
  });

  it("says a host that is beating with no address yet waits on its next start, so one row says one thing", () => {
    // A host on the account beating from a wsp from before it sent the key every dial holds it to: the address is
    // withheld until a beat carries the key, and the state column already calls it up.
    const cells = hostsTable([{ host: "attic", awayMs: 30_000, connector: "2026.7.1" }]);
    expect(cells[1]).toEqual(["attic", ADDRESS_NEXT_START, "up 30s", "", "2026.7.1", "", ""]);
    // A host that has never beaten is not up at all, and its row says that instead.
    expect(hostsTable([{ host: "attic", awayMs: null }])[1]![1]).toBe(NOT_UP_YET);
  });

  it("calls a host up inside two beats and away after them, since one missed beat is a slow minute", () => {
    expect(hostBeatWord(0)).toBe("up 1ms");
    expect(hostBeatWord(HOST_BEAT_MS)).toBe("up 1m");
    expect(hostBeatWord(2 * HOST_BEAT_MS)).toBe("up 2m");
    expect(hostBeatWord(2 * HOST_BEAT_MS + 1)).toBe("away 2 min");
    expect(hostBeatWord(6 * 60 * 60_000)).toBe("away 6 h");
    expect(hostBeatWord(null)).toBe("not yet");
  });

  it("says which key a host is pinned under when the account lists another, and names the line that frees it", () => {
    const said = hostKeyMovedLine("macbook", "SHA256:held", "SHA256:listed");
    expect(said).toContain("SHA256:held");
    expect(said).toContain("SHA256:listed");
    expect(said).toContain("wsp host pair");
    expect(said).toContain("wsp logout, wsp login and wsp hosts");
    expect(hostDroppedLine("attic")).toContain("attic");
    expect(relayQuietLine("the relay at https://r did not answer")).toContain("the rows below");
    expect(NO_HOSTS_LINE).toContain("wsp login");
    expect(NO_HOSTS_LINE).not.toContain("--code");
  });
});
