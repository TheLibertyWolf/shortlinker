import { describe, expect, it } from "vitest";
import { ipMatchesCidrs, isSecurityRoute } from "../src/auth.js";

describe("IP allowlists", () => {
  it("matches exact management addresses", () => {
    expect(ipMatchesCidrs("82.125.126.40", ["82.125.126.40/32"])).toBe(true);
    expect(ipMatchesCidrs("82.125.126.41", ["82.125.126.40/32"])).toBe(false);
  });

  it("supports networks and IPv4-mapped values", () => {
    expect(ipMatchesCidrs("203.0.113.42", ["203.0.113.0/24"])).toBe(true);
    expect(ipMatchesCidrs("::ffff:203.0.113.42", ["203.0.113.0/24"])).toBe(true);
  });
});

describe("security route gate", () => {
  it("allows security page and actions while first-login requirements are pending", () => {
    expect(isSecurityRoute("/admin/security")).toBe(true);
    expect(isSecurityRoute("/admin/security?error=invalid")).toBe(true);
    expect(isSecurityRoute("/admin/security/password")).toBe(true);
    expect(isSecurityRoute("/admin/security/totp")).toBe(true);
    expect(isSecurityRoute("/admin/profile")).toBe(true);
    expect(isSecurityRoute("/admin/profile/password")).toBe(true);
    expect(isSecurityRoute("/admin/security-bypass")).toBe(false);
    expect(isSecurityRoute("/admin/users")).toBe(false);
  });
});
