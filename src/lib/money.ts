import Decimal from "decimal.js";
Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export function amount(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,24}(?:\.\d{1,12})?$/.test(value))
    throw new Error("请输入非负金额，最多 12 位小数");
  return new Decimal(value).toFixed();
}
type Monetary = {
  provider?: string;
  balance: string | null;
  unit: string;
  balanceUnit?: string;
  siteUrl: string;
  managementUrl?: string;
  quotaPerUnit?: string | null;
  archived: boolean;
  lowThreshold?: string | null;
};
export function tokenBalanceUnit(unit: string) {
  return unit === "配额"
    ? "令牌配额"
    : ["USD", "CNY"].includes(unit)
      ? `令牌额度 (${unit})`
      : unit;
}
export function unitKey(a: Monetary) {
  let u = a.balanceUnit || a.unit;
  if (a.provider === "newapi-token") u = tokenBalanceUnit(u);
  if (["USD", "CNY"].includes(u)) return u;
  let url = new URL(a.managementUrl || a.siteUrl);
  return `${u}::${url.origin}${url.pathname.replace(/\/$/, "")}::${a.quotaPerUnit || "raw"}`;
}
export function totals(accounts: Monetary[]) {
  let out: Record<string, string> = {};
  for (const a of accounts) {
    if (a.archived || a.balance === null) continue;
    let key = unitKey(a);
    out[key] = new Decimal(out[key] || "0").plus(a.balance).toFixed();
  }
  return out;
}
export function isLow(a: Monetary) {
  return (
    a.balance !== null &&
    a.lowThreshold != null &&
    (!a.balanceUnit ||
      a.balanceUnit ===
        (a.provider === "newapi-token" ? tokenBalanceUnit(a.unit) : a.unit)) &&
    new Decimal(a.balance).lte(a.lowThreshold)
  );
}
export function displayAmount(value: string | null, unit = "USD") {
  if (value === null) return "未记录";
  let n = new Decimal(value);
  let digits = n.decimalPlaces() > 2 ? Math.min(n.decimalPlaces(), 6) : 2;
  let [integer, fraction] = n.toFixed(digits).split(".");
  let formatted =
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? "." + fraction : "");
  return (unit === "USD" ? "$" : unit === "CNY" ? "¥" : "") + formatted;
}
