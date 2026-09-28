// Adapted from pingdotgg/t3code packages/client-runtime/src/work-log/presentation.ts at 57a66608 (MIT).
// Differs from upstream: the branded MCP tool label table is removed, and the tool-group summary and viewed-image helpers live in the adapter now.
import type { ToolLifecycleItemType, WorkLogTone } from "../components/chat/adapt";

export function isWorktreeSetupActivity(kind: string): boolean {
  return kind === "setup-script.requested" || kind === "setup-script.started";
}

export interface WorkLogPresentationEntry {
  readonly label: string;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly tone: WorkLogTone;
  readonly command?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: string;
  readonly turnId?: string | null;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: string;
  readonly sourceActivityKind?: string;
  readonly taskId?: string;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

export function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogPresentationEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}
