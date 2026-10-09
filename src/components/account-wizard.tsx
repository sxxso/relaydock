"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  KeyRound,
  PenLine,
  ShieldCheck,
  SlidersHorizontal,
  WalletCards,
} from "lucide-react";
import { platforms, platformOf, type Provider } from "@/lib/platform-catalog";
import {
  newWizardDraft,
  quotaProvider,
  wizardPreview,
  wizardQueryInput,
  wizardSaveInput,
  wizardStepError,
  wizardUnit,
  wizardCloseAllowed,
  type TestBalance,
  type WizardDraft,
} from "@/lib/account-wizard";
import {
  normalizeDiagnostic,
  type QueryDiagnostic,
} from "@/lib/query-diagnostics";
import type { Send } from "./account-form";
import { AtlasSelect } from "./atlas-select";
import { CustomQueryPreset } from "./custom-query-preset";
import { Modal } from "./modal";
import { QueryDiagnosticPanel } from "./query-diagnostic";
import "./account-wizard.css";
import { GroupSelect } from "./group-select";
import { QueryProfileSelect } from "./query-profile-select";
import type { Account } from "@/lib/validation";

const steps = ["平台", "地址与凭据", "点击测试", "确认单位", "保存"];
const groups = [...new Set(platforms.map((p) => p.group))];
const scope = (p: Provider) =>
  p === "manual"
    ? "手动记录"
    : p === "newapi-token"
      ? "单个令牌额度"
      : ["generic", "custom"].includes(p)
        ? "由接口定义的余额"
        : "账户余额";
type Tested = { key: string; result: TestBalance; diagnostic: QueryDiagnostic };

export function AccountWizard({
  groups: savedGroups = [],
  open,
  onClose,
  onSaved,
  send,
}: {
  groups?: string[];
  open: boolean;
  onClose: () => void;
  onSaved: (account: Account) => void;
  send: Send;
}) {
  const [draft, setDraft] = useState(newWizardDraft),
    [step, setStep] = useState(1),
    [visited, setVisited] = useState(1);
  const [error, setError] = useState(""),
    [testing, setTesting] = useState(false),
    [saving, setSaving] = useState(false);
  const [tested, setTested] = useState<Tested | null>(null),
    [diagnostic, setDiagnostic] = useState<QueryDiagnostic | null>(null);
  const id = useId(),
    heading = useRef<HTMLHeadingElement>(null),
    queryLock = useRef(false),
    saveLock = useRef(false),
    alive = useRef(true);
  const platform = platformOf(draft.provider),
    quota = quotaProvider(draft.provider),
    busy = testing || saving;
  // This fingerprint never leaves component memory. It is not logged or persisted.
  const key = JSON.stringify(wizardQueryInput(draft));
  const verified = tested?.key === key;
  const preview =
    verified && tested ? wizardPreview(draft, tested.result) : null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, [step]);

  function update(patch: Partial<WizardDraft>) {
    let next = { ...draft, ...patch };
    const queryChanged = JSON.stringify(wizardQueryInput(next)) !== key;
    if (queryChanged) {
      setTested(null);
      setDiagnostic(null);
      next.unverifiedAccepted = false;
    }
    if (
      queryChanged ||
      next.unit !== draft.unit ||
      next.conversionConfirmed !== draft.conversionConfirmed ||
      next.quotaPerUnit !== draft.quotaPerUnit
    )
      next.unitConfirmed = false;
    setDraft(next);
    setError("");
  }
  function choosePlatform(provider: Provider) {
    if (provider === draft.provider) return;
    update({
      provider,
      credential: "",
      managementUrl: "",
      apiUrl: "",
      userId: "",
      query: newWizardDraft().query,
      unit: platformOf(provider).defaultUnit || "USD",
      quotaPerUnit: "",
      conversionConfirmed: false,
      unitConfirmed: false,
      unverifiedAccepted: false,
    });
  }
  function navigate(next: number) {
    if (!busy) {
      setError("");
      setStep(next);
    }
  }
  function advance() {
    if (busy) return;
    const message = wizardStepError(draft, step, verified);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setVisited((v) => Math.max(v, step + 1));
    setStep((s) => Math.min(5, s + 1));
  }
  async function test() {
    if (queryLock.current || busy || draft.provider === "manual") return;
    const message = wizardStepError(draft, 2, false);
    if (message) {
      setError(message);
      return;
    }
    queryLock.current = true;
    setTesting(true);
    setError("");
    setTested(null);
    setDiagnostic(null);
    setDraft((d) => ({ ...d, unverifiedAccepted: false }));
    try {
      const response = await send<
        TestBalance & { diagnostic: QueryDiagnostic }
      >("query/test", "POST", wizardQueryInput(draft));
      if (!alive.current) return;
      const d = normalizeDiagnostic(response.diagnostic);
      if (!d || d.outcome !== "success")
        throw new Error("测试结果无效，请重新点击测试");
      setDiagnostic(d);
      setTested({
        key,
        result: {
          balance: response.balance,
          unit: response.unit,
          rawQuota: response.rawQuota,
        },
        diagnostic: d,
      });
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "测试未完成，请检查本机连接");
      setDiagnostic(
        normalizeDiagnostic((e as { diagnostic?: unknown })?.diagnostic),
      );
    } finally {
      queryLock.current = false;
      if (alive.current) setTesting(false);
    }
  }
  async function save() {
    if (saveLock.current || busy) return;
    const message = wizardStepError(draft, 5, verified);
    if (message) {
      setError(message);
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      const account = await send<Account>(
        "accounts",
        "POST",
        wizardSaveInput(draft),
      );
      if (alive.current) {
        onSaved(account);
        onClose();
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "保存失败，请检查本机服务");
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }
  const field = (
    name: keyof WizardDraft,
    label: string,
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
        type={type}
        value={String(draft[name])}
        onChange={(e) => update({ [name]: e.target.value })}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        maxLength={
          name === "credential"
            ? 4096
            : name === "name" || name === "alias"
              ? 80
              : name === "group"
                ? 40
                : 2048
        }
      />
    </label>
  );
  const queryField = (
    name: "path" | "balancePath" | "subtractPath" | "divisor",
    label: string,
    placeholder: string,
    required = false,
  ) => (
    <label className="field">
      <span>
        {label}
        {required && <b> *</b>}
      </span>
      <input
        value={draft.query[name]}
        onChange={(e) =>
          update({ query: { ...draft.query, [name]: e.target.value } })
        }
        placeholder={placeholder}
        autoComplete="off"
        required={required}
        maxLength={name === "path" ? 256 : 120}
      />
    </label>
  );
  const moneyOptions = [
    { value: "USD", label: "USD", description: "美元，不自动换汇" },
    { value: "CNY", label: "CNY", description: "人民币，不自动换汇" },
  ];
  const fixedUnit =
    draft.provider === "openrouter" || draft.provider === "siliconflow";

  return (
    <Modal
      open={open}
      onClose={() => {
        if (wizardCloseAllowed(queryLock.current, saveLock.current)) onClose();
      }}
      title="添加一处站点"
      description="逐步确认查询口径。草稿测试不落库，保存不会自动查询。"
      wide
      closeDisabled={busy}
    >
      <form
        className="account-wizard"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 5) void save();
          else advance();
        }}
      >
        <ol className="wizard-progress" aria-label="配置进度">
          {steps.map((label, i) => (
            <li
              key={label}
              data-current={step === i + 1}
              data-visited={visited >= i + 1}
            >
              <button
                type="button"
                aria-label={`${i + 1} ${label}`}
                aria-current={step === i + 1 ? "step" : undefined}
                disabled={busy || i + 1 > visited}
                onClick={() => navigate(i + 1)}
              >
                <span className="wizard-step-number">
                  {i + 1 < step ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ol>
        <fieldset className="wizard-fields" disabled={busy}>
          <section
            key={step}
            className="wizard-step"
            aria-labelledby={`${id}-heading`}
          >
            <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
              {
                [
                  "选择查询口径",
                  "地址与凭据",
                  "点击测试，不记录余额",
                  "确认余额单位",
                  "确认并保存",
                ][step - 1]
              }
            </h3>
            {step === 1 && (
              <>
                <p className="wizard-lead">
                  同一个站点可能有多个查询口径，请主动选择，不根据域名猜测。
                </p>
                <fieldset className="wizard-platforms">
                  <legend className="sr-only">选择平台</legend>
                  {groups.map((group) => (
                    <div className="wizard-platform-group" key={group}>
                      <h4>{group}</h4>
                      <div className="wizard-platform-options">
                        {platforms
                          .filter((p) => p.group === group)
                          .map((p) => (
                            <label
                              key={p.value}
                              className="wizard-platform"
                              data-selected={draft.provider === p.value}
                            >
                              <input
                                type="radio"
                                name="platform"
                                value={p.value}
                                checked={draft.provider === p.value}
                                onChange={() => choosePlatform(p.value)}
                                aria-label={p.label}
                                aria-describedby={`${id}-${p.value}`}
                              />
                              <span
                                className="wizard-platform-icon"
                                aria-hidden="true"
                              >
                                {p.value === "manual" ? (
                                  <PenLine size={18} />
                                ) : p.value === "custom" ? (
                                  <SlidersHorizontal size={18} />
                                ) : p.value.startsWith("newapi") ? (
                                  <KeyRound size={18} />
                                ) : (
                                  <WalletCards size={18} />
                                )}
                              </span>
                              <span className="wizard-platform-copy">
                                <strong>{p.label}</strong>
                                <small id={`${id}-${p.value}`}>
                                  {p.description}
                                </small>
                              </span>
                              <Check
                                className="wizard-platform-check"
                                size={15}
                                aria-hidden="true"
                              />
                            </label>
                          ))}
                      </div>
                    </div>
                  ))}
                </fieldset>
              </>
            )}
            {step === 2 && (
              <>
                <p className="wizard-lead">
                  {platform.label}。{platform.description}。
                </p>
                <div className="form-grid">
                  {field("name", "站点名称", "例如：North API", true)}
                  {field("alias", "账号别名", "同站点可以保存多个账号")}
                  {field(
                    "siteUrl",
                    "网站地址",
                    "https://example.com",
                    true,
                    "url",
                  )}
                  {draft.provider !== "manual" &&
                    field(
                      "managementUrl",
                      draft.provider === "newapi"
                        ? "管理接口根地址"
                        : "余额接口根地址",
                      platform.root
                        ? `留空使用 ${platform.root}`
                        : "留空使用 API 地址或网站地址",
                      false,
                      "url",
                    )}
                  {draft.provider !== "manual" &&
                    field(
                      "credential",
                      platform.credential || "查询密钥",
                      "可稍后补充；仅在服务端加密保存",
                      false,
                      "password",
                    )}
                  {draft.provider === "newapi" &&
                    field("userId", "用户 ID（站点要求时必填）", "例如：123")}
                  {draft.provider === "deepseek" && (
                    <label className="field">
                      <span>测试币种</span>
                      <AtlasSelect
                        label="测试币种"
                        value={draft.unit}
                        onValueChange={(unit) => update({ unit })}
                        options={moneyOptions}
                      />
                    </label>
                  )}
                </div>
                {draft.provider === "newapi" && (
                  <p className="hint">
                    此处需要用户管理令牌，而非模型 API
                    Key。管理根地址不是调用模型的 /v1 地址。
                  </p>
                )}
                {draft.provider === "newapi-token" && (
                  <p className="wizard-notice">
                    只查该 API Key 的额度，不代表账户总余额，也不会并入 USD /
                    CNY 账户合计。
                  </p>
                )}
                {draft.provider === "siliconflow" && (
                  <p className="wizard-notice">
                    官方旧 /user/info
                    已停用。此模板仅用于仍支持旧接口的兼容站点；官方账号请手动记录或配置新接口。
                  </p>
                )}
                {draft.provider === "custom" && (
                  <div className="wizard-mapping">
                    <h4>自定义查询配置</h4>
                    <CustomQueryPreset
                      value={draft.query.extractionMode || "fields"}
                      onChange={(extractionMode) =>
                        update({
                          query: {
                            ...draft.query,
                            extractionMode,
                            ...(extractionMode === "usage"
                              ? {
                                  path: "/v1/usage",
                                  authHeader: "Authorization" as const,
                                }
                              : {}),
                          },
                        })
                      }
                    />
                    <div className="form-grid">
                      {queryField("path", "GET 查询路径", "/api/wallet", true)}
                      {draft.query.extractionMode !== "usage" && (
                        <>
                          {queryField(
                            "balancePath",
                            "余额字段路径",
                            "data.balance",
                            true,
                          )}
                          {queryField(
                            "subtractPath",
                            "扣减字段（可选）",
                            "data.used",
                          )}
                          {queryField("divisor", "结果除数", "1", true)}
                        </>
                      )}
                      <label className="field">
                        <span>认证方式</span>
                        <AtlasSelect
                          label="认证方式"
                          value={draft.query.authHeader}
                          onValueChange={(authHeader) =>
                            update({
                              query: {
                                ...draft.query,
                                authHeader:
                                  authHeader as WizardDraft["query"]["authHeader"],
                              },
                            })
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
                      </label>
                    </div>
                    <p className="hint">
                      只读取同源 GET
                      路径，不执行脚本；密钥只填凭据字段，不放在网址里。
                    </p>
                  </div>
                )}
                <details className="extra-fields">
                  <summary>高级连接设置</summary>
                  <div className="form-grid">
                    {field(
                      "apiUrl",
                      "API 地址",
                      "https://example.com/v1",
                      false,
                      "url",
                    )}
                    {draft.provider !== "manual" && (
                      <QueryProfileSelect
                        value={draft.query.requestProfile}
                        onValueChange={(requestProfile) =>
                          update({ query: { ...draft.query, requestProfile } })
                        }
                      />
                    )}
                    {draft.provider !== "manual" && (
                      <label className="field">
                        <span>查询超时</span>
                        <AtlasSelect
                          label="查询超时"
                          value={String(draft.query.timeoutSeconds)}
                          onValueChange={(value) =>
                            update({
                              query: {
                                ...draft.query,
                                timeoutSeconds: Number(value) as 10 | 20 | 30,
                              },
                            })
                          }
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
                    )}
                  </div>
                </details>
              </>
            )}
            {step === 3 && (
              <>
                <p className="wizard-lead">
                  {draft.provider === "manual"
                    ? "手动记录无需接口测试，可直接确认单位。"
                    : `${platform.label}。只在点击下方按钮后发起一次请求，测试读到的数值不会成为余额记录。`}
                </p>
                <dl className="wizard-review">
                  <div>
                    <dt>查询口径</dt>
                    <dd>{scope(draft.provider)}</dd>
                  </div>
                  <div>
                    <dt>凭据</dt>
                    <dd>
                      {draft.provider === "manual"
                        ? "无需凭据"
                        : draft.credential.trim()
                          ? "已填写，不在此显示"
                          : "尚未填写，可稍后补充"}
                    </dd>
                  </div>
                  {draft.provider !== "manual" && (
                    <div>
                      <dt>目标根地址</dt>
                      <dd>
                        {draft.managementUrl ||
                          draft.apiUrl ||
                          platform.root ||
                          draft.siteUrl}
                      </dd>
                    </div>
                  )}
                  {draft.provider !== "manual" && (
                    <div>
                      <dt>GET 路径</dt>
                      <dd>{platform.endpoint || draft.query.path}</dd>
                    </div>
                  )}
                </dl>
                {draft.provider !== "manual" && (
                  <>
                    <button
                      className="button primary wizard-test-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void test()}
                    >
                      <ShieldCheck size={16} />
                      {testing ? "正在测试…" : "测试连接"}
                    </button>
                    {verified && tested && (
                      <div className="wizard-test-result" role="status">
                        <Check size={17} />
                        <div>
                          <strong>测试成功，尚未记录余额</strong>
                          <p>
                            <span>{tested.result.balance}</span>{" "}
                            {tested.result.unit}
                          </p>
                        </div>
                      </div>
                    )}
                    <QueryDiagnosticPanel
                      diagnostic={diagnostic}
                      busy={testing}
                    />
                    <p className="hint">
                      可以暂不测试或失败后保存为未验证配置。不会启用自动查询或改变部署端的
                      DoH / 代理配置。
                    </p>
                  </>
                )}
              </>
            )}
            {step === 4 && (
              <>
                <p className="wizard-lead">
                  {quota
                    ? "先保留原始配额；只有你明确确认系数，才换算成金额。"
                    : draft.provider === "custom" &&
                        draft.query.extractionMode === "usage"
                      ? "接口查询以响应 unit / quota.unit 为准，均缺失时为 USD。下方单位仅用于手动记录，不覆盖接口单位，也不自动换汇。"
                      : "选择记录单位，不自动换汇。请按平台实际查询口径确认。"}
                </p>
                <div className="form-grid">
                  <label className="field">
                    <span>余额单位</span>
                    <AtlasSelect
                      label="余额单位"
                      disabled={fixedUnit}
                      value={
                        ["USD", "CNY"].includes(draft.unit)
                          ? draft.unit
                          : "custom"
                      }
                      onValueChange={(value) =>
                        update({ unit: value === "custom" ? "积分" : value })
                      }
                      options={[
                        ...moneyOptions,
                        ...([
                          "newapi-token",
                          "deepseek",
                          "openrouter",
                          "siliconflow",
                        ].includes(draft.provider)
                          ? []
                          : [
                              {
                                value: "custom",
                                label: "自定义单位",
                                description: "积分等额度不跨站混加",
                              },
                            ]),
                      ]}
                    />
                  </label>
                  {!["USD", "CNY"].includes(draft.unit) &&
                    field("unit", "自定义单位", "例如：积分", true)}
                  {draft.provider === "manual" &&
                    field(
                      "initialBalance",
                      "初始余额（可选）",
                      "未知就留空；0 是明确的零余额",
                    )}
                  {quota &&
                    draft.conversionConfirmed &&
                    field(
                      "quotaPerUnit",
                      "每单位对应的原始配额",
                      "请按站点说明填写，例如：500000",
                      true,
                    )}
                </div>
                {fixedUnit && (
                  <p className="hint">
                    {platform.label} 接口使用固定 {wizardUnit(draft)} 单位。
                  </p>
                )}
                {quota && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={draft.conversionConfirmed}
                      onChange={(e) =>
                        update({ conversionConfirmed: e.target.checked })
                      }
                    />
                    我已确认换算系数
                  </label>
                )}
                <div className="wizard-unit-note">
                  <WalletCards size={19} aria-hidden="true" />
                  <div>
                    <strong>
                      {draft.provider === "custom" &&
                      draft.query.extractionMode === "usage"
                        ? "接口单位以响应为准；手动记录单位："
                        : "最终显示："}
                      {wizardUnit(draft)}
                    </strong>
                    <p>
                      {draft.provider === "newapi-token"
                        ? "令牌额度与账户余额隔离汇总；无限额度不能写成数字余额。"
                        : quota && !draft.conversionConfirmed
                          ? "未确认换算，仅显示原始配额，不计入 USD / CNY 合计。"
                          : draft.provider === "custom" &&
                              draft.query.extractionMode === "usage"
                            ? "接口 unit / quota.unit 缺失时使用 USD；不按手动单位重标金额。"
                            : "金额按此单位记录，不会自动换汇。"}
                    </p>
                    {preview && (
                      <p className="wizard-preview">
                        本次测试预览：<b>{preview.balance}</b> {preview.unit}
                        ，仅供确认
                      </p>
                    )}
                  </div>
                </div>
                {quota && draft.conversionConfirmed && verified && !preview && (
                  <p className="wizard-notice">请填写有效的正数换算系数。</p>
                )}
                {draft.provider === "deepseek" && !verified && (
                  <p className="hint">
                    更改币种后原测试不再适用；可返回测试或明确保存为未验证。
                  </p>
                )}
                <label className="check-row wizard-confirm">
                  <input
                    type="checkbox"
                    checked={draft.unitConfirmed}
                    onChange={(e) =>
                      update({ unitConfirmed: e.target.checked })
                    }
                  />
                  我已确认余额单位与查询口径
                </label>
              </>
            )}
            {step === 5 && (
              <>
                <p className="wizard-lead">
                  保存只建立本地档案。接口测试的余额不写入历史；之后由你点击刷新。
                </p>
                <dl className="wizard-review">
                  <div>
                    <dt>站点</dt>
                    <dd>
                      {draft.name} {draft.alias && `（${draft.alias}）`}
                    </dd>
                  </div>
                  <div>
                    <dt>网站地址</dt>
                    <dd>{draft.siteUrl}</dd>
                  </div>
                  <div>
                    <dt>记录方式</dt>
                    <dd>{platform.label}</dd>
                  </div>
                  <div>
                    <dt>余额口径</dt>
                    <dd>
                      {scope(draft.provider)} / {wizardUnit(draft)}
                    </dd>
                  </div>
                  <div>
                    <dt>连接验证</dt>
                    <dd className={verified ? "wizard-verified" : ""}>
                      {draft.provider === "manual"
                        ? "无需接口测试"
                        : verified
                          ? "本次草稿已测试成功"
                          : "未验证，保存后可再次测试"}
                    </dd>
                  </div>
                </dl>
                <div className="form-grid">
                  <GroupSelect
                    groups={savedGroups}
                    value={draft.group}
                    onValueChange={(group) => update({ group })}
                    disabled={busy}
                  />
                  {field("tags", "标签", "多个标签用逗号分隔")}
                  {field(
                    "lowThreshold",
                    "低余额阈值（可选）",
                    "按最终显示单位填写；留空关闭",
                  )}
                </div>
                <details className="extra-fields">
                  <summary>更多入口与备注</summary>
                  <div className="form-grid">
                    {field(
                      "consoleUrl",
                      "控制台地址",
                      "默认打开网站地址",
                      false,
                      "url",
                    )}
                    {field(
                      "rechargeUrl",
                      "充值页地址",
                      "仅作为快捷入口",
                      false,
                      "url",
                    )}
                    {field("docsUrl", "文档地址", "https://…", false, "url")}
                    <label className="field field-full">
                      <span>备注</span>
                      <textarea
                        value={draft.notes}
                        onChange={(e) => update({ notes: e.target.value })}
                        maxLength={2000}
                        rows={3}
                      />
                    </label>
                  </div>
                </details>
                {draft.provider !== "manual" && !verified && (
                  <label className="check-row wizard-confirm">
                    <input
                      type="checkbox"
                      checked={draft.unverifiedAccepted}
                      onChange={(e) =>
                        update({ unverifiedAccepted: e.target.checked })
                      }
                    />
                    我确认保存尚未验证的配置
                  </label>
                )}
              </>
            )}
          </section>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="wizard-actions">
          <span className="wizard-local-note">
            <ShieldCheck size={13} aria-hidden="true" />
            仅保存在你的部署
          </span>
          <div>
            {step > 1 && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => navigate(step - 1)}
              >
                上一步
              </button>
            )}
            {step === 3 ? (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={advance}
              >
                {draft.provider === "manual" || verified
                  ? "继续确认单位"
                  : "暂不测试，继续"}
                <ChevronRight size={15} />
              </button>
            ) : (
              <button type="submit" className="button primary" disabled={busy}>
                {saving ? "保存中…" : step === 5 ? "保存站点" : "下一步"}
                {step < 5 && <ChevronRight size={15} />}
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
