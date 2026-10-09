"use client";
import { Network, Route } from "lucide-react";
import type { QueryRouteMode, QueryRoutingStatus } from "@/lib/query-routing";
import "./query-route-switch.css";

export function QueryRouteSwitch({
  status,
  disabled,
  saving,
  onChange,
}: {
  status: QueryRoutingStatus | null;
  disabled: boolean;
  saving: boolean;
  onChange: (mode: QueryRouteMode) => void;
}) {
  const proxyHint = !status
    ? "正在读取线路设置"
    : !status.proxyConfigured
      ? "代理未配置，请到设置页查看配置说明"
      : !status.proxyValid
        ? "代理配置无效，请到设置页查看说明"
        : "使用部署端配置的代理；切换不会查询余额";
  return (
    <div
      className="query-route-switch"
      role="group"
      aria-label="查询线路"
      aria-busy={saving}
      data-testid="query-route-switch"
    >
      <span className="query-route-label">{saving ? "保存中" : "线路"}</span>
      <button
        type="button"
        aria-pressed={status?.mode === "direct"}
        disabled={disabled || !status}
        data-testid="query-route-direct"
        title="直接连接站点；切换不会查询余额"
        onClick={() => onChange("direct")}
      >
        <Route size={14} aria-hidden="true" />
        <span>直连</span>
      </button>
      <button
        type="button"
        aria-pressed={status?.mode === "proxy"}
        disabled={disabled || !status?.proxyValid}
        data-testid="query-route-proxy"
        title={proxyHint}
        onClick={() => onChange("proxy")}
      >
        <Network size={14} aria-hidden="true" />
        <span>代理</span>
      </button>
    </div>
  );
}
