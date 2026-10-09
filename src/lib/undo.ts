export type UndoRestore = {
  favorite?: boolean;
  archived?: boolean;
  group?: string;
  tags?: string[];
};

export type UndoEntry = {
  id: string;
  expectedUpdatedAt: string;
  restore: UndoRestore;
};

export function makeUndoEntry(
  id: string,
  expectedUpdatedAt: string,
  candidate: Record<string, unknown>,
): UndoEntry | null {
  const restore: UndoRestore = {};
  if (typeof candidate.favorite === "boolean") restore.favorite = candidate.favorite;
  if (typeof candidate.archived === "boolean") restore.archived = candidate.archived;
  if (typeof candidate.group === "string") restore.group = candidate.group;
  if (Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === "string"))
    restore.tags = [...candidate.tags] as string[];
  return Object.keys(restore).length
    ? { id, expectedUpdatedAt, restore }
    : null;
}

export function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
