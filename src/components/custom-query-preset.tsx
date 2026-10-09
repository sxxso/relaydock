"use client";
import { Braces, WalletCards } from "lucide-react";
import { AtlasSelect } from "./atlas-select";
export function CustomQueryPreset({
  value,
  onChange,
}: {
  value: "fields" | "usage";
  onChange: (value: "fields" | "usage") => void;
}) {
  return (
    <div className="custom-query-preset">
      <label className="field">
        <span>解析预设</span>
        <AtlasSelect
          label="解析预设"
          value={value}
          onValueChange={(v) => onChange(v as "fields" | "usage")}
          options={[
            {
              value: "fields",
              label: "自定义字段映射",
              description: "指定字段、可选扣减与换算除数",
              icon: <Braces size={16} />,
            },
            {
              value: "usage",
              label: "通用 /v1/usage",
              description: "候选余额字段 + 接口单位 + 账户有效状态",
              icon: <WalletCards size={16} />,
            },
          ]}
        />
      </label>
      {value === "usage" && (
        <p className="hint" data-testid="usage-preset-description">
          按 remaining → quota.remaining → balance 取首个非空值，保留 0；单位取
          unit → quota.unit → USD。is_active → isValid 首个非空状态必须为
          true。无需粘贴脚本，也不会执行 JavaScript。
        </p>
      )}
    </div>
  );
}
