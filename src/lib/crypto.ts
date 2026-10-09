import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
export function hashPassword(password: string) {
  let salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
}
export function verifyPassword(password: string, encoded: string) {
  try {
    let [kind, salt, hash] = encoded.split(":");
    if (kind !== "scrypt" || !salt || hash?.length !== 128) return false;
    let expected = Buffer.from(hash, "hex"),
      actual = scryptSync(password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
export function encryptSecret(text: string, key: Buffer) {
  let iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  let body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [
    iv.toString("base64"),
    c.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}
export function decryptSecret(text: string, key: Buffer) {
  let [iv, tag, body] = text.split(".");
  let d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(body, "base64")),
    d.final(),
  ]).toString("utf8");
}
export const tokenHash = (s: string) =>
  createHash("sha256").update(s).digest("hex");
