import type { Account } from "./validation";
import { compareRecordedAt } from "./balance-freshness";
import { isLow, unitKey } from "./money";
import { matchesSearch } from "./map-management";
import type { SavedViewFilters } from "./saved-views";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function isOlderThanSevenDays(
  account: Pick<Account, "lastSnapshotAt">,
  now = Date.now(),
) {
  if (!account.lastSnapshotAt) return true;
  const recordedAt = Date.parse(account.lastSnapshotAt);
  if (!Number.isFinite(recordedAt) || !Number.isFinite(now)) return true;
  return now - recordedAt >= SEVEN_DAYS_MS;
}

export function filterAccounts(
  accounts: readonly Account[],
  filters: SavedViewFilters,
  now = Date.now(),
) {
  return accounts
    .filter((account) => {
      return (
        matchesSearch(account, filters.search) &&
        (filters.group === "all" || (account.group || "未分组") === filters.group) &&
        (filters.currency === "all" || unitKey(account) === filters.currency) &&
        (!filters.favorites || account.favorite) &&
        (!filters.onlyLow || isLow(account)) &&
        (filters.archive === "all" ||
          account.archived === (filters.archive === "archived")) &&
        (filters.recordAge === "any" || isOlderThanSevenDays(account, now))
      );
    })
    .sort((a, b) =>
      filters.sort === "recent"
        ? compareRecordedAt(a, b)
        : filters.sort === "favorite"
          ? Number(b.favorite) - Number(a.favorite) ||
            a.name.localeCompare(b.name, "zh")
          : a.name.localeCompare(b.name, "zh") ||
            a.alias.localeCompare(b.alias, "zh"),
    );
}

export function hasAccountFilters(filters: SavedViewFilters) {
  return (
    !!filters.search.trim() ||
    filters.group !== "all" ||
    filters.currency !== "all" ||
    filters.favorites ||
    filters.onlyLow ||
    filters.recordAge !== "any"
  );
}
