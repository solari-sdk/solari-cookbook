// Adapted from pingdotgg/t3code apps/web/src/lib/diffCollapse.ts at 57a66608 (MIT).
export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

export function toggleAllDiffFiles(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? new Set() : new Set(fileKeys);
}
