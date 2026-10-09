import * as filesystem from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createDecipheriv } from "node:crypto";

/** @typedef {{id:string,status:"PASS"|"WARN"|"FAIL",code:string,message:string,advice:string}} Check */
/** @typedef {{schemaVersion:number,status:"PASS"|"WARN"|"FAIL",exitCode:number,checks:Check[]}} Report */
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_KEY_BYTES = 32;
const MAX_SECRET_BYTES = 64 * 1024;
/** @returns {Check} */
function check(id, status, code, message, advice = "") {
  return { id, status, code, message, advice };
}
/** @param {Check[]} checks @returns {Report} */
export function doctorReport(checks) {
  const status = checks.some((c) => c.status === "FAIL") ? "FAIL" : checks.some((c) => c.status === "WARN") ? "WARN" : "PASS";
  return { schemaVersion: 1, status, exitCode: status === "FAIL" ? 2 : status === "WARN" ? 1 : 0, checks };
}
export function checkNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 20));
}
function passwordHashValid(value) {
  return typeof value === "string" && /^scrypt:[^:\x00-\x20\x7f]{1,256}:[a-fA-F0-9]{128}$/.test(value);
}
function proxyValid(input) {
  try {
    if (input.length > 4096 || input.trim() !== input || /[\x00-\x20\x7f\\]/.test(input) || !/^https?:\/\/[^/]+\/?$/i.test(input) || /[?#]/.test(input)) return false;
    const url = new URL(input), user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    return ["http:", "https:"].includes(url.protocol) && url.pathname === "/" && !url.search && !url.hash && !/[\x00-\x1f\x7f]/.test(user + password) && !user.includes(":") && !(!user && password) && Number(url.port || (url.protocol === "https:" ? 443 : 80)) >= 1;
  } catch { return false; }
}
/** Syntax only: no DNS resolution, sockets, HTTP clients or application imports. */
export function checkConfiguration(env) {
  /** @type {Check[]} */ const checks = [];
  const input = env.RELAYDOCK_PUBLIC_URL;
  if (!input) checks.push(check("public_url", "WARN", "PUBLIC_URL_LOCAL_ONLY", "未配置公开地址，仅适合默认本机访问", "远程 HTTPS 部署须配置 RELAYDOCK_PUBLIC_URL；本机使用可保留此警告。"));
  else {
    let valid = false;
    try {
      const url = new URL(input);
      valid = input.length <= 2048 && input.trim() === input && !/[\x00-\x20\x7f\\?#]/.test(input) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    } catch {}
    checks.push(valid ? check("public_url", "PASS", "PUBLIC_URL_VALID", "公开地址格式符合本机或 HTTPS 部署要求", "只检查格式，不验证域名、反向代理或证书。") : check("public_url", "FAIL", "PUBLIC_URL_INVALID", "公开地址配置无效", "RELAYDOCK_PUBLIC_URL 应为不含登录信息、路径、参数的 HTTPS origin；HTTP 只用于本机回环。"));
  }
  checks.push([undefined, "", "system", "cloudflare"].includes(env.RELAYDOCK_DNS_MODE) ? check("dns", "PASS", "DNS_CONFIG_VALID", "DNS 配置格式正确", "未执行 DNS 请求或联网验证。") : check("dns", "FAIL", "DNS_CONFIG_INVALID", "DNS 模式配置无效", "RELAYDOCK_DNS_MODE 仅允许 system 或 cloudflare。"));
  const proxy = env.RELAYDOCK_QUERY_PROXY_URL;
  checks.push(!proxy ? check("query_proxy", "PASS", "QUERY_PROXY_DISABLED", "未配置查询代理") : proxyValid(proxy) ? check("query_proxy", "PASS", "QUERY_PROXY_CONFIG_VALID", "查询代理配置格式正确", "未连接代理；连通性和地址策略须在以后主动查询时验证。") : check("query_proxy", "FAIL", "QUERY_PROXY_CONFIG_INVALID", "查询代理配置无效", "只支持 HTTP/HTTPS CONNECT 地址及可选 URL 编码的 Basic 认证；不接受路径、参数或 SOCKS。"));
  const hosts = (env.RELAYDOCK_PRIVATE_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hostsValid = hosts.length <= 100 && hosts.every((host) => host.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.split(".").every((label) => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")));
  checks.push(hostsValid ? check("private_hosts", "PASS", "PRIVATE_HOSTS_CONFIG_VALID", "私有主机白名单格式正确", "仅检查小写精确主机名，不解析地址或证明访问被允许。") : check("private_hosts", "FAIL", "PRIVATE_HOSTS_CONFIG_INVALID", "私有主机白名单格式无效", "使用逗号分隔的小写精确主机名；不接受通配符、协议、路径或端口。"));
  return checks;
}
function optionalStat(fs, file) {
  try { return fs.statSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function directoryCheck(fs, directory) {
  try {
    let current = directory, stat = optionalStat(fs, current);
    if (stat && !stat.isDirectory()) return check("data_dir", "FAIL", "DATA_DIR_INVALID", "数据目录不是目录", "修正 RELAYDOCK_DATA_DIR，勿覆盖现有文件。目录值不会显示。" );
    const missing = !stat;
    while (!stat && dirname(current) !== current) { current = dirname(current); stat = optionalStat(fs, current); }
    if (!stat?.isDirectory()) throw new Error();
    fs.accessSync(current, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return missing ? check("data_dir", "WARN", "DATA_DIR_MISSING", "数据目录尚未创建，已有父目录权限检查通过", "首次启动会创建目录；本命令不会创建。权限检查不保证实际写入或磁盘空间。") : check("data_dir", "PASS", "DATA_DIR_ACCESS_OK", "数据目录读写与访问权限检查通过", "未写入探针文件；权限、ACL、只读挂载或磁盘空间仍可能影响真实写入。" );
  } catch { return check("data_dir", "FAIL", "DATA_DIR_PERMISSION_DENIED", "无法访问数据目录或写入其父目录", "检查服务运行用户、目录权限、容器挂载与 RELAYDOCK_DATA_DIR；本命令不修改权限。" ); }
}
function sameFile(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;
}
/** Read a bounded regular file; never use SQLite to open the original path. */
function readBounded(fs, file, max) {
  let fd;
  try {
    // Stat first avoids opening FIFOs/devices (which may block).
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) throw new Error();
    fd = fs.openSync(file, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > max || !sameFile(stat, before)) throw new Error();
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!n) throw new Error();
      offset += n;
    }
    return { buffer, changed: !sameFile(before, fs.fstatSync(fd)) || !sameFile(before, fs.statSync(file)) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function recoveryFilePending(fs, file, suffix = "-wal") {
  const stat = optionalStat(fs, `${file}${suffix}`);
  if (stat && !stat.isFile()) throw new Error();
  return !!stat && stat.size > 0;
}
function databaseCheck(fs, file, Database) {
  try {
    const stat = optionalStat(fs, file);
    if (!stat) {
      if (["-wal", "-shm", "-journal"].some((suffix) => optionalStat(fs, `${file}${suffix}`)))
        return { exists: true, result: check("database", "FAIL", "DATABASE_RECOVERY_INCOMPLETE", "主数据库缺失但仍有恢复侧车文件", "停止初始化，保留 WAL/SHM/回滚日志和原密钥，恢复完整备份；不要启动空库或删除残留文件。") };
      return { exists: false, result: check("database", "WARN", "DATABASE_UNINITIALIZED", "数据库尚未初始化", "首次启动会创建空数据库；自检不创建数据库或演示数据。") };
    }
    if (!stat.isFile()) return { exists: true, result: check("database", "FAIL", "DATABASE_INVALID_FILE", "数据库路径不是普通文件", "检查数据目录；勿删除或覆盖来源不明的文件。") };
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    if (recoveryFilePending(fs, file)) return { exists: true, result: check("database", "WARN", "DATABASE_WAL_PENDING", "存在未合并 WAL，数据库健康及凭据匹配未检查", "安全停止服务后重新自检；不要删除 WAL/SHM 或只复制主文件。") };
    if (recoveryFilePending(fs, file, "-journal")) return { exists: true, result: check("database", "WARN", "DATABASE_JOURNAL_PENDING", "存在非空回滚日志，数据库恢复状态未验证", "保留主库、回滚日志和原密钥，停止服务并检查完整备份；本命令不执行恢复或删除日志。") };
    if (stat.size > MAX_DATABASE_BYTES) return { exists: true, result: check("database", "WARN", "DATABASE_TOO_LARGE", "数据库超过 64 MiB，未加载到内存检查", "停止服务后用可信 SQLite 工具对完整备份检查；本次不保证数据库健康或密钥匹配。") };
    const { buffer, changed } = readBounded(fs, file, MAX_DATABASE_BYTES);
    if (changed || recoveryFilePending(fs, file) || recoveryFilePending(fs, file, "-journal")) return { exists: true, result: check("database", "WARN", "DATABASE_CHANGED", "数据库读取期间变化，未完成可靠检查", "停止服务后重试；自检不会对原数据库加写锁或合并 WAL。") };
    if (buffer.length < 100 || buffer.subarray(0, 16).toString("binary") !== "SQLite format 3\0" || ![1, 2].includes(buffer[18]) || ![1, 2].includes(buffer[19])) throw new Error();
    // SQLite deserialization cannot use WAL mode. There is no pending recovery journal here;
    // normalize ONLY the in-memory header, never the on-disk bytes.
    buffer[18] = 1; buffer[19] = 1;
    const db = new Database(buffer, { readonly: true });
    try {
      const quick = db.pragma("quick_check(1)");
      if (quick.length !== 1 || Object.values(quick[0])[0] !== "ok") throw new Error();
      const columns = {};
      for (const [table, required] of Object.entries({ accounts: ["id", "payload", "secret"], snapshots: ["id", "account_id", "payload", "at"], meta: ["key", "value"], sessions: ["id", "expires", "csrf"] })) {
        const type = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table)?.type;
        const names = new Set(db.pragma(`table_info(${table})`).map((row) => row.name));
        columns[table] = names;
        if (type !== "table" || required.some((name) => !names.has(name))) {
          db.close();
          return { exists: true, result: check("database", "FAIL", "DATABASE_SCHEMA_INVALID", "数据库缺少必要的应用表或列", "核对是否使用本应用的完整数据库备份；不要通过手改表结构修复。") };
        }
      }
      const legacy = !columns.snapshots.has("at_ms") || !columns.snapshots.has("record_order");
      return { exists: true, db, result: legacy ? check("database", "WARN", "DATABASE_SCHEMA_LEGACY", "数据库健康，旧版排序元数据尚未迁移", "先保留完整备份；应用启动时会进行既有排序列迁移，自检不执行迁移。") : check("database", "PASS", "DATABASE_HEALTHY", "数据库只读快检及必要表结构检查通过", "未检查所有历史 payload 的业务内容；请在停止服务后运行，以避免并发写入。") };
    } catch (error) { if (db.open) db.close(); throw error; }
  } catch (error) {
    return { exists: true, result: error?.code === "EACCES" || error?.code === "EPERM" ? check("database", "FAIL", "DATABASE_PERMISSION_DENIED", "数据库读写权限检查失败", "检查服务用户和数据库文件权限；不修改文件或权限。") : check("database", "FAIL", "DATABASE_UNREADABLE", "数据库无法读取或只读快检失败", "停止服务并保留数据库、WAL/SHM、回滚日志和对应主密钥，检查权限或恢复完整备份；原始错误不会输出。") };
  }
}
function adminCheck(env, state) {
  if (state.db) {
    const saved = state.db.prepare("SELECT value FROM meta WHERE key='adminHash'").get()?.value;
    if (saved) return passwordHashValid(saved) ? check("admin", "PASS", "ADMIN_DATABASE_READY", "数据库已有有效格式的管理员密码哈希", "数据库中现有密码优先；环境密码仅用于首次初始化，不会重置已有密码。") : check("admin", "FAIL", "ADMIN_DATABASE_INVALID", "数据库中管理员密码哈希格式无效", "保留完整备份，停止服务后使用 npm run setup -- --reset-password；只改环境密码不会修复已有哈希。" );
  } else if (state.exists) {
    const initial = initializationAdminCheck(env);
    return initial.status === "FAIL" ? check("admin", "WARN", "ADMIN_DATABASE_UNVERIFIED", "数据库未完成检查，无法确认已保存的管理员配置", "数据库检查完成后再判断；未将未验证的现有配置当作首次空库。") : check("admin", "WARN", "ADMIN_DATABASE_UNVERIFIED", "初始管理员配置有效，但数据库中现有配置未验证", "停止服务后重试数据库检查；初始配置不会覆盖已有密码。" );
  }
  return initializationAdminCheck(env);
}
function initializationAdminCheck(env) {
  const hash = env.RELAYDOCK_ADMIN_PASSWORD_HASH, password = env.RELAYDOCK_ADMIN_PASSWORD;
  if (hash?.startsWith("scrypt:")) return passwordHashValid(hash) ? check("admin", "PASS", "ADMIN_INITIAL_HASH_READY", "初始管理员密码哈希格式正确", "用于首次初始化；未验证密码本身。") : check("admin", "FAIL", "ADMIN_INITIAL_HASH_INVALID", "初始管理员密码哈希格式无效", "在本机运行 npm run setup 生成配置；scrypt 哈希不能手工截断或粘贴不完整内容。" );
  if (password && password.length >= 12 && password.length <= 256) return check("admin", "PASS", "ADMIN_INITIAL_PASSWORD_READY", "初始管理员密码长度符合登录要求", "推荐 npm run setup 生成哈希；本命令不会显示密码。" );
  return check("admin", "FAIL", "ADMIN_UNCONFIGURED", "未配置有效的初始管理员认证", "在本机运行 npm run setup，或配置至少 12 位且不超过 256 位的管理员密码。" );
}
function credentialMatches(secret, key) {
  if (typeof secret !== "string" || secret.length > MAX_SECRET_BYTES) return false;
  const fields = secret.split(".");
  if (fields.length !== 3 || fields.some((s) => s.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))) return false;
  const [iv, tag, body] = fields.map((s) => Buffer.from(s, "base64"));
  if (iv.length !== 12 || tag.length !== 16) return false;
  let plaintext, final;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plaintext = decipher.update(body); final = decipher.final();
    return true;
  } catch { return false; } finally { plaintext?.fill(0); final?.fill(0); }
}
function vaultCheck(fs, dir, env, state) {
  let key;
  try {
    const input = env.RELAYDOCK_VAULT_KEY;
    if (input) {
      if (!/^[a-fA-F0-9]{64}$/.test(input)) return check("vault", "FAIL", "VAULT_ENV_INVALID", "环境主密钥格式无效", "RELAYDOCK_VAULT_KEY 必须为恰好 64 个十六进制字符；已有数据须使用原密钥，勿随意替换。" );
      key = Buffer.from(input, "hex");
    } else {
      const file = join(dir, "vault.key"), stat = optionalStat(fs, file);
      if (!stat) return state.exists ? check("vault", "FAIL", "VAULT_MISSING", "已有数据库，但原始主密钥缺失", "恢复对应 vault.key 或原 RELAYDOCK_VAULT_KEY；不要生成新密钥覆盖旧数据。" ) : check("vault", "WARN", "VAULT_UNINITIALIZED", "主密钥尚未初始化", "首次启动会持久化主密钥；本命令不会生成。完整迁移必须保留数据库与对应密钥。" );
      if (!stat.isFile() || stat.size !== MAX_KEY_BYTES) return check("vault", "FAIL", "VAULT_FILE_INVALID", "持久化主密钥文件格式无效", "恢复原始的 32 字节 vault.key；不要删除它以触发生成替代密钥。" );
      const read = readBounded(fs, file, MAX_KEY_BYTES);
      key = read.buffer;
      if (read.changed || key.length !== MAX_KEY_BYTES) throw new Error();
    }
    if (state.db) {
      for (const row of state.db.prepare("SELECT secret FROM accounts WHERE secret IS NOT NULL").iterate()) {
        if (!credentialMatches(row.secret, key)) return check("vault", "FAIL", "VAULT_CREDENTIALS_MISMATCH", "主密钥不能认证全部已保存的加密凭据", "停止服务并恢复与数据库配套的原密钥/完整备份；不显示凭据或解密结果，不修改数据。" );
      }
      return check("vault", "PASS", "VAULT_READY", "主密钥格式正确，已有加密凭据认证通过", "空库没有凭据可用于匹配验证；未发起任何站点查询。" );
    }
    return state.exists ? check("vault", "WARN", "VAULT_UNVERIFIED", "主密钥格式正确，但与已有数据库的匹配未验证", "先完成数据库检查；密钥长度正确不等于可恢复已有凭据。" ) : check("vault", "PASS", "VAULT_FORMAT_READY", "主密钥格式正确，尚无数据库可验证匹配", "安全保存原始密钥；本命令不会生成、替换或显示它。" );
  } catch { return check("vault", "FAIL", "VAULT_UNREADABLE", "主密钥无法读取或在检查期间发生变化", "检查服务运行用户、文件权限，并恢复原始密钥；不会显示路径或异常详情。" ); }
  finally { key?.fill(0); }
}
/**
 * @param {{cwd?:string,env?:Record<string,string|undefined>,nodeVersion?:string,fs?:typeof filesystem,loadDatabase?:()=>Promise<any>}} options
 * @returns {Promise<Report>}
 */
export async function runDoctor({ cwd = process.cwd(), env = process.env, nodeVersion = process.versions.node, fs = filesystem, loadDatabase = async () => (await import("better-sqlite3")).default } = {}) {
  /** @type {Check[]} */ const checks = [];
  if (!checkNodeVersion(nodeVersion)) return doctorReport([check("node", "FAIL", "NODE_UNSUPPORTED", "Node 版本不符合要求", "使用 Node.js 22.20.0 或更高版本后重新检查；本次未读取数据库或密钥。" )]);
  checks.push(check("node", "PASS", "NODE_SUPPORTED", "Node 版本符合 22.20.0+ 要求"));
  checks.push(...checkConfiguration(env));
  let dir;
  try {
    const input = env.RELAYDOCK_DATA_DIR || "data";
    if (input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw new Error();
    dir = resolve(cwd, input);
  } catch { return doctorReport([...checks, check("data_dir", "FAIL", "DATA_DIR_INVALID", "数据目录配置无效", "检查 RELAYDOCK_DATA_DIR；不输出实际路径。")]); }
  checks.push(directoryCheck(fs, dir));
  let Database;
  try {
    Database = await loadDatabase();
    const probe = new Database(":memory:"); probe.close();
    checks.push(check("sqlite_driver", "PASS", "SQLITE_DRIVER_READY", "SQLite 本地驱动可用"));
  } catch {
    Database = undefined;
    checks.push(check("sqlite_driver", "FAIL", "SQLITE_DRIVER_UNAVAILABLE", "SQLite 本地驱动不可用", "确认 Node 版本并使用锁文件 npm ci 重新安装本机依赖；本命令不安装或联网。" ));
  }
  const file = join(dir, "atlas.sqlite");
  let state;
  if (Database) state = databaseCheck(fs, file, Database);
  else {
    let exists = true;
    try { exists = !!optionalStat(fs, file); } catch {}
    state = { exists, result: check("database", "WARN", "DATABASE_DRIVER_BLOCKED", "未完成数据库检查", "先修复本地 SQLite 驱动，再重新自检。") };
  }
  try {
    checks.push(state.result, adminCheck(env, state), vaultCheck(fs, dir, env, state));
    return doctorReport(checks);
  } finally { state.db?.close(); }
}



