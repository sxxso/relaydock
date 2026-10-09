import { expect, it } from "vitest";
import { parseCheckinStatus, parseCheckinReward, monthSchema, dateSchema } from "../src/lib/checkin";

const context = { accountId: "fixture", requestedMonth: "2026-10", quotaPerUnit: null, unit: "USD" };
const payload = (changes = {}) => ({ success: true, data: { enabled: true, min_quota: 10, max_quota: 20, stats: { checked_in_today: false, records: [{ checkin_date: "2026-10-01", quota_awarded: 10 }], checkin_count: 1, total_checkins: 9, total_quota: 90 }, ...changes } });
it("strictly validates real calendar months and dates", () => {
  expect(monthSchema.safeParse("2026-13").success).toBe(false);
  expect(dateSchema.safeParse("2026-02-29").success).toBe(false);
  expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
});
it("keeps monthly and all time statistics and unconverted quota separate", () => {
  expect(parseCheckinStatus(payload(), context)).toMatchObject({ state: "unsigned", month: "2026-10", monthCount: 1, totalCheckins: 9, totalQuota: 90, quotaPerUnit: null, records: [{ date: "2026-10-01", quotaAwarded: 10 }] });
});
it("deduplicates identical records but rejects inconsistencies and foreign month", () => {
  const p = payload(); p.data.stats.records.push(p.data.stats.records[0]);
  expect(parseCheckinStatus(p, context).records).toHaveLength(1);
  p.data.stats.records.push({ checkin_date: "2026-10-01", quota_awarded: 20 });
  expect(() => parseCheckinStatus(p, context)).toThrow();
  expect(() => parseCheckinStatus(payload(), { ...context, requestedMonth: "2026-09" })).toThrow();
});
it("refuses raw provider messages and malformed rewards", () => {
  expect(() => parseCheckinReward({ success: false, message: "secret" })).toThrow();
  expect(() => parseCheckinReward({ success: true, data: { checkin_date: "2026-02-30", quota_awarded: 1 } })).toThrow();
  expect(parseCheckinReward({ success: true, data: { checkin_date: "2026-10-08", quota_awarded: 20, message: "secret" } })).toEqual({ date: "2026-10-08", quotaAwarded: 20 });
});
