// Adapted from pingdotgg/t3code apps/web/src/types.ts and apps/web/src/terminalUiStateStore.ts at 57a66608 (MIT).
// The drawer's tab and split model as pure transitions: which terminals a
// workspace shows, which one is active, and how they are grouped into splits.
// The terminal ids themselves come from the daemon link; this only arranges them.

export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const MAX_TERMINALS_PER_GROUP = 4;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection?: "horizontal" | "vertical";
}

export interface TerminalUiState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    normalizedIds.push(trimmedId);
  }
  return normalizedIds;
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) {
    return [];
  }

  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? terminalIds[0] ?? "");
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (
      (leftGroup.splitDirection ?? "horizontal") !== (rightGroup.splitDirection ?? "horizontal")
    ) {
      return false;
    }
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function terminalUiStateEqual(left: TerminalUiState, right: TerminalUiState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

export const DEFAULT_TERMINAL_UI_STATE: TerminalUiState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [],
  activeTerminalId: "",
  terminalGroups: [],
  activeTerminalGroupId: "",
});

function createDefaultTerminalUiState(): TerminalUiState {
  return { ...DEFAULT_TERMINAL_UI_STATE, terminalIds: [], terminalGroups: [] };
}

export function normalizeTerminalUiState(state: TerminalUiState): TerminalUiState {
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: TerminalUiState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ?? activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  };
  return terminalUiStateEqual(state, normalized) ? state : normalized;
}

export function isDefaultTerminalUiState(state: TerminalUiState): boolean {
  return terminalUiStateEqual(normalizeTerminalUiState(state), DEFAULT_TERMINAL_UI_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
  }));
}

function upsertTerminalIntoGroups(
  state: TerminalUiState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: "horizontal" | "vertical" = "horizontal",
): TerminalUiState {
  const normalized = normalizeTerminalUiState(state);
  const effectiveMode: "split" | "new" = normalized.terminalIds.length === 0 ? "new" : mode;
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (effectiveMode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeTerminalUiState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIdSet = new Set(destinationGroup.terminalIds);

  if (
    isNewTerminal &&
    !destinationTerminalIdSet.has(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationTerminalIdSet.has(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }
  if (splitDirection === "vertical") {
    destinationGroup.splitDirection = "vertical";
  } else {
    delete destinationGroup.splitDirection;
  }

  return normalizeTerminalUiState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

export function setTerminalOpen(state: TerminalUiState, open: boolean): TerminalUiState {
  const normalized = normalizeTerminalUiState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

export function setTerminalHeight(state: TerminalUiState, height: number): TerminalUiState {
  const normalized = normalizeTerminalUiState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

export function splitTerminal(
  state: TerminalUiState,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): TerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split", direction);
}

export function newTerminal(state: TerminalUiState, terminalId: string): TerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

export function setActiveTerminal(state: TerminalUiState, terminalId: string): TerminalUiState {
  const normalized = normalizeTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

export function closeTerminal(state: TerminalUiState, terminalId: string): TerminalUiState {
  const normalized = normalizeTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return { ...createDefaultTerminalUiState(), terminalHeight: normalized.terminalHeight };
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        "")
      : normalized.activeTerminalId;

  const terminalGroups: ThreadTerminalGroup[] = [];
  for (const group of normalized.terminalGroups) {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length > 0) {
      terminalGroups.push({ ...group, terminalIds });
    }
  }

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeTerminalUiState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

/** The daemon link's pty list is the truth for which terminals exist; the arrangement follows it. */
export function reconcileTerminalIds(state: TerminalUiState, nextIds: string[]): TerminalUiState {
  const normalized = normalizeTerminalUiState(state);
  if (arraysEqual(normalized.terminalIds, nextIds)) {
    return normalized;
  }

  const nextActiveTerminalId = nextIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (nextIds[0] ?? "");

  const terminalGroups = normalizeTerminalGroups(normalized.terminalGroups, nextIds);
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ?? null;

  return normalizeTerminalUiState({
    ...normalized,
    terminalIds: nextIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromTerminal ??
      (terminalGroups.some((group) => group.id === normalized.activeTerminalGroupId)
        ? normalized.activeTerminalGroupId
        : (terminalGroups[0]?.id ?? "")),
  });
}
