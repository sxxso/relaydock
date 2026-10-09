import { z } from "zod";
import { amount } from "./money";
import type { QueryDiagnostic } from "./query-diagnostics";
import { queryRouteMode } from "./query-routing";
import { groupPositionsSchema } from "./group-layout";
import { groupColorEntriesSchema } from "./group-colors";
import { savedViewsSchema } from "./saved-views";
import { invitationBackupSchema } from "./invitation";
const secretParam =
  /^(?:token|access_token|refresh_token|api[-_]?key|key|secret|password|auth|authorization|session)$/i;
function sensitiveFragment(url: URL) {
  let hash = url.hash;
  try {
    hash = decodeURIComponent(hash);
  } catch {}
  return hash
    .replace(/^#/, "")
    .split(/[?&;]/)
    .some(
      (part) =>
        part.includes("=") && secretParam.test(part.split("=")[0].trim()),
    );
}
function sensitiveUrl(url: URL) {
  return (
    [...url.searchParams.keys()].some((key) => secretParam.test(key)) ||
    sensitiveFragment(url)
  );
}
export function safePublicUrl(value: string, root = false) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (root) {
      url.search = "";
      url.hash = "";
    } else {
      for (const key of [...url.searchParams.keys()])
        if (secretParam.test(key)) url.searchParams.delete(key);
      if (sensitiveFragment(url)) url.hash = "";
    }
    return url.toString();
  } catch {
    return value;
  }
}
const money = z.string().refine((v) => {
  try {
    amount(v);
    return true;
  } catch {
    return false;
  }
}, "金额格式不正确");
const web = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      let u = new URL(s);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !sensitiveUrl(u)
      );
    } catch {
      return false;
    }
  }, "请输入完整 http(s) 地址");
export const unitSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[^:\r\n]+$/, "余额单位不能包含冒号或换行");
const optionalWeb = z.union([web, z.literal("")]).default("");
const optionalRoot = z
  .union([
    web.refine((v) => {
      try {
        const u = new URL(v);
        return !u.search && !u.hash;
      } catch {
        return false;
      }
    }, "查询根地址不能包含参数或片段；密钥请填凭据字段"),
    z.literal(""),
  ])
  .default("");
const fieldPath = z
  .string()
  .max(120)
  .refine(
    (v) =>
      /^[A-Za-z_][\w]*(?:\.(?:[A-Za-z_][\w]*|\d+))*$/.test(v) &&
      !v
        .split(".")
        .some((k) => ["__proto__", "constructor", "prototype"].includes(k)),
    "字段路径只能使用 data.balance 或 balance_infos.0.total_balance 形式",
  );
export const querySchema = z
  .object({
    requestProfile: z.enum(["atlas", "cc-switch"]).optional(),
    extractionMode: z.enum(["fields", "usage"]).optional(),
    timeoutSeconds: z
      .union([z.literal(10), z.literal(20), z.literal(30)])
      .default(10),
    path: z
      .string()
      .max(256)
      .regex(
        /^\/(?!\/)[A-Za-z0-9_./-]*$/,
        "查询路径必须是同源 /path，不能包含参数或完整网址",
      )
      .refine(
        (v) => !v.split("/").some((k) => k === "." || k === ".."),
        "查询路径不能包含目录跳转",
      )
      .default("/user/balance"),
    balancePath: fieldPath.default("balance"),
    subtractPath: z.union([fieldPath, z.literal("")]).default(""),
    divisor: money.refine((v) => Number(v) > 0, "除数须大于零").default("1"),
    authHeader: z
      .enum(["Authorization", "x-api-key", "api-key"])
      .default("Authorization"),
  })
  .strict();
export const settingsSchema = z
  .object({
    theme: z.enum(["light", "dark", "system"]).default("light"),
    motion: z.boolean().default(true),
    mapBackground: z
      .enum(["paper", "dots", "grid", "cross", "contours", "sea"])
      .default("dots"),
    inkColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
    inkOpacity: z.number().int().min(0).max(100).default(100),
    mapOpacity: z.number().int().min(0).max(100).default(100),
    mapDensity: z.enum(["sparse", "standard", "dense"]).default("standard"),
  })
  .strict();
export const accountDetails = z
  .object({
    name: z.string().trim().min(1, "请输入站点名称").max(80),
    alias: z.string().trim().max(80).default(""),
    siteUrl: web,
    apiUrl: optionalRoot,
    consoleUrl: optionalWeb,
    rechargeUrl: optionalWeb,
    docsUrl: optionalWeb,
    group: z.string().trim().max(50).default("未分组"),
    mapOrder: z.number().int().min(0).max(1000000000).optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(12).default([]),
    notes: z.string().max(2000).default(""),
    favorite: z.boolean().default(false),
    archived: z.boolean().default(false),
    provider: z
      .enum([
        "manual",
        "newapi",
        "newapi-token",
        "generic",
        "deepseek",
        "openrouter",
        "siliconflow",
        "custom",
      ])
      .default("manual"),
    query: querySchema.prefault({}),
    unit: unitSchema.default("USD"),
    lowThreshold: money.nullable().default(null),
    managementUrl: optionalRoot,
    userId: z
      .string()
      .regex(/^\d{0,20}$/, "用户 ID 应为数字")
      .default(""),
    quotaPerUnit: money
      .refine((v) => Number(v) > 0, "换算系数须大于零")
      .nullable()
      .default(null),
  })
  .strict()
  .refine(
    (a) => a.provider !== "newapi-token" || ["USD", "CNY"].includes(a.unit),
    "令牌模板单位只支持 USD 或 CNY；未换算时显示原始配额",
  );
export const accountInput = accountDetails
  .safeExtend({
    credential: z.string().max(4096).optional(),
    clearCredential: z.boolean().optional(),
    initialBalance: money.nullable().optional(),
    expectedUpdatedAt: z.iso.datetime().optional(),
  })
  .strict();
// Batch commands deliberately do not reuse accountInput: no defaults or fields
// outside the selected metadata operation may overwrite an existing account.
export const batchInput = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(500)
      .refine(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      ),
    operation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("group"),
          group: z.string().trim().min(1).max(50),
        })
        .strict(),
      z
        .object({
          kind: z.literal("tags"),
          mode: z.enum(["add", "remove", "replace"]),
          tags: z
            .array(z.string().trim().min(1).max(24))
            .max(12)
            .transform((tags) => [...new Set(tags)]),
        })
        .strict()
        .refine(
          (operation) =>
            operation.mode === "replace" || operation.tags.length > 0,
        ),
      z.object({ kind: z.literal("archive"), archived: z.boolean() }).strict(),
    ]),
    expectedUpdatedAt: z.record(z.uuid(), z.iso.datetime()).optional(),
  })
  .strict()
  .refine((value) => value.expectedUpdatedAt === undefined ||
    (Object.keys(value.expectedUpdatedAt).length === value.ids.length && value.ids.every((id) => Object.hasOwn(value.expectedUpdatedAt!, id))));
export type BatchInput = z.infer<typeof batchInput>;
export const undoFieldSchema = z
  .object({
    id: z.uuid(),
    expectedUpdatedAt: z.iso.datetime(),
    restore: z
      .object({
        favorite: z.boolean().optional(),
        archived: z.boolean().optional(),
        group: z.string().trim().max(50).optional(),
        tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();
export const undoInput = z
  .object({ entries: z.array(undoFieldSchema).min(1).max(500) })
  .strict()
  .refine((value) => new Set(value.entries.map((entry) => entry.id)).size === value.entries.length);
export type UndoInput = z.infer<typeof undoInput>;
export const moveInput = z
  .object({
    id: z.uuid(),
    group: z.string().trim().min(1).max(50),
    beforeId: z.uuid().nullable(),
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict();
// A draft query has no account identity, persistence flags or initial balance.
// Reuse field validators, not account creation; never create a temporary row.
export const draftQueryInput = z
  .object({
    provider: z.enum([
      "newapi",
      "newapi-token",
      "generic",
      "deepseek",
      "openrouter",
      "siliconflow",
      "custom",
    ]),
    siteUrl: accountDetails.shape.siteUrl,
    apiUrl: accountDetails.shape.apiUrl,
    managementUrl: accountDetails.shape.managementUrl,
    userId: accountDetails.shape.userId,
    query: accountDetails.shape.query,
    unit: accountDetails.shape.unit,
    quotaPerUnit: accountDetails.shape.quotaPerUnit,
    credential: z.string().max(4096).optional(),
    routeMode: queryRouteMode.optional(),
  })
  .strict()
  .refine(
    (a) => a.provider !== "newapi-token" || ["USD", "CNY"].includes(a.unit),
    "令牌模板单位只支持 USD 或 CNY；未换算时显示原始配额",
  );
export const snapshotInput = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    amount: money,
    unit: unitSchema,
    source: z.enum(["manual", "sync"]),
    at: z.iso.datetime(),
    note: z.string().max(2000),
    rawQuota: money.nullable(),
    recordOrder: z
      .number()
      .int()
      .min(Number.MIN_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();
const backupSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    exportedAt: z.iso.datetime().optional(),
    accounts: z
      .array(
        z
          .object({
            id: z.uuid(),
            details: accountDetails,
            createdAt: z.iso.datetime(),
            balanceSnapshotId: z.uuid().nullable().optional(),
          })
          .strict(),
      )
      .max(5000),
    snapshots: z.array(snapshotInput).max(50000),
    settings: settingsSchema,
    groupPositions: groupPositionsSchema.optional(),
    groupColors: groupColorEntriesSchema.optional(),
    savedViews: savedViewsSchema.default([]),
    invitations: invitationBackupSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    let ids = new Set(v.accounts.map((a) => a.id));
    if (ids.size !== v.accounts.length)
      c.addIssue({ code: "custom", message: "账号 ID 重复" });
    let snaps = new Set(v.snapshots.map((s) => s.id));
    if (snaps.size !== v.snapshots.length)
      c.addIssue({ code: "custom", message: "快照 ID 重复" });
    if (v.snapshots.some((s) => !ids.has(s.accountId)))
      c.addIssue({ code: "custom", message: "快照引用不存在的账号" });
    if (v.invitations?.some((entry) => !ids.has(entry.accountId)))
      c.addIssue({ code: "custom", message: "邀请资料引用不存在的账号" });
    const groups = new Set(v.accounts.map((a) => a.details.group || "未分组"));
    if (v.groupPositions?.some((p) => !groups.has(p.name)))
      c.addIssue({ code: "custom", message: "分组位置引用不存在的分组" });
    if (v.groupColors?.some((p) => !groups.has(p.name)))
      c.addIssue({ code: "custom", message: "分组颜色引用不存在的分组" });
    if (v.version === 3 && v.snapshots.some((s) => s.recordOrder === undefined))
      c.addIssue({ code: "custom", message: "v3 快照缺少稳定排序序号" });
    const orderKeys = v.snapshots
      .filter((s) => s.recordOrder !== undefined)
      .map((s) => `${s.accountId}|${Date.parse(s.at)}|${s.recordOrder}`);
    if (new Set(orderKeys).size !== orderKeys.length)
      c.addIssue({ code: "custom", message: "同时间快照排序序号重复" });
  });
// Version 1 allowed parameters in query roots. They were never sent by the
// adapter; strip them in memory while preserving the caller's backup object.
export const backupInput = z.preprocess((input) => {
  if (!input || typeof input !== "object") return input;
  const b = input as Record<string, unknown>;
  if (b.version !== 1 || !Array.isArray(b.accounts)) return input;
  return {
    ...b,
    accounts: b.accounts.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        !row.details ||
        typeof row.details !== "object"
      )
        return row;
      const details = { ...row.details };
      for (const field of [
        "siteUrl",
        "apiUrl",
        "managementUrl",
        "consoleUrl",
        "rechargeUrl",
        "docsUrl",
      ])
        if (typeof details[field] === "string")
          details[field] = safePublicUrl(
            details[field],
            field === "apiUrl" || field === "managementUrl",
          );
      return { ...row, details };
    }),
  };
}, backupSchema);
export type AccountDetails = z.infer<typeof accountDetails>;
export type Account = AccountDetails & {
  id: string;
  createdAt: string;
  updatedAt: string;
  balance: string | null;
  balanceUnit: string;
  lastSnapshotAt: string | null;
  // Derived from the actual latest snapshot; absent on pre-stage3 clients.
  balanceSource?: "manual" | "sync" | null;
  balanceSnapshotId?: string | null;
  rawQuota: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: "never" | "success" | "error";
  lastSyncError: string | null;
  hasCredential: boolean;
  lastQueryDiagnostic?: QueryDiagnostic | null;
  lastSyncDiagnostic?: QueryDiagnostic | null;
};
export type Snapshot = z.infer<typeof snapshotInput>;
export type Settings = {
  theme: "light" | "dark" | "system";
  motion: boolean;
  mapBackground?: z.infer<typeof settingsSchema>["mapBackground"];
  inkColor?: string | null;
  inkOpacity?: number;
  mapOpacity?: number;
  mapDensity?: "sparse" | "standard" | "dense";
};







