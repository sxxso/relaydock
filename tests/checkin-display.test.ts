import { expect, it } from "vitest";
import { checkinReward, checkinRewardRange } from "../src/lib/checkin-display";

const usd = { quotaPerUnit: "10000", unit: "USD" };

it("shows converted reward first while retaining the original quota", () => {
  expect(checkinReward(12500, usd)).toEqual({ primary: "$1.25", raw: "12,500 配额", detail: "$1.25（原始 12,500 配额）", converted: true });
  expect(checkinReward(12500, { ...usd, unit: "CNY" }).primary).toBe("¥1.25");
  expect(checkinReward(12500, { ...usd, unit: "站点积分" }).primary).toBe("1.25 站点积分");
});

it("keeps unknown, actual zero, and positive subprecision rewards distinct", () => {
  expect(checkinReward(null, usd)).toEqual({ primary: "—", raw: "—", detail: "奖励未返回", converted: false });
  expect(checkinReward(0, usd).primary).toBe("$0");
  expect(checkinReward(0.001, usd).primary).toBe("<$0.000001");
  expect(checkinReward(1e-15, { quotaPerUnit: null, unit: "USD" }).primary).toBe("0.000000000000001 配额");
});

it("uses confirmed decimal conversion with up to six fractional digits", () => {
  expect(checkinReward(1, { ...usd, quotaPerUnit: "3" }).primary).toBe("$0.333333");
  expect(checkinReward(2, { ...usd, quotaPerUnit: "3" }).primary).toBe("$0.666667");
  expect(checkinReward(12.5, { ...usd, quotaPerUnit: "0.01" }).primary).toBe("$1,250");
  expect(checkinReward(1, { ...usd, quotaPerUnit: "1000000000000000000000000000000" }).primary).toBe("<$0.000001");
});

it("leaves rewards as labeled raw quota without a usable conversion", () => {
  for (const quotaPerUnit of [null, "", "0", "-1", "NaN", "Infinity"]) {
    expect(checkinReward(12500, { ...usd, quotaPerUnit })).toEqual({ primary: "12,500 配额", raw: "12,500 配额", detail: "12,500 配额（未设置有效配额换算）", converted: false });
  }
});

it("explains incomplete reward ranges without a meaningless unknown-to-unknown range", () => {
  expect(checkinRewardRange(null, null, usd)).toBe("未返回");
  expect(checkinRewardRange(0, null, usd)).toBe("下限 $0（原始 0 配额）");
  expect(checkinRewardRange(null, 12500, usd)).toBe("上限 $1.25（原始 12,500 配额）");
  expect(checkinRewardRange(0, 12500, usd)).toBe("$0（原始 0 配额） 至 $1.25（原始 12,500 配额）");
});
