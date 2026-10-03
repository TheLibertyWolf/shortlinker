import { createGuardrails, generateSecret, generateURI, verify } from "otplib";

// otplib 12 generated 10-byte secrets by default. Keep those enrolled users
// compatible while all newly generated secrets use the v13 20-byte default.
const legacySecretGuardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

export function createTotpSecret(): string {
  return generateSecret();
}

export function createTotpUri(label: string, issuer: string, secret: string): string {
  return generateURI({ label, issuer, secret });
}

export async function verifyTotpToken(token: string, secret: string): Promise<boolean> {
  return (await verify({ token, secret, guardrails: legacySecretGuardrails })).valid;
}
