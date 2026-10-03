import { describe, expect, it } from "vitest";
import { generate, generateSecret, generateURI, verify } from "otplib";

describe("TOTP compatibility", () => {
  it("generates authenticator-compatible secrets, URIs and valid tokens", async () => {
    const secret = generateSecret();
    const token = await generate({ secret });
    const result = await verify({ secret, token });
    const uri = generateURI({ issuer: "Shortlinker", label: "admin@example.test", secret });

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(token).toMatch(/^\d{6}$/);
    expect(result.valid).toBe(true);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Shortlinker:admin%40example\.test\?/);
  });
});
