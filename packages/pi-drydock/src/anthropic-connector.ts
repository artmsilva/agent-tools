import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export interface AnthropicCredentialResolverOptions {
  readCredential?: () => Credential | undefined;
  refreshOAuth?: (credential: OAuthCredential) => Promise<OAuthCredential>;
  now?: () => number;
}

const OAUTH_REFRESH_SKEW_MS = 30_000;

export function createAnthropicCredentialHeadersResolver(
  options: AnthropicCredentialResolverOptions = {},
): () => Promise<Readonly<Record<string, string>>> {
  const readCredential = options.readCredential ?? (() => readStoredCredential("anthropic"));
  const refreshOAuth = options.refreshOAuth ?? refreshAnthropicOAuth;
  const now = options.now ?? Date.now;
  let cached: Credential | undefined;

  return async () => {
    cached = await resolveCredential(cached, readCredential, refreshOAuth, now());
    return credentialHeaders(cached);
  };
}

async function resolveCredential(
  cached: Credential | undefined,
  readCredential: () => Credential | undefined,
  refreshOAuth: (credential: OAuthCredential) => Promise<OAuthCredential>,
  now: number,
): Promise<Credential> {
  const credential = getCredential(cached, readCredential);
  if (credential.type !== "oauth") return credential;
  if (credential.expires > now + OAUTH_REFRESH_SKEW_MS) return credential;
  return refreshOAuth(credential);
}

function getCredential(cached: Credential | undefined, readCredential: () => Credential | undefined): Credential {
  const credential = cached ?? readCredential();
  if (!credential) throw new Error("Host Anthropic credential is not configured");
  return credential;
}

function credentialHeaders(credential: Credential): Readonly<Record<string, string>> {
  return credential.type === "oauth" ? oauthHeaders(credential.access) : apiKeyHeaders(credential.key);
}

async function refreshAnthropicOAuth(credential: OAuthCredential): Promise<OAuthCredential> {
  const oauth = anthropicProvider().auth.oauth;
  if (!oauth) throw new Error("Anthropic OAuth is unavailable");
  return oauth.refresh(credential);
}

function oauthHeaders(accessToken: string): Readonly<Record<string, string>> {
  if (!accessToken) throw new Error("Host Anthropic OAuth credential is invalid");
  return {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": "claude-cli/2.1.75",
    "x-app": "cli",
  };
}

function apiKeyHeaders(apiKey: string | undefined): Readonly<Record<string, string>> {
  if (!apiKey) throw new Error("Host Anthropic API credential is invalid");
  return { "x-api-key": apiKey };
}
