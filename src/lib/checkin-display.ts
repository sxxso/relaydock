import Decimal from "decimal.js";

const RewardDecimal = Decimal.clone({ precision: 50 });
type RewardConversion = { quotaPerUnit: string | null; unit: string };

function grouped(value: Decimal) {
  const [whole, fraction] = value.toFixed().split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

function withUnit(value: string, unit: string) {
  if (unit.toUpperCase() === "USD") return `$${value}`;
  if (unit.toUpperCase() === "CNY") return `¥${value}`;
  return `${value} ${unit}`;
}

/** Presentation only: never infer a conversion or change persisted quota. */
export function checkinReward(value: number | null, conversion: RewardConversion) {
  if (value === null) return { primary: "—", raw: "—", detail: "奖励未返回", converted: false };
  const quota = new RewardDecimal(value), raw = `${grouped(quota)} 配额`;
  let divisor: Decimal | null = null;
  try {
    if (conversion.quotaPerUnit) {
      const candidate = new RewardDecimal(conversion.quotaPerUnit);
      if (candidate.isFinite() && candidate.isPositive() && !candidate.isZero()) divisor = candidate;
    }
  } catch { /* Invalid conversion remains explicitly unconverted. */ }
  if (!divisor) return { primary: raw, raw, detail: `${raw}（未设置有效配额换算）`, converted: false };
  const amount = quota.div(divisor);
  // A positive reward smaller than our display precision must not look like zero.
  const primary = amount.isPositive() && !amount.isZero() && amount.lt("0.000001")
    ? `<${withUnit("0.000001", conversion.unit)}`
    : withUnit(grouped(amount.toDecimalPlaces(6, RewardDecimal.ROUND_HALF_UP)), conversion.unit);
  return { primary, raw, detail: `${primary}（原始 ${raw}）`, converted: true };
}

export function checkinRewardRange(min: number | null, max: number | null, conversion: RewardConversion) {
  if (min === null && max === null) return "未返回";
  if (max === null) return `下限 ${checkinReward(min, conversion).detail}`;
  if (min === null) return `上限 ${checkinReward(max, conversion).detail}`;
  if (min === max) return checkinReward(min, conversion).detail;
  return `${checkinReward(min, conversion).detail} 至 ${checkinReward(max, conversion).detail}`;
}
