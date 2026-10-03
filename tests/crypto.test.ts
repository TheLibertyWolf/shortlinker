import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hashPassword, sha256, verifyPassword } from "../src/crypto.js";

describe("secret handling", () => {
  it("encrypts authenticated values with randomized ciphertext", () => {
    const first = encrypt("turnstile-secret");
    const second = encrypt("turnstile-secret");
    expect(first).not.toBe(second);
    expect(decrypt(first)).toBe("turnstile-secret");
    const parts = first.split(".");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    expect(() => decrypt(parts.join("."))).toThrow();
  });

  it("hashes passwords with Argon2id", async () => {
    const hash = await hashPassword("a sufficiently long password");
    expect(hash).toContain("argon2id");
    expect(await verifyPassword(hash, "a sufficiently long password")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("produces stable SHA-256 digests", () => {
    expect(sha256("shortlinker")).toHaveLength(64);
    expect(sha256("shortlinker")).toBe(sha256("shortlinker"));
  });
});
