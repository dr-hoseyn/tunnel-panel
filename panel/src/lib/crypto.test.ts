import { describe, expect, it, beforeAll } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto";

beforeAll(() => {
  // 32 zero bytes, base64-encoded -- fixed test key, not used anywhere real.
  process.env.AGENT_TOKEN_ENC_KEY = Buffer.alloc(32).toString("base64");
});

describe("encryptSecret/decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const plaintext = "super-secret-agent-token";
    const encoded = encryptSecret(plaintext);
    expect(decryptSecret(encoded)).toBe(plaintext);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
  });

  it("never leaks the plaintext in the encoded output", () => {
    const plaintext = "unmistakable-marker-value";
    expect(encryptSecret(plaintext)).not.toContain(plaintext);
  });

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const encoded = encryptSecret("hello world");
    const [iv, tag, data] = encoded.split(".");
    const tamperedData = Buffer.from(data, "base64");
    tamperedData[0] ^= 0xff;
    const tampered = `${iv}.${tag}.${tamperedData.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a malformed encoded string", () => {
    expect(() => decryptSecret("not-the-right-shape")).toThrow(/malformed/);
  });

  it("throws a clear error when the key is missing", () => {
    const saved = process.env.AGENT_TOKEN_ENC_KEY;
    delete process.env.AGENT_TOKEN_ENC_KEY;
    try {
      expect(() => encryptSecret("x")).toThrow(/AGENT_TOKEN_ENC_KEY/);
    } finally {
      process.env.AGENT_TOKEN_ENC_KEY = saved;
    }
  });
});
