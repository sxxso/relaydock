"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Download,
  Upload,
  Palette,
  Shield,
  Wind,
  KeyRound,
  Check,
  AlertCircle,
  Network,
} from "lucide-react";
import type { Account, Settings, Snapshot } from "@/lib/validation";
import { displayAmount } from "@/lib/money";
import type { Send } from "./account-form";
import { AtlasSelect } from "./atlas-select";
import {
  backgroundOptions,
  BackgroundGlyph,
  type MapBackground,
} from "./map-background";
import "./map-background.css";
import { QueryRouteSwitch } from "./query-route-switch";
import type { QueryRouteMode, QueryRoutingStatus } from "@/lib/query-routing";
import type { BackupStatus } from "@/lib/backup";
import { AppearanceTuning } from "./appearance-tuning";
export const localDate = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export function HistoryPage({
  accounts,
  send,
}: {
  accounts: Account[];
  send: Send;
}) {
  let [records, setRecords] = useState<Snapshot[]>([]),
    [accountId, setAccount] = useState(""),
    [range, setRange] = useState("all"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    send<{ snapshots: Snapshot[] }>("history")
      .then((r) => {
        setRecords(r.snapshots);
        setAccount(
          accounts.find((a) => r.snapshots.some((s) => s.accountId === a.id))
            ?.id || "",
        );
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [send]);
  let accountMap = useMemo(
      () => new Map(accounts.map((a) => [a.id, a])),
      [accounts],
    ),
    filtered = records.filter(
      (r) =>
        (!accountId || r.accountId === accountId) &&
        (range === "all" ||
          new Date(r.at).getTime() > Date.now() - Number(range) * 86400000),
    ),
    unit = filtered[0]?.unit,
    points = [...filtered]
      .reverse()
      .filter((s) => s.unit === unit)
      .map((s) => ({
        ...s,
        x: new Date(s.at).getTime(),
        value: Number(s.amount),
      }));
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <h1>余额留下的足迹</h1>
          <p>只呈现真实记录，不推算消费，也不预测未来。</p>
        </div>
        <span className="subtle-badge">{records.length} 条快照</span>
      </div>
      <div className="history-controls">
        <label>
          账号
          <AtlasSelect
            label="历史账号"
            value={accountId}
            onValueChange={setAccount}
            options={[
              { value: "", label: "全部账号（仅列表）" },
              ...accounts.map((a) => ({
                value: a.id,
                label: a.name + (a.alias ? " / " + a.alias : ""),
              })),
            ]}
          />
        </label>
        <label>
          时间
          <AtlasSelect
            label="历史时间"
            value={range}
            onValueChange={setRange}
            options={[
              { value: "all", label: "全部记录" },
              { value: "7", label: "最近 7 天" },
              { value: "30", label: "最近 30 天" },
            ]}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="empty-note">读取记录中…</p>
      ) : records.length === 0 ? (
        <div className="empty-state">
          <Wind size={32} />
          <h2>第一条记录，等你落笔</h2>
          <p>在站点详情中记录余额，或手动发起接口同步。</p>
        </div>
      ) : (
        <>
          {accountId && (
            <div className="history-chart">
              <div className="section-heading">
                <h2>{accountMap.get(accountId)?.name} 的余额</h2>
                <span>{unit} · 按实际记录时刻绘制</span>
              </div>
              {points.length > 1 ? (
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart
                    data={points}
                    margin={{ top: 16, right: 20, left: 8, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="history-fill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0"
                          stopColor="var(--accent)"
                          stopOpacity={0.19}
                        />
                        <stop
                          offset="1"
                          stopColor="var(--accent)"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--line)" />
                    <XAxis
                      dataKey="x"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(v) =>
                        localDate(new Date(v).toISOString()).split(" ")[0]
                      }
                      stroke="var(--muted)"
                      tick={{ fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      width={60}
                      stroke="var(--muted)"
                      tick={{ fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      content={({ active, payload }) =>
                        active && payload?.[0] ? (
                          <div className="chart-tooltip">
                            <strong>
                              {displayAmount(payload[0].payload.amount, unit)}
                            </strong>
                            <span>{localDate(payload[0].payload.at)}</span>
                          </div>
                        ) : null
                      }
                    />
                    <Area
                      type="linear"
                      dataKey="value"
                      stroke="var(--accent)"
                      fill="url(#history-fill)"
                      strokeWidth={2}
                      dot={{ r: 3, fill: "var(--accent)" }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="single-point">
                  <strong>
                    {points[0]
                      ? displayAmount(points[0].amount, unit)
                      : "暂无记录"}
                  </strong>
                  <p>再记录一次，就能看见变化。不会为一条记录生成曲线。</p>
                </div>
              )}
            </div>
          )}
          <div className="table-scroll">
            <table className="records-table">
              <thead>
                <tr>
                  <th>站点账号</th>
                  <th>记录时间</th>
                  <th className="align-right">余额</th>
                  <th>来源</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {accountMap.get(r.accountId)?.name || "未知账号"}
                      <small>{accountMap.get(r.accountId)?.alias}</small>
                    </td>
                    <td>{localDate(r.at)}</td>
                    <td className="align-right amount-cell">
                      {displayAmount(r.amount, r.unit)} <small>{r.unit}</small>
                    </td>
                    <td>
                      <span className="subtle-badge">
                        {r.source === "manual" ? "手动记录" : "接口同步"}
                      </span>
                    </td>
                    <td>{r.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="empty-note">这个时间范围内还没有记录。</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
export function SettingsPage({
  settings,
  onSettings,
  appearanceBusy,
  queryRouting,
  routingBusy,
  queryBusy,
  onQueryRoute,
  send,
  onImported,
  onLogout,
  notify,
}: {
  settings: Settings;
  onSettings: (s: Settings) => Promise<void>;
  appearanceBusy: boolean;
  queryRouting: QueryRoutingStatus | null;
  routingBusy: boolean;
  queryBusy: boolean;
  onQueryRoute: (mode: QueryRouteMode) => void;
  send: Send;
  onImported: () => void;
  onLogout: () => void;
  notify: (s: string) => void;
}) {
  let [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [backup, setBackup] = useState<unknown>(null),
    [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null),
    [preview, setPreview] = useState<{
      accounts: number;
      snapshots: number;
      newAccounts: number;
      updatedAccounts: number;
    } | null>(null);
  useEffect(() => {
    let active = true;
    void send<BackupStatus>("backup/status")
      .then((status) => {
        if (active) setBackupStatus(status);
      })
      .catch(() => {
        // The backup panel remains useful if an older server has no status endpoint.
      });
    return () => {
      active = false;
    };
  }, [send]);
  async function update(s: Settings) {
    await onSettings(s);
  }
  async function exportFile() {
    try {
      let b = await send<{ exportedAt: string }>("backup/export");
      setBackupStatus({ lastDataBackupExportAt: b.exportedAt });
      let blob = new Blob([JSON.stringify(b, null, 2)], {
          type: "application/json",
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `atlas-backup-${new Date().toLocaleDateString("sv-SE")}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      notify("备份已导出，不包含查询令牌或密码");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <section className="page-content settings-page">
      <div className="page-heading">
        <div>
          <h1>让群岛适合你</h1>
          <p>数据留在你的部署中，节奏由你决定。</p>
        </div>
      </div>
      <section
        className="settings-section"
        data-testid="query-routing-settings"
      >
        <div className="settings-label">
          <Network size={20} />
          <div>
            <h2>查询线路</h2>
            <p>直连或代理，只在你点击时出发。</p>
          </div>
        </div>
        <div className="settings-body">
          <QueryRouteSwitch
            status={queryRouting}
            saving={routingBusy}
            disabled={routingBusy || queryBusy}
            onChange={onQueryRoute}
          />
          <p className="query-route-help">
            选择会保存，切换立即生效，不会自动查询余额；查询期间暂时锁定切换。地图、列表、连接测试和批量刷新共用此线路。
          </p>
          {queryRouting && (
            <p
              className={
                "query-route-help" +
                (!queryRouting.proxyValid ? " query-route-warning" : "")
              }
              role="status"
            >
              {!queryRouting.proxyConfigured
                ? "代理未配置。"
                : !queryRouting.proxyValid
                  ? "代理配置无效。"
                  : "代理已配置（配置格式有效，不代表网络已连通）。"}
              {queryRouting.mode === "proxy" &&
                !queryRouting.proxyValid &&
                " 当前代理线路无法查询，请检查配置或手动切换直连；不会自动回退。"}
            </p>
          )}
          <p className="query-route-help">
            代理地址仍只在部署端设置：
            <code>RELAYDOCK_QUERY_PROXY_URL=http://127.0.0.1:7890</code>
            （示例端口，使用实际
            HTTP／混合端口）。初次配置或改地址后须重启服务；之后切换线路无需重启。不会自动使用系统代理，也不会启动代理软件。
          </p>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label">
          <Palette size={20} />
          <div>
            <h2>外观与动效</h2>
            <p>暖纸面，也有安静的夜间版本。</p>
          </div>
        </div>
        <div className="settings-body">
          <div
            className="theme-options"
            role="radiogroup"
            aria-label="界面主题"
          >
            {(
              [
                { value: "light", name: "暖纸面" },
                { value: "dark", name: "夜墨色" },
                { value: "system", name: "跟随系统" },
              ] as const
            ).map((t) => (
              <label
                key={t.value}
                className={
                  "theme-option theme-" +
                  t.value +
                  (settings.theme === t.value ? " active" : "")
                }
              >
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={settings.theme === t.value}
                  disabled={appearanceBusy}
                  onChange={() => update({ ...settings, theme: t.value })}
                />
                <span className="theme-swatch">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{t.name}</span>
                {settings.theme === t.value && <Check size={14} />}
              </label>
            ))}
          </div>
          <div className="background-setting">
            <div>
              <strong>地图底图</strong>
              <small>
                随镜头平移的静态纹理，不增加动画循环。地图右上角也能直接切换。
              </small>
            </div>
            <AtlasSelect
              label="地图底图"
              value={settings.mapBackground || "dots"}
              onValueChange={(value) =>
                update({ ...settings, mapBackground: value as MapBackground })
              }
              disabled={appearanceBusy}
              options={backgroundOptions.map((p) => ({
                ...p,
                icon: <BackgroundGlyph kind={p.value} />,
              }))}
            />
          </div>
          <label className="switch-row">
            <span>
              <strong>装饰动效</strong>
              <small>
                主题揭幕、菜单与操作反馈、墨岛擦显。减少动效时自动简化；触屏关闭擦显。
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="装饰动效"
              checked={settings.motion}
              disabled={appearanceBusy}
              onChange={(e) =>
                update({ ...settings, motion: e.target.checked })
              }
            />
          </label>
          <AppearanceTuning settings={settings} busy={appearanceBusy} onSave={update} />
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label">
          <Shield size={20} />
          <div>
            <h2>数据与备份</h2>
            <p>凭据不进入 JSON 备份。</p>
          </div>
        </div>
        <div className="settings-body backup-experience" data-testid="backup-experience">
          <div className="backup-experience-grid">
            <article className="backup-card">
              <h3>数据备份</h3>
                <p>导出 JSON，可用于在应用内预览和导入站点档案、余额历史、分组颜色、保存视图与外观偏好。</p>
              <strong>不含凭据、管理员密码或主密钥。</strong>
              <span>换机器导入后，新账号需要重新填写凭据。</span>
            </article>
            <article className="backup-card backup-card-migration">
              <h3>完整迁移</h3>
              <p>要完整恢复查询配置和已保存凭据，还需要同一部署的数据库与主密钥文件。</p>
              <strong>还需备份 data/atlas.sqlite 与 data/vault.key。</strong>
              <span>JSON 备份不能单独恢复加密凭据；数据库与主密钥必须来自同一份部署。</span>
            </article>
          </div>
          <p className="backup-last-export" data-testid="last-data-backup-export" aria-live="polite">
            最近数据备份导出：{backupStatus?.lastDataBackupExportAt ? localDate(backupStatus.lastDataBackupExportAt) : "尚未导出"}
          </p>
          <p className="body-note">
            导出包含站点档案、余额历史与外观偏好。加密令牌和管理员密码不包含在内，换机器后需要重新填写令牌。
          </p>
          <div className="button-row">
            <button className="button" onClick={exportFile}>
              <Download size={16} />
              导出 JSON 备份
            </button>
            <label className="button file-button">
              <Upload size={16} />
              选择备份文件
              <input
                type="file"
                accept=".json,application/json"
                onChange={async (e) => {
                  let f = e.target.files?.[0];
                  if (!f) return;
                  setError("");
                  setPreview(null);
                  setBackup(null);
                  try {
                    if (f.size > 8 * 1024 * 1024)
                      throw new Error("备份文件不能超过 8 MB");
                    let data = JSON.parse(await f.text());
                    let result = await send<typeof preview>(
                      "backup/import",
                      "POST",
                      { backup: data, preview: true },
                    );
                    setBackup(data);
                    setPreview(result);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {preview && (
            <div className="import-preview">
              <h3>导入预览</h3>
              <p>
                新增 {preview.newAccounts} 个账号，更新{" "}
                {preview.updatedAccounts} 个账号，合并 {preview.snapshots}{" "}
                条快照。
              </p>
              <p>不会删除现有账号；已有凭据保留，新账号需重新填写。</p>
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={pending}
                  onClick={async () => {
                    setPending(true);
                    try {
                      await send("backup/import", "POST", {
                        backup,
                        preview: false,
                      });
                      setPreview(null);
                      setBackup(null);
                      onImported();
                      notify("备份已导入");
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  {pending ? "导入中…" : "确认导入"}
                </button>
                <button
                  className="button"
                  onClick={() => {
                    setPreview(null);
                    setBackup(null);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              <AlertCircle size={15} />
              {error}
            </p>
          )}
          <p className="hint">
            数据备份和完整迁移是两件事：JSON 只负责非敏感数据；完整迁移还需要安全保存数据库与主密钥。
          </p>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label">
          <KeyRound size={20} />
          <div>
            <h2>管理员密码</h2>
            <p>修改后所有会话退出。</p>
          </div>
        </div>
        <form
          className="settings-body password-form"
          onSubmit={async (e) => {
            e.preventDefault();
            let form = e.currentTarget,
              f = new FormData(form);
            try {
              await send("auth/password", "POST", {
                current: f.get("current"),
                password: f.get("password"),
              });
              form.reset();
              notify("密码已修改，请重新登录");
              onLogout();
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <label className="field">
            <span>当前密码</span>
            <input
              name="current"
              required
              type="password"
              autoComplete="current-password"
            />
          </label>
          <label className="field">
            <span>新密码，至少 12 个字符</span>
            <input
              name="password"
              required
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <button className="button" type="submit">
            更新密码
          </button>
        </form>
      </section>
      <div className="deployment-note">
        <span className="quiet-dot" />
        <p>
          <strong>单管理员 · 自托管 · 手动查询</strong>
          <br />
          不运行定时同步，无遥测。站点内容由你自行核实。
        </p>
      </div>
    </section>
  );
}
