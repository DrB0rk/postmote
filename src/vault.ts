import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const scrypt = promisify(scryptCb);

export async function ensureMasterKey(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dataDir, 0o700);
  const path = join(dataDir, "master.key");
  try {
    const key = await readFile(path);
    if (key.length !== 32) throw new Error("Master key file has invalid length");
    if (process.platform !== "win32") await chmod(path, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  await writeFile(path, key, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function encryptSecret(dataDir: string, mailboxId: string, plaintext: string): Promise<string> {
  const key = await readFile(join(dataDir, "master.key"));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(mailboxId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export async function decryptSecret(dataDir: string, mailboxId: string, encoded: string): Promise<string> {
  const [ivPart, tagPart, ciphertextPart, ...extra] = encoded.split(".");
  if (!ivPart || !tagPart || !ciphertextPart || extra.length) throw new Error("Invalid encrypted secret");
  const key = await readFile(join(dataDir, "master.key"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAAD(Buffer.from(mailboxId));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
}

export async function hashOwnerPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) throw new Error("Owner password must be between 12 and 1024 characters");
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyOwnerPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltPart, hashPart, ...extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltPart || !hashPart || extra.length) return false;
  const expected = Buffer.from(hashPart, "base64url");
  const actual = (await scrypt(password, Buffer.from(saltPart, "base64url"), expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
