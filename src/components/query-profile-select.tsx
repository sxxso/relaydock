"use client";
import { AtlasSelect } from "./atlas-select";
export function QueryProfileSelect({
  value,
  onValueChange,
}: {
  value?: "atlas" | "cc-switch";
  onValueChange: (value: "atlas" | "cc-switch") => void;
}) {
  return (
    <label className="field">
      <span>请求特征</span>
      <AtlasSelect
        label="请求特征"
        value={value || "atlas"}
        onValueChange={(v) => onValueChange(v as "atlas" | "cc-switch")}
        options={[
          {
            value: "atlas",
            label: "Atlas 默认",
            description: "RelayDock-Atlas/1.0 · Accept: application/json",
          },
          {
            value: "cc-switch",
            label: "CC Switch 模板请求头",
            description: "cc-switch/1.0 · Accept: */*；不改凭据或接口",
          },
        ]}
      />
      <small className="hint">
        仅改变白名单请求头，不会复制系统代理、浏览器 Cookie
        或绕过验证；保存后再点击测试。
      </small>
    </label>
  );
}
