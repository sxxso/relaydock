import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, desc } from "drizzle-orm";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  accountInput,
  accountDetails,
  batchInput,
  undoInput,
  moveInput,
  backupInput,
  querySchema,
  settingsSchema,
  safePublicUrl,
  type Account,
  type AccountDetails,
  type Snapshot,
  type Settings,
} from "./validation";
import {
  savedViewIdSchema,
  savedViewInputSchema,
  savedViewsSchema,
  savedViewSchema,
  type SavedView,
} from "./saved-views";
import { amount, tokenBalanceUnit } from "./money";
import { normalizeModelInsight, type ModelInsight } from "./model-insight";
import { checkinStatusSchema, checkinOperationSchema, type CheckinStatus, type CheckinOperation } from "./checkin";
import { emptyInvitation, invitationSchema, invitationSaveInput, invitationLink, type Invitation } from "./invitation";
import {
  groupLayoutSchema,
  groupMoveInput,
  groupRenameInput,
  type GroupLayout,
} from "./group-layout";
import { layoutIslands } from "./map-layout";
import { groupColorInput, groupColorsSchema, type GroupColors } from "./group-colors";
import { backupStatusSchema, type BackupStatus } from "./backup";
import { encryptSecret, decryptSecret, hashPassword } from "./crypto";
import {
  normalizeDiagnostic,
  publicQueryError,
  type QueryDiagnostic,
} from "./query-diagnostics";
type Stored = Omit<Account, "hasCredential">;
function invitationIdentityVersion(payload: Stored) {
  return createHash("sha256").update(JSON.stringify([payload.provider, payload.siteUrl, payload.apiUrl, payload.managementUrl, payload.userId])).digest("hex");
}
function modelConnectionVersion(payload: Stored, secret: string | null) {
  const url = (value: string) => value ? new URL(value).toString() : "";
  return createHash("sha256").update(JSON.stringify({
    provider: payload.provider, siteUrl: url(payload.siteUrl), apiUrl: url(payload.apiUrl),
    managementUrl: url(payload.managementUrl), userId: payload.userId,
    query: querySchema.parse(payload.query || {}), secret, quotaPerUnit: payload.quotaPerUnit, unit: payload.unit,
  })).digest("hex");
}
function nextUpdatedAt(previous: string, eventAt = new Date().toISOString()) {
  return new Date(
    Math.max(Date.parse(eventAt), Date.parse(previous) + 1),
  ).toISOString();
}
function publicAccount(
  row: Stored,
  hasCredential: boolean,
  latest: Snapshot | null,
): Account {
  const syncDiagnostic = normalizeDiagnostic(row.lastSyncDiagnostic);
  return {
    ...row,
    ...(latest
      ? {
          balance: latest.amount,
          balanceUnit: latest.unit,
          lastSnapshotAt: latest.at,
          rawQuota: latest.rawQuota,
        }
      : { lastSnapshotAt: null }),
    balanceSource: latest?.source ?? null,
    balanceSnapshotId: latest?.id ?? null,
    siteUrl: safePublicUrl(row.siteUrl),
    consoleUrl: safePublicUrl(row.consoleUrl),
    rechargeUrl: safePublicUrl(row.rechargeUrl),
    docsUrl: safePublicUrl(row.docsUrl),
    apiUrl: safePublicUrl(row.apiUrl, true),
    managementUrl: safePublicUrl(row.managementUrl, true),
    query: querySchema.parse(row.query || {}),
    lastQueryDiagnostic: normalizeDiagnostic(row.lastQueryDiagnostic),
    lastSyncDiagnostic:
      syncDiagnostic?.operation === "sync" ? syncDiagnostic : null,
    // Never publish arbitrary historical error text (it may contain a URL/key).
    lastSyncError:
      row.lastSyncStatus === "error"
        ? syncDiagnostic?.operation === "sync" &&
          syncDiagnostic.outcome === "failure" &&
          syncDiagnostic.finishedAt === row.lastSyncAt
          ? publicQueryError(syncDiagnostic)
          : "余额查询失败；请查看诊断或重新点击查询"
        : null,
    hasCredential,
  };
}
const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<Stored>().notNull(),
  secret: text("secret"),
});
const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  payload: text("payload", { mode: "json" }).$type<Snapshot>().notNull(),
  at: text("at").notNull(),
  atMs: integer("at_ms").notNull(),
  recordOrder: integer("record_order").notNull(),
});
const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  expires: integer("expires").notNull(),
  csrf: text("csrf").notNull(),
});
const batchErrors = {
  invalid: "批量命令无效，请检查账号和操作参数",
  missing: "批量账号不存在；未修改任何账号",
  tags: "批量操作会使标签超过 12 个；未修改任何账号",
  failed: "批量修改失败；未修改任何账号",
  conflict: "账号已有后续修改，请刷新后重新确认；未修改任何账号",
} as const;
// Never expose validator keys/values, SQLite error text, or a caught cause.
export class BatchUpdateError extends Error {
  readonly status: 400 | 409 | 500;
  constructor(reason: keyof typeof batchErrors) {
    super(batchErrors[reason]);
    this.name = "BatchUpdateError";
    this.status = reason === "failed" ? 500 : reason === "conflict" ? 409 : 400;
  }
}
export class MoveAccountError extends Error {
  constructor(
    readonly status: 400 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "MoveAccountError";
  }
}
export class GroupLayoutError extends Error {
  constructor(
    readonly status: 400 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "GroupLayoutError";
  }
}
export class Store {
  readonly modelInsightScope: string;
  private connection: Database.Database;
  private db;
  private key: Buffer;
  constructor(path: string, key: Buffer) {
    this.modelInsightScope = path === ":memory:" ? randomUUID() : resolve(path).toLowerCase();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = key;
    this.connection = new Database(path);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.connection.exec(
      `CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,secret TEXT); CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,payload TEXT NOT NULL,at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS snapshots_account_at ON snapshots(account_id,at); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS backup_status(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,csrf TEXT NOT NULL);`,
    );
    this.connection.exec("CREATE TABLE IF NOT EXISTS model_insights(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, payload TEXT NOT NULL, connection_version TEXT)");
    this.connection.exec("CREATE TABLE IF NOT EXISTS invitations(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,payload TEXT NOT NULL,identity_version TEXT NOT NULL,connection_version TEXT NOT NULL)");
    const modelColumns = this.connection.prepare("PRAGMA table_info(model_insights)").all() as { name: string }[];
    if (!modelColumns.some(c => c.name === "connection_version")) this.connection.exec("ALTER TABLE model_insights ADD COLUMN connection_version TEXT");
    this.connection.exec(`CREATE TABLE IF NOT EXISTS checkin_cache(account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,month TEXT NOT NULL,payload TEXT NOT NULL,connection_version TEXT NOT NULL,PRIMARY KEY(account_id,month));
      CREATE TABLE IF NOT EXISTS checkin_operations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,payload TEXT NOT NULL,connection_version TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS checkin_operation_account ON checkin_operations(account_id);
      CREATE TABLE IF NOT EXISTS checkin_barriers(identity TEXT PRIMARY KEY,at TEXT NOT NULL);`);
    // Add only sorting metadata to old databases. Snapshot payloads, cached
    // balances, credentials and actual recorded timestamps remain untouched.
    this.connection
      .transaction(() => {
        const columns = new Set(
          (
            this.connection.prepare("PRAGMA table_info(snapshots)").all() as {
              name: string;
            }[]
          ).map((c) => c.name),
        );
        if (!columns.has("at_ms"))
          this.connection.exec(
            "ALTER TABLE snapshots ADD COLUMN at_ms INTEGER",
          );
        if (!columns.has("record_order"))
          this.connection.exec(
            "ALTER TABLE snapshots ADD COLUMN record_order INTEGER",
          );
        const rows = this.connection
          .prepare(
            "SELECT rowid, id, at FROM snapshots WHERE at_ms IS NULL OR record_order IS NULL",
          )
          .all() as { rowid: number; id: string; at: string }[];
        const update = this.connection.prepare(
          "UPDATE snapshots SET at_ms=?, record_order=? WHERE id=?",
        );
        for (const r of rows) {
          const ms = Date.parse(r.at);
          update.run(
            Number.isFinite(ms) ? ms : Number.MIN_SAFE_INTEGER,
            r.rowid,
            r.id,
          );
        }
        this.connection.exec(
          "CREATE INDEX IF NOT EXISTS snapshots_account_instant ON snapshots(account_id,at_ms,record_order,id); CREATE INDEX IF NOT EXISTS snapshots_account_order ON snapshots(account_id,record_order)",
        );
      })
      .immediate();
    this.db = drizzle(this.connection);
    this.connection
      .prepare("DELETE FROM sessions WHERE expires < ?")
      .run(Date.now());
  }
  close() {
    this.connection.close();
  }
  getMeta(key: string) {
    return this.db.select().from(meta).where(eq(meta.key, key)).get()?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .insert(meta)
      .values({ key, value })
      .onConflictDoUpdate({ target: meta.key, set: { value } })
      .run();
  }
  settings(): Settings {
    try {
      return settingsSchema.parse(
        JSON.parse(this.getMeta("settings") || "null") || {
          theme: "light",
          motion: true,
        },
      );
    } catch {
      return settingsSchema.parse({});
    }
  }
  setSettings(settings: Settings) {
    const normalized = settingsSchema.parse(settings);
    this.setMeta("settings", JSON.stringify(normalized));
    return normalized;
  }
  savedViews(): SavedView[] {
    try {
      return savedViewsSchema.parse(
        JSON.parse(this.getMeta("savedViews") || "[]"),
      );
    } catch {
      return [];
    }
  }
  saveView(input: unknown) {
    const next = savedViewInputSchema.parse(input);
    const current = this.savedViews();
    const existing = next.id
      ? current.find((view) => view.id === next.id)
      : undefined;
    if (next.id && !existing) throw new Error("保存的视图不存在");
    const now = new Date().toISOString();
    const view = savedViewSchema.parse({
      id: existing?.id || randomUUID(),
      name: next.name,
      filters: next.filters,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    const views = existing
      ? current.map((item) => (item.id === view.id ? view : item))
      : [...current, view];
    this.setMeta("savedViews", JSON.stringify(savedViewsSchema.parse(views)));
    return view;
  }
  deleteSavedView(id: string) {
    const viewId = savedViewIdSchema.parse(id);
    const views = this.savedViews().filter((view) => view.id !== viewId);
    this.setMeta("savedViews", JSON.stringify(views));
    return { views };
  }
  groupColors(): GroupColors {
    let current: GroupColors;
    try {
      current = groupColorsSchema.parse(JSON.parse(this.getMeta("groupColors") || "null"));
    } catch {
      current = { revision: 0, colors: [] };
    }
    const names = new Set(this.list().map((a) => a.group || "未分组"));
    return { ...current, colors: current.colors.filter((entry) => names.has(entry.name)) };
  }
  setGroupColor(input: unknown): GroupColors {
    const parsed = groupColorInput.safeParse(input);
    if (!parsed.success) throw new GroupLayoutError(400, "分组颜色无效；请输入六位 HEX 色值");
    return this.connection.transaction(() => {
      const current = this.groupColors(), { name, color, expectedRevision } = parsed.data;
      if (current.revision !== expectedRevision)
        throw new GroupLayoutError(409, "分组颜色已在其他页面更新，请重新保存；未覆盖颜色");
      if (!this.list().some((a) => (a.group || "未分组") === name))
        throw new GroupLayoutError(400, "分组不存在；未修改颜色");
      const colors = current.colors.filter((entry) => entry.name !== name);
      if (color !== null) colors.push({ name, color });
      const next = groupColorsSchema.parse({ revision: current.revision + 1, colors });
      this.setMeta("groupColors", JSON.stringify(next));
      return next;
    }).immediate();
  }
  private readGroupLayout(): GroupLayout {
    try {
      return groupLayoutSchema.parse(
        JSON.parse(this.getMeta("groupLayout") || "null"),
      );
    } catch {
      return { revision: 0, positions: [] };
    }
  }
  groupLayout(): GroupLayout {
    const layout = this.readGroupLayout();
    const names = new Set(this.list().map((a) => a.group || "未分组"));
    return {
      ...layout,
      positions: layout.positions.filter((p) => names.has(p.name)),
    };
  }
  moveGroup(input: unknown): GroupLayout {
    const parsed = groupMoveInput.safeParse(input);
    if (!parsed.success)
      throw new GroupLayoutError(400, "分组位置无效；未修改布局");
    return this.connection
      .transaction(() => {
        const current = this.groupLayout(),
          { name, position, expectedRevision } = parsed.data;
        if (current.revision !== expectedRevision)
          throw new GroupLayoutError(
            409,
            "地图布局已在其他页面更新，请重试；未修改布局",
          );
        if (!this.list().some((a) => (a.group || "未分组") === name))
          throw new GroupLayoutError(400, "分组不存在；未修改布局");
        const positions = current.positions.filter((p) => p.name !== name);
        if (position) positions.push({ name, ...position });
        const next = groupLayoutSchema.parse({
          revision: current.revision + 1,
          positions,
        });
        this.setMeta("groupLayout", JSON.stringify(next));
        return next;
      })
      .immediate();
  }
  renameGroup(input: unknown): {
    accounts: Account[];
    groupLayout: GroupLayout;
    groupColors: GroupColors;
  } {
    const parsed = groupRenameInput.safeParse(input);
    if (!parsed.success)
      throw new GroupLayoutError(400, "分组改名命令无效；未修改账号或布局");
    try {
      return this.connection
        .transaction(() => {
          // Read the unfiltered layout under the write lock: even an orphan
          // coordinate reserves its name and must not silently become a merge.
          const current = this.readGroupLayout(),
            { name, newName, expectedRevision } = parsed.data;
          if (current.revision !== expectedRevision)
            throw new GroupLayoutError(
              409,
              "地图布局已在其他页面更新，请重试；未修改账号或布局",
            );
          const rows = this.db.select().from(accounts).all();
          const source = rows.filter(
            (row) => (row.payload.group || "未分组") === name,
          );
          if (!source.length)
            throw new GroupLayoutError(400, "分组不存在；未修改账号或布局");
          if (name === newName)
            return {
              accounts: source.map((row) => this.get(row.id)!),
              groupLayout: this.groupLayout(),
              groupColors: this.groupColors(),
            };
          if (
            rows.some((row) => (row.payload.group || "未分组") === newName) ||
            current.positions.some((p) => p.name === newName)
          )
            throw new GroupLayoutError(400, "目标分组已存在；未修改账号或布局");
          // Alphabetic names determine automatic slots, column widths and rows.
          // Freeze ALL islands from the old full-account geometry, including
          // archived-only groups, before changing the source name.
          const next = groupLayoutSchema.parse({
            revision: current.revision + 1,
            positions: layoutIslands(
              rows.map((row) => row.payload),
              current.positions,
            ).islands.map((island) => ({
              name: island.name === name ? newName : island.name,
              x: island.x,
              y: island.y,
            })),
          });
          const colours = this.groupColors();
          const nextColours = colours.colors.some((entry) => entry.name === name)
            ? groupColorsSchema.parse({
                revision: colours.revision + 1,
                colors: colours.colors.map((entry) => entry.name === name ? { ...entry, name: newName } : entry),
              })
            : colours;
          const updatedAt = new Date().toISOString();
          for (const row of source)
            this.db
              .update(accounts)
              .set({
                payload: {
                  ...row.payload,
                  group: newName,
                  updatedAt: nextUpdatedAt(row.payload.updatedAt, updatedAt),
                },
              })
              .where(eq(accounts.id, row.id))
              .run();
          this.setMeta("groupLayout", JSON.stringify(next));
          this.setMeta("groupColors", JSON.stringify(nextColours));
          return {
            accounts: source.map((row) => this.get(row.id)!),
            groupLayout: next,
            groupColors: nextColours,
          };
        })
        .immediate();
    } catch (error) {
      if (error instanceof GroupLayoutError) throw error;
      throw new GroupLayoutError(500, "分组改名失败；未修改账号或布局");
    }
  }
  private readAccounts(id?: string): Account[] {
    // One indexed correlated lookup per account inside a single SQL query, not
    // one DB/API call per node or a scan of every historical snapshot. Numeric
    // instants and persisted ordinals survive partial restore/merge and ISO variants.
    const query = this.connection
      .prepare(`SELECT a.payload, a.secret, s.payload AS latest
      FROM accounts a LEFT JOIN snapshots s ON s.id = COALESCE(
        (SELECT id FROM snapshots WHERE id=json_extract(a.payload,'$.balanceSnapshotId') AND account_id=a.id),
        (SELECT id FROM snapshots WHERE account_id=a.id ORDER BY at_ms DESC, record_order DESC, id DESC LIMIT 1)
      )${id === undefined ? "" : " WHERE a.id=?"}`);
    const rows = (id === undefined ? query.all() : query.all(id)) as {
      payload: string;
      secret: string | null;
      latest: string | null;
    }[];
    return rows.map((r) =>
      publicAccount(
        JSON.parse(r.payload),
        !!r.secret,
        r.latest ? JSON.parse(r.latest) : null,
      ),
    );
  }
  list() {
    return this.readAccounts();
  }
  get(id: string) {
    return this.readAccounts(id)[0];
  }
  private raw(id: string) {
    let row = this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!row) throw new Error("账号不存在");
    return row;
  }
  create(input: unknown) {
    let p = accountInput.parse(input),
      {
        credential,
        clearCredential,
        initialBalance,
        expectedUpdatedAt,
        ...details
      } = p;
    void clearCredential;
    void expectedUpdatedAt;
    let id = randomUUID(),
      now = new Date().toISOString();
    let payload: Stored = {
      ...details,
      mapOrder:
        details.mapOrder ??
        Math.min(
          1000000000,
          Math.max(
            -1,
            ...this.list()
              .filter(
                (a) =>
                  !a.archived &&
                  (a.group || "未分组") === (details.group || "未分组"),
              )
              .map((a) => a.mapOrder ?? 0),
          ) + 1,
        ),
      id,
      createdAt: now,
      updatedAt: now,
      balance: null,
      balanceUnit: details.unit,
      lastSnapshotAt: null,
      rawQuota: null,
      lastSyncAt: null,
      lastSyncStatus: "never",
      lastSyncError: null,
    };
    this.connection.transaction(() => {
      this.db
        .insert(accounts)
        .values({
          id,
          payload,
          secret: credential ? encryptSecret(credential, this.key) : null,
        })
        .run();
      if (initialBalance != null)
        this.record(id, initialBalance, "manual", details.unit, "初始余额");
    })();
    return this.get(id)!;
  }
  update(id: string, input: unknown) {
    return this.connection
      .transaction(() => {
        let row = this.raw(id);
        let p = accountInput.parse(input),
          {
            credential,
            clearCredential,
            initialBalance,
            expectedUpdatedAt,
            ...details
          } = p;
        void initialBalance;
        if (
          expectedUpdatedAt !== undefined &&
          expectedUpdatedAt !== row.payload.updatedAt
        )
          throw new MoveAccountError(
            409,
            "站点档案已被修改，请关闭编辑器并刷新后重新编辑",
          );
        let payload = {
          ...row.payload,
          ...details,
          updatedAt: nextUpdatedAt(row.payload.updatedAt),
        };
        let secret = clearCredential
          ? null
          : credential
            ? encryptSecret(credential, this.key)
            : row.secret;
        if (modelConnectionVersion(row.payload, row.secret) !== modelConnectionVersion(payload, secret))
          this.connection.prepare("DELETE FROM model_insights WHERE account_id=?").run(id);
        this.db
          .update(accounts)
          .set({ payload, secret })
          .where(eq(accounts.id, id))
          .run();
        return this.get(id)!;
      })
      .immediate();
  }
  setFavorite(id: string, favorite: boolean, expectedUpdatedAt?: string) {
    if (typeof favorite !== "boolean")
      throw new MoveAccountError(400, "收藏命令无效");
    return this.connection
      .transaction(() => {
        const row = this.raw(id);
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.payload.updatedAt)
          throw new MoveAccountError(409, "账号已有后续修改，请刷新后重新确认");
        this.db
          .update(accounts)
          .set({
            payload: {
              ...row.payload,
              favorite,
              updatedAt: nextUpdatedAt(row.payload.updatedAt),
            },
          })
          .where(eq(accounts.id, id))
          .run();
        return this.get(id)!;
      })
      .immediate();
  }
  batchUpdate(input: unknown): Account[] {
    const parsed = batchInput.safeParse(input);
    if (!parsed.success) throw new BatchUpdateError("invalid");
    const { ids, operation, expectedUpdatedAt } = parsed.data;
    try {
      return this.connection
        .transaction(() => {
          const rows = ids.map((id) => {
            const row = this.db
              .select()
              .from(accounts)
              .where(eq(accounts.id, id))
              .get();
            if (!row) throw new BatchUpdateError("missing");
            if (expectedUpdatedAt && expectedUpdatedAt[id] !== row.payload.updatedAt)
              throw new BatchUpdateError("conflict");
            return row;
          });
          const updatedAt = new Date().toISOString();
          const updates = rows.map((row) => {
            const payload = {
              ...row.payload,
              updatedAt: nextUpdatedAt(row.payload.updatedAt, updatedAt),
            };
            if (operation.kind === "group") payload.group = operation.group;
            else if (operation.kind === "archive")
              payload.archived = operation.archived;
            else {
              payload.tags =
                operation.mode === "replace"
                  ? [...operation.tags]
                  : operation.mode === "remove"
                    ? payload.tags.filter((tag) => !operation.tags.includes(tag))
                    : [...new Set([...payload.tags, ...operation.tags])];
              if (payload.tags.length > 12) throw new BatchUpdateError("tags");
            }
            return { id: row.id, payload };
          });
          for (const row of updates)
            this.db.update(accounts).set({ payload: row.payload }).where(eq(accounts.id, row.id)).run();
          return ids.map((id) => this.get(id)!);
        })
        .immediate();
    } catch (error) {
      if (error instanceof BatchUpdateError) throw error;
      throw new BatchUpdateError("failed");
    }
  }
  undoFields(input: unknown): { accounts: Account[]; skipped: { id: string; field: string }[] } {
    const parsed = undoInput.safeParse(input);
    if (!parsed.success) throw new MoveAccountError(400, "撤销命令无效");
    return this.connection.transaction(() => {
      const rows = parsed.data.entries.map((entry) => {
        const row = this.raw(entry.id);
        return { entry, row, conflict: row.payload.updatedAt !== entry.expectedUpdatedAt };
      });
      const skipped = rows.flatMap(({ entry, conflict }) =>
        conflict ? Object.keys(entry.restore).map((field) => ({ id: entry.id, field })) : [],
      );
      if (skipped.length) return { accounts: [], skipped };
      const updates = rows.filter((row) => !row.conflict);
      for (const { entry, row } of updates) {
        const payload = {
          ...row.payload,
          ...entry.restore,
          ...(entry.restore.tags ? { tags: [...entry.restore.tags] } : {}),
          updatedAt: nextUpdatedAt(row.payload.updatedAt),
        };
        this.db.update(accounts).set({ payload }).where(eq(accounts.id, entry.id)).run();
      }
      return { accounts: updates.map(({ entry }) => this.get(entry.id)!), skipped };
    }).immediate();
  }
  moveAccount(input: unknown): Account[] {
    const parsed = moveInput.safeParse(input);
    if (!parsed.success)
      throw new MoveAccountError(400, "移动命令无效；未修改站点");
    const { id, group, beforeId, expectedUpdatedAt } = parsed.data;
    try {
      return this.connection
        .transaction(() => {
          const rows = this.db.select().from(accounts).all();
          const moving = rows.find((row) => row.id === id);
          if (!moving || moving.payload.archived)
            throw new MoveAccountError(400, "移动的站点不存在或已归档");
          if (moving.payload.updatedAt !== expectedUpdatedAt)
            throw new MoveAccountError(409, "站点已被修改，请刷新后重试拖拽");
          const source = moving.payload.group || "未分组";
          const sorted = (name: string) =>
            rows
              .filter(
                (row) =>
                  !row.payload.archived &&
                  (row.payload.group || "未分组") === name,
              )
              .sort(
                (a, b) =>
                  (a.payload.mapOrder ?? 0) - (b.payload.mapOrder ?? 0) ||
                  a.id.localeCompare(b.id),
              );
          const target = sorted(group).filter((row) => row.id !== id);
          if (beforeId === id && source === group) return [this.get(id)!];
          const index =
            beforeId === null
              ? target.length
              : target.findIndex((row) => row.id === beforeId);
          if (beforeId !== null && index < 0)
            throw new MoveAccountError(409, "目标位置已改变，请刷新后重试拖拽");
          target.splice(index, 0, moving);
          const changed: string[] = [];
          const updatedAt = new Date().toISOString();
          for (const [rank, row] of target.entries()) {
            const nextGroup = group;
            const nextOrder = rank;
            if (
              (row.payload.group || "未分组") !== nextGroup ||
              row.payload.mapOrder !== nextOrder
            ) {
              this.db
                .update(accounts)
                .set({
                  payload: {
                    ...row.payload,
                    group: nextGroup,
                    mapOrder: nextOrder,
                    updatedAt: nextUpdatedAt(row.payload.updatedAt, updatedAt),
                  },
                })
                .where(eq(accounts.id, row.id))
                .run();
              changed.push(row.id);
            }
          }
          if (source !== group) {
            for (const [rank, row] of sorted(source).filter((row) => row.id !== id).entries()) {
              this.db
                .update(accounts)
                .set({
                  payload: {
                    ...row.payload,
                    mapOrder: rank,
                    updatedAt: nextUpdatedAt(row.payload.updatedAt, updatedAt),
                  },
                })
                .where(eq(accounts.id, row.id))
                .run();
              changed.push(row.id);
            }
          }
          return [...new Set([...changed, id])].map((changedId) =>
            this.get(changedId)!,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof MoveAccountError) throw error;
      throw new MoveAccountError(500, "移动保存失败；未修改站点");
    }
  }  remove(id: string) {
    this.raw(id);
    this.db.delete(accounts).where(eq(accounts.id, id)).run();
  }
  credential(id: string) {
    let row = this.raw(id);
    return row.secret ? decryptSecret(row.secret, this.key) : null;
  }
  modelInsight(id: string): ModelInsight | null {
    const account = this.raw(id);
    const row = this.connection.prepare("SELECT payload,connection_version FROM model_insights WHERE account_id=?").get(id) as { payload: string; connection_version: string | null } | undefined;
    if (!row || row.connection_version !== modelConnectionVersion(account.payload, account.secret) || Buffer.byteLength(row.payload, "utf8") > 16 * 1024 * 1024) return null;
    try { return normalizeModelInsight(JSON.parse(row.payload), id); }
    catch { return null; }
  }
  modelInsightConnectionVersion(id: string): string | null {
    const row = this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    return row ? modelConnectionVersion(row.payload, row.secret) : null;
  }
  modelInsightConnection(id: string) {
    const row = this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    return row ? {
      account: row.payload,
      credential: row.secret ? decryptSecret(row.secret, this.key) : null,
      connectionVersion: modelConnectionVersion(row.payload, row.secret),
    } : null;
  }
  saveModelInsight(id: string, insight: ModelInsight, expectedConnectionVersion?: string): boolean {
    const validated = normalizeModelInsight(insight, id);
    if (!validated) throw new Error("invalid model insight aggregate");
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, "utf8") > 16 * 1024 * 1024) throw new Error("model insight cache exceeds size limit");
    return this.connection.transaction(() => {
      const current = this.modelInsightConnectionVersion(id);
      if (!current || (expectedConnectionVersion !== undefined && current !== expectedConnectionVersion)) return false;
      this.connection.prepare("INSERT INTO model_insights(account_id,payload,connection_version) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,connection_version=excluded.connection_version").run(id, payload, current);
      return true;
    }).immediate();
  }
  invitation(id: string): Invitation {
    const account = this.raw(id);
    const row = this.connection.prepare("SELECT payload,identity_version,connection_version FROM invitations WHERE account_id=?").get(id) as { payload: string; identity_version: string; connection_version: string } | undefined;
    if (!row || Buffer.byteLength(row.payload, "utf8") > 16384) return emptyInvitation(id);
    try {
      const parsed = invitationSchema.parse(JSON.parse(row.payload));
      if (parsed.accountId !== id) return emptyInvitation(id);
      if (row.identity_version !== invitationIdentityVersion(account.payload)) return emptyInvitation(id, parsed.revision);
      return { ...parsed, fetched: row.connection_version === modelConnectionVersion(account.payload, account.secret) ? parsed.fetched : null };
    } catch { return emptyInvitation(id); }
  }
  private writeInvitation(id: string, value: Invitation) {
    const account = this.raw(id), validated = invitationSchema.parse(value);
    if (validated.accountId !== id) throw new Error("invalid invitation account");
    this.connection.prepare("INSERT INTO invitations(account_id,payload,identity_version,connection_version) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,identity_version=excluded.identity_version,connection_version=excluded.connection_version").run(id, JSON.stringify(validated), invitationIdentityVersion(account.payload), modelConnectionVersion(account.payload, account.secret));
    return validated;
  }
  saveInvitationManual(id: string, input: unknown): Invitation | null {
    const command = invitationSaveInput.parse(input);
    return this.connection.transaction(() => {
      if (this.raw(id).payload.updatedAt !== command.expectedUpdatedAt) return null;
      const current = this.invitation(id);
      if (current.revision !== command.expectedRevision) return null;
      const account = this.raw(id).payload;
      const fetched = current.fetched ? { ...current.fetched, url: invitationLink(account.siteUrl, current.fetched.code, command.registerUrl) } : null;
      return this.writeInvitation(id, { ...current, revision: current.revision + 1, registerUrl: command.registerUrl, manualUrl: command.manualUrl, manualAt: command.manualUrl ? new Date().toISOString() : null, fetched });
    }).immediate();
  }
  saveInvitationFetched(id: string, code: string, expectedVersion: string, expectedRevision: number): Invitation | null {
    return this.connection.transaction(() => {
      const connection = this.modelInsightConnection(id);
      if (!connection || connection.connectionVersion !== expectedVersion || connection.account.archived || connection.account.provider !== "newapi") return null;
      const current = this.invitation(id);
      if (current.revision !== expectedRevision) return null;
      const fetched = { code, url: invitationLink(connection.account.siteUrl, code, current.registerUrl), at: new Date().toISOString() };
      return this.writeInvitation(id, { ...current, revision: current.revision + 1, fetched });
    }).immediate();
  }
  checkinStatus(id: string, month?: string): CheckinStatus | null {
    const version = this.modelInsightConnectionVersion(id);
    if (!version) return null;
    const rows = this.connection.prepare(`SELECT payload FROM checkin_cache WHERE account_id=? AND connection_version=? ${month ? "AND month=?" : "ORDER BY rowid DESC LIMIT 1"}`).all(...[id, version, ...(month ? [month] : [])]) as { payload: string }[];
    if (!rows[0] || Buffer.byteLength(rows[0].payload, "utf8") > 1024 * 1024) return null;
    try { const parsed = checkinStatusSchema.safeParse(JSON.parse(rows[0].payload)); return parsed.success && parsed.data.accountId === id && (!month || parsed.data.month === month) ? parsed.data : null; } catch { return null; }
  }
  saveCheckinStatus(id: string, status: CheckinStatus, version: string): boolean {
    const value = checkinStatusSchema.parse(status);
    if (value.accountId !== id) throw new Error("invalid checkin account");
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, "utf8") > 1024 * 1024) throw new Error("checkin cache exceeds limit");
    return this.connection.transaction(() => {
      if (this.modelInsightConnectionVersion(id) !== version) return false;
      // Reinsert to advance rowid even when an older month was refreshed.
      this.connection.prepare("DELETE FROM checkin_cache WHERE account_id=? AND month=?").run(id, value.month);
      this.connection.prepare("INSERT INTO checkin_cache(account_id,month,payload,connection_version) VALUES(?,?,?,?) ON CONFLICT(account_id,month) DO UPDATE SET payload=excluded.payload,connection_version=excluded.connection_version").run(id, value.month, payload, version);
      this.connection.prepare("DELETE FROM checkin_cache WHERE account_id=? AND rowid NOT IN(SELECT rowid FROM checkin_cache WHERE account_id=? ORDER BY rowid DESC LIMIT 24)").run(id, id);
      return true;
    }).immediate();
  }
  checkinOperations(id: string): CheckinOperation[] {
    const version = this.modelInsightConnectionVersion(id);
    if (!version) return [];
    const rows = this.connection.prepare("SELECT payload FROM checkin_operations WHERE account_id=? AND connection_version=? ORDER BY rowid DESC LIMIT 100").all(id, version) as { payload: string }[];
    return rows.flatMap(row => {
      if (Buffer.byteLength(row.payload, "utf8") > 1024 * 1024) return [];
      try { const parsed = checkinOperationSchema.safeParse(JSON.parse(row.payload)); return parsed.success && parsed.data.accountId === id ? [parsed.data] : []; } catch { return []; }
    });
  }
  saveCheckinOperation(id: string, operation: CheckinOperation, version: string): boolean {
    const value = checkinOperationSchema.parse(operation);
    if (value.accountId !== id) throw new Error("invalid checkin account");
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, "utf8") > 1024 * 1024) throw new Error("checkin operation exceeds limit");
    return this.connection.transaction(() => {
      if (this.modelInsightConnectionVersion(id) !== version) return false;
      this.connection.prepare("INSERT INTO checkin_operations(id,account_id,payload,connection_version) VALUES(?,?,?,?)").run(value.id, id, payload, version);
      this.connection.prepare("DELETE FROM checkin_operations WHERE account_id=? AND rowid NOT IN(SELECT rowid FROM checkin_operations WHERE account_id=? ORDER BY rowid DESC LIMIT 100)").run(id, id);
      return true;
    }).immediate();
  }
  hasCheckinBarrier(identity: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("invalid checkin identity");
    return !!this.connection.prepare("SELECT 1 FROM checkin_barriers WHERE identity=?").get(identity);
  }
  beginCheckinBarrier(id: string, identity: string, version: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("invalid checkin identity");
    return this.connection.transaction(() => {
      const current = this.modelInsightConnection(id);
      if (!current || current.connectionVersion !== version || current.account.archived || this.hasCheckinBarrier(identity)) return false;
      this.connection.prepare("INSERT INTO checkin_barriers(identity,at) VALUES(?,?)").run(identity, new Date().toISOString());
      return true;
    }).immediate();
  }
  clearCheckinBarrier(identity: string) {
    this.connection.prepare("DELETE FROM checkin_barriers WHERE identity=?").run(identity);
  }
  record(
    id: string,
    value: string,
    source: "manual" | "sync",
    unit: string,
    note: string,
    rawQuota: string | null = null,
    inputDiagnostic?: QueryDiagnostic,
  ) {
    const diagnostic = normalizeDiagnostic(inputDiagnostic);
    if (
      inputDiagnostic &&
      (!diagnostic ||
        diagnostic.operation !== "sync" ||
        diagnostic.outcome !== "success" ||
        source !== "sync")
    )
      throw new Error("无效余额查询诊断");
    let row = this.raw(id),
      at = new Date().toISOString(),
      snap: Snapshot = {
        id: randomUUID(),
        accountId: id,
        amount: amount(value),
        unit:
          row.payload.provider === "newapi-token"
            ? tokenBalanceUnit(unit)
            : unit,
        source,
        at,
        note: note.slice(0, 2000),
        rawQuota,
      };
    this.connection.transaction(() => {
      const latestOrder = this.connection
        .prepare(
          "SELECT record_order FROM snapshots WHERE account_id=? ORDER BY record_order DESC LIMIT 1",
        )
        .get(id) as { record_order: number } | undefined;
      const recordOrder = (latestOrder?.record_order ?? 0) + 1;
      if (!Number.isSafeInteger(recordOrder))
        throw new Error("快照排序序号超出范围");
      snap.recordOrder = recordOrder;
      this.db
        .insert(snapshots)
        .values({
          id: snap.id,
          accountId: id,
          payload: snap,
          at,
          atMs: Date.parse(at),
          recordOrder,
        })
        .run();
      let payload = {
        ...row.payload,
        balance: snap.amount,
        balanceUnit: snap.unit,
        lastSnapshotAt: at,
        balanceSnapshotId: snap.id,
        rawQuota,
        updatedAt: nextUpdatedAt(row.payload.updatedAt, at),
        ...(source === "sync"
          ? {
              lastSyncAt: diagnostic?.finishedAt ?? at,
              lastSyncStatus: "success" as const,
              lastSyncError: null,
              lastSyncDiagnostic: diagnostic,
              ...(diagnostic ? { lastQueryDiagnostic: diagnostic } : {}),
            }
          : {}),
      };
      this.db
        .update(accounts)
        .set({ payload })
        .where(eq(accounts.id, id))
        .run();
    })();
    return this.get(id)!;
  }
  syncFailure(id: string, _message: string, inputDiagnostic?: QueryDiagnostic) {
    const diagnostic = normalizeDiagnostic(inputDiagnostic);
    if (
      inputDiagnostic &&
      (!diagnostic ||
        diagnostic.operation !== "sync" ||
        diagnostic.outcome !== "failure")
    )
      throw new Error("无效余额查询诊断");
    let row = this.raw(id),
      at = new Date().toISOString();
    this.db
      .update(accounts)
      .set({
        payload: {
          ...row.payload,
          lastSyncAt: diagnostic?.finishedAt ?? at,
          lastSyncStatus: "error",
          lastSyncError: diagnostic
            ? publicQueryError(diagnostic)
            : "余额查询失败；请查看诊断或重新点击查询",
          lastSyncDiagnostic: diagnostic,
          ...(diagnostic ? { lastQueryDiagnostic: diagnostic } : {}),
          updatedAt: nextUpdatedAt(row.payload.updatedAt, at),
        },
      })
      .where(eq(accounts.id, id))
      .run();
  }
  saveQueryDiagnostic(id: string, input: QueryDiagnostic) {
    const diagnostic = normalizeDiagnostic(input);
    if (!diagnostic) throw new Error("无效诊断结果");
    const row = this.raw(id);
    this.db
      .update(accounts)
      .set({
        payload: {
          ...row.payload,
          lastQueryDiagnostic: diagnostic,
        },
      })
      .where(eq(accounts.id, id))
      .run();
  }
  history(id?: string) {
    let query = this.db.select().from(snapshots);
    let rows = id
      ? query
          .where(eq(snapshots.accountId, id))
          .orderBy(
            desc(snapshots.atMs),
            desc(snapshots.recordOrder),
            desc(snapshots.id),
          )
          .all()
      : query
          .orderBy(
            desc(snapshots.atMs),
            desc(snapshots.recordOrder),
            desc(snapshots.id),
          )
          .all();
    return rows.map((r) => ({ ...r.payload, recordOrder: r.recordOrder }));
  }
  createSession(id: string, csrf: string) {
    this.db
      .insert(sessions)
      .values({ id, csrf, expires: Date.now() + 7 * 24 * 3600 * 1000 })
      .run();
  }
  session(id: string) {
    let s = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return s && s.expires > Date.now() ? s : undefined;
  }
  deleteSession(id: string) {
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }
  deleteAllSessions() {
    this.db.delete(sessions).run();
  }
  backupStatus(): BackupStatus {
    const row = this.connection
      .prepare("SELECT value FROM backup_status WHERE key=?")
      .get("lastDataBackupExportAt") as { value: string } | undefined;
    try {
      return backupStatusSchema.parse({
        lastDataBackupExportAt: row?.value || null,
      });
    } catch {
      return { lastDataBackupExportAt: null };
    }
  }
  recordDataBackupExport(exportedAt: string): BackupStatus {
    const status = backupStatusSchema.parse({ lastDataBackupExportAt: exportedAt });
    this.connection
      .prepare(
        "INSERT INTO backup_status(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("lastDataBackupExportAt", status.lastDataBackupExportAt);
    return status;
  }
  exportBackup() {
    const exportedAt = new Date().toISOString();
    const backup = {
      version: 3 as const,
      exportedAt,
      accounts: this.list().map((a) => ({
        id: a.id,
        details: accountDetails.parse(
          Object.fromEntries(
            Object.keys(accountDetails.shape).map((k) => [
              k,
              (a as unknown as Record<string, unknown>)[k],
            ]),
          ),
        ),
        createdAt: a.createdAt,
        balanceSnapshotId: a.balanceSnapshotId ?? null,
      })),
      snapshots: this.history(),
      settings: this.settings(),
      groupPositions: this.groupLayout().positions,
      groupColors: this.groupColors().colors,
      savedViews: this.savedViews(),
      invitations: this.list().map(a => this.invitation(a.id)).filter(value => value.manualUrl || value.registerUrl).map(({ accountId, registerUrl, manualUrl, manualAt }) => ({ accountId, registerUrl, manualUrl, manualAt })),
    };
    return backup;
  }
  private planImportedSnapshots(input: Snapshot[]): Snapshot[] {
    const groups = new Map<string, Snapshot[]>(),
      importedIds = new Set(input.map((s) => s.id));
    for (const s of input) {
      const key = `${s.accountId}|${Date.parse(s.at)}`;
      const group = groups.get(key);
      if (group) group.push({ ...s });
      else groups.set(key, [{ ...s }]);
    }
    const planned = new Map<string, Snapshot>();
    const conflict = () =>
      new Error(
        "备份快照排序冲突或旧版同时间顺序无法确认；未导入任何数据，请使用完整 v3 备份",
      );
    for (const group of groups.values()) {
      const existing = this.connection
        .prepare(
          "SELECT id,record_order FROM snapshots WHERE account_id=? AND at_ms=?",
        )
        .all(group[0].accountId, Date.parse(group[0].at)) as {
        id: string;
        record_order: number;
      }[];
      for (const s of group)
        if (s.recordOrder === undefined) {
          const old = this.connection
            .prepare("SELECT record_order FROM snapshots WHERE id=?")
            .get(s.id) as { record_order: number } | undefined;
          s.recordOrder = old?.record_order;
        }
      const outside = existing.filter((s) => !importedIds.has(s.id));
      const occupied = new Set(outside.map((s) => s.record_order));
      for (const s of group)
        if (s.recordOrder !== undefined) {
          if (occupied.has(s.recordOrder)) throw conflict();
          occupied.add(s.recordOrder);
        }
      // A legacy tie omitting local IDs cannot establish relative order.
      if (outside.length && group.some((s) => s.recordOrder === undefined))
        throw conflict();
      if (group.some((s) => s.recordOrder === undefined)) {
        let previous: number | undefined;
        for (const s of group) {
          if (s.recordOrder === undefined) continue;
          // Legacy arrays are newest-first. Contradictory known anchors cannot
          // establish positions for new IDs without silently reordering history.
          if (previous !== undefined && previous <= s.recordOrder)
            throw conflict();
          previous = s.recordOrder;
        }
      }
      let high: number | undefined;
      for (let i = 0; i < group.length;) {
        if (group[i].recordOrder !== undefined) {
          high = group[i].recordOrder;
          i++;
          continue;
        }
        const start = i;
        while (i < group.length && group[i].recordOrder === undefined) i++;
        const low = group[i]?.recordOrder,
          count = i - start,
          values: number[] = [];
        // Fill integer slots between trusted anchors without renumbering IDs.
        // Signed ordinals also allow insertion below an existing ordinal 1.
        if (high !== undefined) {
          for (let n = high - 1; values.length < count; n--) {
            if (!Number.isSafeInteger(n) || (low !== undefined && n <= low))
              throw conflict();
            if (!occupied.has(n)) {
              values.push(n);
              occupied.add(n);
            }
          }
        } else if (low !== undefined) {
          for (let n = low + 1; values.length < count; n++) {
            if (!Number.isSafeInteger(n)) throw conflict();
            if (!occupied.has(n)) {
              values.push(n);
              occupied.add(n);
            }
          }
          values.reverse();
        } else
          for (let n = count; n > 0; n--) {
            values.push(n);
            occupied.add(n);
          }
        values.forEach((value, offset) => {
          group[start + offset].recordOrder = value;
        });
        high = values.at(-1);
      }
      for (const s of group) planned.set(s.id, s);
    }
    return input.map((s) => planned.get(s.id)!);
  }
  importBackup(input: unknown, preview: boolean) {
    let b = backupInput.parse(input),
      existing = new Set(this.list().map((a) => a.id)),
      report = {
        accounts: b.accounts.length,
        snapshots: b.snapshots.length,
        newAccounts: b.accounts.filter((a) => !existing.has(a.id)).length,
        updatedAccounts: b.accounts.filter((a) => existing.has(a.id)).length,
      };
    this.connection
      .transaction(() => {
        const existingSnapshotIds = new Set<string>();
        // A snapshot ID permanently belongs to its original account. Validate
        // inside the same transaction, including previews, before any writes.
        for (const s of b.snapshots) {
          const existingSnapshot = this.db
            .select({ accountId: snapshots.accountId })
            .from(snapshots)
            .where(eq(snapshots.id, s.id))
            .get();
          if (existingSnapshot && existingSnapshot.accountId !== s.accountId)
            throw new Error("备份快照与现有账号归属冲突；未导入任何数据");
          if (existingSnapshot) existingSnapshotIds.add(s.id);
        }
        const importedSnapshots = this.planImportedSnapshots(b.snapshots);
        const accountsWithNewSnapshots = new Set(
          importedSnapshots
            .filter((s) => !existingSnapshotIds.has(s.id))
            .map((s) => s.accountId),
        );
        const incomingById = new Map(importedSnapshots.map((s) => [s.id, s]));
        for (const a of b.accounts)
          if (a.balanceSnapshotId) {
            const referenced =
              incomingById.get(a.balanceSnapshotId) ||
              this.db
                .select({ accountId: snapshots.accountId })
                .from(snapshots)
                .where(eq(snapshots.id, a.balanceSnapshotId))
                .get();
            if (!referenced || referenced.accountId !== a.id)
              throw new Error(
                "备份快照余额引用不存在或不属于此账号；未导入任何数据",
              );
          }
        if (preview) return;
        for (const a of b.accounts) {
          let old = this.get(a.id),
            now = new Date().toISOString(),
            payload: Stored = {
              ...a.details,
              id: a.id,
              createdAt: a.createdAt,
              updatedAt: old ? nextUpdatedAt(old.updatedAt, now) : now,
              balance: old?.balance ?? null,
              balanceUnit: old?.balanceUnit || a.details.unit,
              lastSnapshotAt: old?.lastSnapshotAt ?? null,
              balanceSnapshotId:
                a.balanceSnapshotId ??
                (!accountsWithNewSnapshots.has(a.id)
                  ? old?.balanceSnapshotId
                  : null) ??
                null,
              rawQuota: old?.rawQuota ?? null,
              lastSyncAt: old?.lastSyncAt ?? null,
              lastSyncStatus: old?.lastSyncStatus || "never",
              lastSyncError: old?.lastSyncError ?? null,
              lastQueryDiagnostic: old?.lastQueryDiagnostic ?? null,
              lastSyncDiagnostic: old?.lastSyncDiagnostic ?? null,
            };
          this.db
            .insert(accounts)
            .values({ id: a.id, payload })
            .onConflictDoUpdate({ target: accounts.id, set: { payload } })
            .run();
        }
        // Manual links and register URLs are profile data. Older backups omit
        // this field and preserve same-identity local edits; remote caches are
        // always dropped on import rather than promoting old reads as current.
        const incomingInvitations = new Map((b.invitations ?? []).map(value => [value.accountId, value]));
        for (const account of b.accounts) {
          const current = this.invitation(account.id), imported = incomingInvitations.get(account.id);
          if (imported) this.writeInvitation(account.id, { ...current, ...imported, revision: current.revision + 1, fetched: null });
          else if (current.revision || current.manualUrl || current.registerUrl || current.fetched)
            this.writeInvitation(account.id, { ...current, revision: current.revision + 1, fetched: null });
        }
        // Known ordinals survive old partial imports; reject ambiguity before writes.
        for (const s of importedSnapshots) {
          const recordOrder = s.recordOrder!;
          this.db
            .insert(snapshots)
            .values({
              id: s.id,
              accountId: s.accountId,
              payload: { ...s, recordOrder },
              at: s.at,
              atMs: Date.parse(s.at),
              recordOrder,
            })
            .onConflictDoUpdate({
              target: snapshots.id,
              set: {
                accountId: s.accountId,
                payload: { ...s, recordOrder },
                at: s.at,
                atMs: Date.parse(s.at),
                recordOrder,
              },
            })
            .run();
        }
        if (
          this.connection
            .prepare(
              "SELECT 1 FROM snapshots GROUP BY account_id,at_ms,record_order HAVING COUNT(*)>1 LIMIT 1",
            )
            .get()
        )
          throw new Error("备份快照排序冲突；未导入任何数据");
        for (const a of b.accounts) {
          const history = this.history(a.id),
            preferredId = this.raw(a.id).payload.balanceSnapshotId;
          let latest = history.find((s) => s.id === preferredId) || history[0],
            row = this.raw(a.id);
          if (latest)
            this.db
              .update(accounts)
              .set({
                payload: {
                  ...row.payload,
                  balance: latest.amount,
                  balanceUnit: latest.unit,
                  lastSnapshotAt: latest.at,
                  balanceSnapshotId: latest.id,
                  rawQuota: latest.rawQuota,
                },
              })
              .where(eq(accounts.id, a.id))
              .run();
        }
        this.setSettings(b.settings);
        this.setMeta("savedViews", JSON.stringify(savedViewsSchema.parse(b.savedViews || [])));
        if (b.groupPositions !== undefined) {
          const next = groupLayoutSchema.parse({
            revision: this.groupLayout().revision + 1,
            positions: b.groupPositions,
          });
          this.setMeta("groupLayout", JSON.stringify(next));
        }
        if (b.groupColors !== undefined) {
          const next = groupColorsSchema.parse({
            revision: this.groupColors().revision + 1,
            colors: b.groupColors,
          });
          this.setMeta("groupColors", JSON.stringify(next));
        }
      })
      .immediate();
    return report;
  }
}
let instance: Store | undefined;
export function getStore() {
  if (instance) return instance;
  let dir = resolve(
    /*turbopackIgnore: true*/ process.env.RELAYDOCK_DATA_DIR ||
      join(process.cwd(), "data"),
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let keyFile = join(dir, "vault.key"),
    key: Buffer;
  if (process.env.RELAYDOCK_VAULT_KEY) {
    key = Buffer.from(process.env.RELAYDOCK_VAULT_KEY, "hex");
    if (key.length !== 32)
      throw new Error("RELAYDOCK_VAULT_KEY 必须是 64 个十六进制字符");
  } else {
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
      try {
        chmodSync(keyFile, 0o600);
      } catch {}
    }
    key = readFileSync(keyFile);
    if (key.length !== 32)
      throw new Error("主密钥长度不正确，请恢复原始 vault.key");
  }
  instance = new Store(join(dir, "atlas.sqlite"), key);
  if (!instance.getMeta("adminHash")) {
    let hash = process.env.RELAYDOCK_ADMIN_PASSWORD_HASH,
      pwd = process.env.RELAYDOCK_ADMIN_PASSWORD;
    if (hash?.startsWith("scrypt:")) instance.setMeta("adminHash", hash);
    else if (pwd && pwd.length >= 12)
      instance.setMeta("adminHash", hashPassword(pwd));
  }
  return instance;
}

















