"use client";
import { AtlasSelect } from "./atlas-select";
import { useState } from "react";
import type { Account } from "@/lib/validation";
import { platforms, platformOf, type Provider } from "@/lib/platform-catalog";
import {
  KeyRound,
  WalletCards,
  PenLine,
  SlidersHorizontal,
} from "lucide-react";
import { Modal } from "./modal";
import { AccountWizard } from "./account-wizard";
import { BalanceUnitSelect } from "./balance-unit-select";
import { CustomQueryPreset } from "./custom-query-preset";
import { GroupSelect } from "./group-select";
import { QueryProfileSelect } from "./query-profile-select";
export type Send = <T = unknown>(
  path: string,
  method?: string,
  data?: unknown,
) => Promise<T>;
export function AccountForm(props: {
  groups?: string[];
  account: Account | null;
  open: boolean;
  onClose: () => void;
  onSaved: (account: Account) => void;
  send: Send;
}) {
  return props.account ? (
    <AccountEditor {...props} />
  ) : (
    <AccountWizard {...props} />
  );
}
function AccountEditor({
  groups = [],
  account,
  open,
  onClose,
  onSaved,
  send,
}: {
  groups?: string[];
  account: Account | null;
  open: boolean;
  onClose: () => void;
  onSaved: (account: Account) => void;
  send: Send;
}) {
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [provider, setProvider] = useState(account?.provider || "manual"),
    [confirmed, setConfirmed] = useState(!!account?.quotaPerUnit),
    [requestProfile, setRequestProfile] = useState(
      account?.query?.requestProfile || "atlas",
    ),
    [timeout, setTimeoutChoice] = useState(
      String(account?.query?.timeoutSeconds || 10),
    ),
    [authHeader, setAuthHeader] = useState(
      account?.query?.authHeader || "Authorization",
    ),
    [unit, setUnit] = useState(account?.unit || "USD"),
    [group, setGroup] = useState(account?.group || "未分组");
  const [extractionMode, setExtractionMode] = useState<"fields" | "usage">(
    account?.query?.extractionMode || "fields",
  );
  const platform = platformOf(provider),
    quotaBased = provider === "newapi" || provider === "newapi-token";
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    let f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) || "").trim();
    let input = {
      name: s("name"),
      alias: s("alias"),
      siteUrl: s("siteUrl"),
      apiUrl: s("apiUrl"),
      consoleUrl: s("consoleUrl"),
      rechargeUrl: s("rechargeUrl"),
      docsUrl: s("docsUrl"),
      group: s("group") || "未分组",
      tags: s("tags")
        .split(/[,，]/)
        .map((v) => v.trim())
        .filter(Boolean),
      notes: s("notes"),
      provider,
      unit: s("unit") || "USD",
      clearCredential: f.get("removeCredential") === "true",
      favorite: account?.favorite || false,
      archived: account?.archived || false,
      lowThreshold: s("threshold") || null,
      managementUrl: s("managementUrl"),
      userId: s("userId"),
      query: {
        ...(account?.query || {}),
        timeoutSeconds: Number(timeout),
        requestProfile,
        ...(provider === "custom"
          ? {
              extractionMode,
              path: s("queryPath"),
              ...(extractionMode === "fields"
                ? {
                    balancePath: s("balancePath"),
                    subtractPath: s("subtractPath"),
                    divisor: s("divisor") || "1",
                  }
                : {}),
              authHeader: s("authHeader") || "Authorization",
            }
          : {}),
      },
      quotaPerUnit: quotaBased && confirmed ? s("quotaPerUnit") || null : null,
      ...(s("credential") ? { credential: s("credential") } : {}),
    };
    try {
      const saved = await send<Account>(
        account ? `accounts/${account.id}` : "accounts",
        account ? "PATCH" : "POST",
        account
          ? { ...input, expectedUpdatedAt: account.updatedAt }
          : { ...input, initialBalance: s("initialBalance") || null },
      );
      onSaved(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const field = (
    name: string,
    label: string,
    value = "",
    placeholder = "",
    required = false,
    type = "text",
  ) => (
    <label className="field" key={name}>
      <span>
        {label}
        {required && <b> *</b>}
      </span>
      <input
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        required={required}
        type={type}
        maxLength={name === "credential" ? 4096 : 2048}
        autoComplete="off"
      />
    </label>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={account ? "编辑站点档案" : "添加一处站点"}
      description="同一个网站可以保存多个账号。余额未知时留空，不会被记作零。"
      wide
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          {field("name", "站点名称", account?.name, "例如：North API", true)}
          {field("alias", "账号别名", account?.alias, "例如：个人主账号")}
          {field(
            "siteUrl",
            "网站地址",
            account?.siteUrl,
            "https://example.com",
            true,
            "url",
          )}
          <GroupSelect
            groups={groups}
            value={group}
            onValueChange={setGroup}
            disabled={saving}
          />
          {field(
            "apiUrl",
            "API 地址",
            account?.apiUrl,
            "https://example.com/v1",
            false,
            "url",
          )}
          {field(
            "tags",
            "标签",
            account?.tags.join(", "),
            "多个标签用逗号分隔",
          )}
          <BalanceUnitSelect
            key={provider}
            provider={provider}
            value={unit}
            onValueChange={setUnit}
          />
          {field(
            "threshold",
            "低余额阈值（可选）",
            account?.lowThreshold || "",
            "留空则关闭提醒",
          )}
          {!account &&
            field("initialBalance", "初始余额（可选）", "", "未知就留空")}
          <label className="field">
            <span>记录方式</span>
            <AtlasSelect
              label="记录方式"
              value={provider}
              onValueChange={(value) => {
                setProvider(value as Provider);
                const next = platformOf(value as Provider);
                if (next.defaultUnit) setUnit(next.defaultUnit);
              }}
              options={platforms.map((p) => ({
                ...p,
                icon:
                  p.value === "manual" ? (
                    <PenLine size={16} />
                  ) : p.value === "custom" ? (
                    <SlidersHorizontal size={16} />
                  ) : p.group === "中转站" ? (
                    <KeyRound size={16} />
                  ) : (
                    <WalletCards size={16} />
                  ),
              }))}
            />
          </label>
        </div>
        <p className="hint">
          修改单位只影响之后的记录与查询，不换算已有余额；旧余额及历史保留原单位。
        </p>
        {provider !== "manual" && (
          <section className="connection-section">
            <h3>{platform.label}</h3>
            <p>
              {platform.description}
              。仅点击查询；保存后可在详情中测试连接，测试不改余额。
            </p>
            {provider === "siliconflow" && (
              <p className="form-error">
                SiliconFlow 官方 /user/info
                已停用。此模板只用于仍开放旧接口的兼容站点；官方账号请手动记录，或按新接口文档配置自定义查询。
              </p>
            )}
            {provider === "newapi-token" && (
              <p className="hint">
                令牌额度不等于账户余额，也不会加入 USD / CNY
                账户合计。无限额度令牌不写入数字余额。
              </p>
            )}
            <div className="form-grid">
              {field(
                "managementUrl",
                provider === "newapi" ? "管理接口根地址" : "余额接口根地址",
                account?.managementUrl,
                platform.root
                  ? `留空使用 ${platform.root}`
                  : "留空使用 API 地址或网站地址",
                false,
                "url",
              )}
              {provider === "newapi" &&
                field(
                  "userId",
                  "用户 ID（站点要求时必填）",
                  account?.userId,
                  "例如：123",
                )}
              {field(
                "credential",
                account?.hasCredential
                  ? "更换查询密钥（留空保留原凭据）"
                  : platform.credential || "查询密钥",
                "",
                "只加密保存于服务端",
                false,
                "password",
              )}
              <label className="field">
                <span>查询超时</span>
                <AtlasSelect
                  label="查询超时"
                  value={timeout}
                  onValueChange={setTimeoutChoice}
                  options={[
                    {
                      value: "10",
                      label: "10 秒",
                      description: "默认，快速失败",
                    },
                    {
                      value: "20",
                      label: "20 秒",
                      description: "适合连接较慢的站点",
                    },
                    {
                      value: "30",
                      label: "30 秒",
                      description: "最长等待，无自动重试",
                    },
                  ]}
                />
              </label>
              <QueryProfileSelect
                value={requestProfile}
                onValueChange={setRequestProfile}
              />
              {quotaBased &&
                field(
                  "quotaPerUnit",
                  "每单位对应的原始配额",
                  account?.quotaPerUnit || "",
                  "例如：500000",
                  confirmed,
                )}
            </div>
            {quotaBased && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已确认换算系数和余额单位
              </label>
            )}
            {quotaBased && !confirmed && (
              <p className="hint">
                未确认时只显示原始“配额”，不计入 USD / CNY 合计。
              </p>
            )}
            {provider === "custom" && (
              <>
                <CustomQueryPreset
                  value={extractionMode}
                  onChange={setExtractionMode}
                />
                <div className="form-grid query-mapping">
                  <div key={extractionMode}>
                    {field(
                      "queryPath",
                      "GET 查询路径",
                      extractionMode === "usage"
                        ? account?.query?.extractionMode === "usage"
                          ? account.query.path
                          : "/v1/usage"
                        : account?.query?.path || "/user/balance",
                      "例如：/api/wallet",
                      true,
                    )}
                  </div>
                  {extractionMode === "fields" && (
                    <>
                      {field(
                        "balancePath",
                        "余额字段路径",
                        account?.query?.balancePath || "balance",
                        "例如：data.balance",
                        true,
                      )}
                      {field(
                        "subtractPath",
                        "扣减字段（可选）",
                        account?.query?.subtractPath || "",
                        "例如：data.used",
                      )}
                      {field(
                        "divisor",
                        "结果除数",
                        account?.query?.divisor || "1",
                        "例如：100",
                        true,
                      )}
                    </>
                  )}
                  <label className="field">
                    <span>认证方式</span>
                    <AtlasSelect
                      label="认证方式"
                      value={authHeader}
                      onValueChange={(value) =>
                        setAuthHeader(value as typeof authHeader)
                      }
                      options={[
                        {
                          value: "Authorization",
                          label: "Bearer Token",
                          description: "Authorization: Bearer …",
                        },
                        {
                          value: "x-api-key",
                          label: "x-api-key",
                          description: "密钥放在 x-api-key 请求头",
                        },
                        {
                          value: "api-key",
                          label: "api-key",
                          description: "密钥放在 api-key 请求头",
                        },
                      ]}
                    />
                    <input type="hidden" name="authHeader" value={authHeader} />
                  </label>
                  <p className="hint">
                    只读取同源 GET 接口，支持 data.items.0.balance。结果
                    =（余额字段 − 可选扣减字段）÷ 除数；不执行脚本，不在 URL
                    内填密钥。
                  </p>
                </div>
              </>
            )}
            {provider === "custom" && extractionMode === "usage" && (
              <p className="hint">
                接口余额按响应单位记录；档案中的余额单位仅用于手动记录，不替换响应单位，不换汇。
              </p>
            )}
            {account?.hasCredential && (
              <label className="check-row">
                <input
                  name="clearCredential"
                  type="checkbox"
                  onChange={(e) => {
                    const hidden =
                      e.currentTarget.form?.querySelector<HTMLInputElement>(
                        'input[name="removeCredential"]',
                      );
                    if (hidden) hidden.value = String(e.target.checked);
                  }}
                />
                清除已保存的查询令牌
              </label>
            )}
            <input name="removeCredential" type="hidden" defaultValue="false" />
          </section>
        )}
        <details className="extra-fields">
          <summary>更多入口与备注</summary>
          <div className="form-grid">
            {field(
              "consoleUrl",
              "控制台地址",
              account?.consoleUrl,
              "默认打开网站地址",
              false,
              "url",
            )}
            {field(
              "rechargeUrl",
              "充值页地址",
              account?.rechargeUrl,
              "仅作为快捷入口",
              false,
              "url",
            )}
            {field(
              "docsUrl",
              "文档地址",
              account?.docsUrl,
              "https://…",
              false,
              "url",
            )}
            <label className="field field-full">
              <span>备注</span>
              <textarea
                name="notes"
                defaultValue={account?.notes}
                maxLength={2000}
                rows={3}
              />
            </label>
          </div>
        </details>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? "保存中…" : "保存站点"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function BalanceForm({
  account,
  open,
  onClose,
  onSaved,
  send,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  send: Send;
}) {
  let [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记录当前余额"
      description={`${account.name} · ${account.unit}。保存会新增历史快照，不会修改远端站点。`}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          let f = new FormData(e.currentTarget);
          try {
            await send(`accounts/${account.id}/balance`, "POST", {
              amount: String(f.get("amount") || "").trim(),
              note: String(f.get("note") || ""),
            });
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="field">
          <span>余额 / {account.unit}</span>
          <input
            name="amount"
            required
            inputMode="decimal"
            defaultValue={
              account.balanceUnit === account.unit ? account.balance || "" : ""
            }
            placeholder="例如：86.40"
            autoFocus
          />
        </label>
        <label className="field">
          <span>记录备注（可选）</span>
          <textarea
            name="note"
            rows={3}
            maxLength={2000}
            placeholder="例如：充值后核对 / 手动修正"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? "记录中…" : "保存记录"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
