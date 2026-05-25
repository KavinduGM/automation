import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

// AES-256-GCM at-rest encryption for third-party tokens, mirroring the YT
// project's approach so we can rotate keys with the same operational pattern.
// Key is 32 random bytes encoded as 64-char hex in env (TOKEN_ENCRYPTION_KEY).

function key(): Buffer {
  const hex = env().TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  return Buffer.from(hex, "hex");
}

export interface SealedBlob {
  cipher: string; // base64
  iv: string;     // base64 (12 bytes)
  tag: string;    // base64 (16 bytes)
}

export function seal(plain: string): SealedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    cipher: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open(blob: SealedBlob): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(blob.cipher, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

// ── Password hashing (scrypt — no native deps) ─────────────────────────────

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `s2$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s2") return false;
  const salt = Buffer.from(parts[1] ?? "", "hex");
  const expected = Buffer.from(parts[2] ?? "", "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(plain, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Signed approval tokens (HMAC-SHA256 over JSON payload) ─────────────────

import { createHmac } from "node:crypto";

export function signApprovalToken(payload: Record<string, unknown>, ttlSeconds = 60 * 60 * 24 * 3): string {
  const secret = env().SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyApprovalToken<T = Record<string, unknown>>(token: string): T | null {
  const secret = env().SESSION_SECRET;
  if (!secret) return null;
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { exp: number };
    if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body as T;
  } catch {
    return null;
  }
}
