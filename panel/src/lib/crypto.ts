import crypto from "node:crypto";

/**
 * AES-256-GCM helpers for encrypting secrets at rest -- agent bearer tokens
 * (Server.agentTokenEnc) and tunnel shared secrets/PSKs (Tunnel.secretEnc,
 * TunnelBackup.secretEnc). Closes the "stored in cleartext" gap both
 * READMEs previously flagged for phase 1.
 *
 * Output format is self-contained (iv + authTag + ciphertext, each
 * base64, dot-separated) so no extra columns are needed to store them
 * alongside the ciphertext.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function loadKey(): Buffer {
  const raw = process.env.AGENT_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "AGENT_TOKEN_ENC_KEY is not set -- generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("AGENT_TOKEN_ENC_KEY is not valid base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `AGENT_TOKEN_ENC_KEY must decode to exactly 32 bytes, got ${key.length}`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptSecret(encoded: string): string {
  const key = loadKey();
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed encrypted secret (expected iv.authTag.ciphertext)");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
