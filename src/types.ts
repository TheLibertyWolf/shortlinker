export type UserSession = {
  sessionId: string;
  userId: string;
  username: string;
  email: string;
  displayName: string;
  locale: "en" | "fr";
  permissions: string[];
  allDomains: boolean;
  domainIds: string[];
  mfaVerified: boolean;
  requirePasswordChange: boolean;
  csrfToken: string;
};

export type TurnstileSettings = {
  enabled: boolean;
  siteKey: string;
  secretEncrypted: string;
};

export type DomainRow = {
  id: string;
  hostname: string;
  status: "pending" | "active" | "suspended";
  is_primary: boolean;
  verification_token: string;
  verified_at: Date | null;
  homepage_redirect: string | null;
};

export const permissions = [
  "links.read", "links.write", "links.delete", "stats.read", "stats.export", "stats.ip.read",
  "domains.read", "domains.write", "users.read", "users.write", "api.read", "api.write",
  "settings.read", "settings.write", "audit.read", "abuse.manage"
] as const;
