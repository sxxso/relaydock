import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, loadEnvFile } from "node:process";
import { resolve, join } from "node:path";
const file = resolve(".env.local"),
  reset = process.argv.includes("--reset-password");
if (existsSync(file) && !reset) {
  console.log(
    "已存在 .env.local；不会覆盖。忘记密码时请停止服务，运行 npm run setup -- --reset-password。",
  );
  process.exit(0);
}
// Read the same local configuration before resolving the database path.
// Node preserves already-set shell variables when loading an env file.
if (existsSync(file)) loadEnvFile(file);
let password;
if (process.argv.includes("--generate"))
  password = randomBytes(18).toString("base64url");
else {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question("设置管理员密码（至少 12 位，仅在本机使用）：");
  rl.close();
}
if (!password || password.length < 12 || password.length > 128) {
  console.error("密码须为 12–128 个字符。");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex"),
  hash = `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
let previous = existsSync(file)
  ? readFileSync(file, "utf8").replace(
      /^RELAYDOCK_ADMIN_PASSWORD(?:_HASH)?=.*\r?\n?/gm,
      "",
    )
  : "";
function writeConfig() {
  writeFileSync(
    file,
    `# 本机私有配置；禁止提交或分享\nRELAYDOCK_ADMIN_PASSWORD_HASH=${hash}\n${previous}`,
    { mode: 0o600 },
  );
}
try {
  const dbPath = join(
    resolve(process.env.RELAYDOCK_DATA_DIR || "data"),
    "atlas.sqlite",
  );
  if (reset && existsSync(dbPath)) {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run("adminHash", hash);
        db.exec("DELETE FROM sessions");
        // Only persist the new configuration after both database operations succeed.
        writeConfig();
      }).immediate();
    } finally {
      db.close();
    }
  } else {
    writeConfig();
  }
  console.log("管理员密码哈希已写入 .env.local。请启动或重启服务。");
  if (process.argv.includes("--generate"))
    console.log(`首次管理员密码（请保存，登录后可修改）：${password}`);
} catch {
  console.error(
    "密码初始化或重置失败。请确认已停止服务，并检查数据目录、数据库和配置文件权限；不要用新密码登录。",
  );
  process.exitCode = 1;
}
