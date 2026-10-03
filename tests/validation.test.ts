import { describe, expect, it } from "vitest";
import { appendAllowedQuery, clampRetentionDays, generateSlug, normalizeHostname, validateDestination, validateHomepageRedirect, validateSlug } from "../src/validation.js";

describe("slug handling", () => {
  it("generates opaque Base62 slugs", () => {
    const values = new Set(Array.from({ length: 1000 }, () => generateSlug()));
    expect(values.size).toBe(1000);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9]{7}$/);
  });

  it("rejects reserved and malformed aliases", () => {
    expect(() => validateSlug("admin")).toThrow(/reserved/);
    expect(() => validateSlug("ab")).toThrow(/3/);
    expect(validateSlug("Campaign_2026")).toBe("Campaign_2026");
  });
});

describe("destination validation", () => {
  it("normalizes safe HTTPS destinations", () => {
    expect(validateDestination("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "http://127.0.0.1/a", "http://192.168.1.1/a", "https://user:pass@example.com/"])("rejects unsafe destination %s", (url) => {
    expect(() => validateDestination(url)).toThrow();
  });

  it("rejects direct platform loops", () => {
    expect(() => validateDestination("https://shurl.be/abcdefg", ["shurl.be"])).toThrow(/loops/);
  });

  it("passes query values without dangerous redirect parameters", () => {
    const result = appendAllowedQuery("https://example.com/?a=1", new URLSearchParams("campaign=x&redirect=https://evil.test"));
    expect(result).toContain("campaign=x");
    expect(result).not.toContain("redirect=");
  });
});

describe("domain validation", () => {
  it("normalizes IDN and trailing dots", () => {
    expect(normalizeHostname("Example.COM.")).toBe("example.com");
    expect(normalizeHostname("münich.example")).toBe("xn--mnich-kva.example");
  });

  it("accepts an external HTTPS homepage and rejects redirect loops", () => {
    expect(validateHomepageRedirect("https://shurl.be/", "links.example.com")).toBe("https://shurl.be");
    expect(() => validateHomepageRedirect("https://links.example.com", "links.example.com")).toThrow(/itself/);
    expect(() => validateHomepageRedirect("http://shurl.be", "links.example.com")).toThrow(/HTTPS/);
  });
});

describe("privacy retention", () => {
  it("clamps encrypted IP retention to 0–365 days", () => {
    expect(clampRetentionDays(-2)).toBe(0);
    expect(clampRetentionDays(30)).toBe(30);
    expect(clampRetentionDays(365)).toBe(365);
    expect(clampRetentionDays(900)).toBe(365);
  });
});
