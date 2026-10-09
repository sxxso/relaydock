"use client";

import { useState } from "react";
import { CircleDollarSign, Coins, PencilLine } from "lucide-react";
import type { Provider } from "@/lib/platform-catalog";
import { AtlasSelect } from "./atlas-select";

const presets = ["USD", "CNY", "积分"];
const moneyOptions = [
  {
    value: "USD",
    label: "USD · 美元",
    description: "美元金额，不自动换汇",
    icon: <CircleDollarSign size={15} />,
    group: "货币",
  },
  {
    value: "CNY",
    label: "CNY · 人民币",
    description: "人民币金额，不自动换汇",
    icon: <CircleDollarSign size={15} />,
    group: "货币",
  },
];

/** Parent keys by provider, so a platform change resets the local custom choice. */
export function BalanceUnitSelect({
  provider,
  value,
  onValueChange,
}: {
  provider: Provider;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const fixedUnit =
    provider === "openrouter"
      ? "USD"
      : provider === "siliconflow"
        ? "CNY"
        : null;
  const moneyOnly = provider === "newapi-token" || provider === "deepseek";
  const [choice, setChoice] = useState(
    presets.includes(value) ? value : "custom",
  );
  const [customValue, setCustomValue] = useState(
    presets.includes(value) ? "" : value,
  );
  const options = fixedUnit
    ? moneyOptions.filter((o) => o.value === fixedUnit)
    : moneyOnly
      ? moneyOptions
      : [
          ...moneyOptions,
          {
            value: "积分",
            label: "积分",
            description: "站点内额度，不跨站汇总",
            icon: <Coins size={15} />,
            group: "非货币额度",
          },
          {
            value: "custom",
            label: "自定义单位",
            description: "填写调用次数、算力点等单位",
            icon: <PencilLine size={15} />,
            group: "非货币额度",
          },
        ];
  return (
    <>
      <div className="field">
        <span>余额单位</span>
        <AtlasSelect
          label="余额单位"
          disabled={!!fixedUnit}
          value={fixedUnit || choice}
          options={options}
          onValueChange={(next) => {
            setChoice(next);
            onValueChange(next === "custom" ? customValue : next);
          }}
        />
        {(fixedUnit || moneyOnly || choice !== "custom") && (
          <input type="hidden" name="unit" value={fixedUnit || value} />
        )}
        {fixedUnit && (
          <small className="hint">接口固定使用 {fixedUnit}，不可更改。</small>
        )}
        {moneyOnly && !["USD", "CNY"].includes(value) && (
          <small className="hint">
            当前单位「{value}」不在平台支持范围，请选择 USD 或
            CNY；旧记录不会换算。
          </small>
        )}
      </div>
      {!fixedUnit && !moneyOnly && choice === "custom" && (
        <label className="field">
          <span>自定义单位</span>
          <input
            name="unit"
            value={value}
            placeholder="例如：算力点、调用次数"
            required
            maxLength={16}
            onChange={(e) => {
              setCustomValue(e.target.value);
              onValueChange(e.target.value);
            }}
          />
        </label>
      )}
    </>
  );
}
