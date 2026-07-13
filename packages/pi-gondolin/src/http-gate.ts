/**
 * Build the Gondolin HTTP hooks from an {@link AllowList}.
 *
 * Two gates, both routed through the same allowlist so a host is prompted for at
 * most once (single-flight in AllowList):
 *   - isRequestAllowed(request): the HTTP-layer policy (host from the URL).
 *   - isIpAllowed(info):         the DNS/IP-layer policy (resolved hostname).
 *
 * `allowedHosts` is intentionally left undefined so Gondolin's built-in host
 * check is a no-op ("*") and our dynamic callbacks own the decision. Internal IP
 * ranges stay blocked (blockInternalRanges) for SSRF protection.
 *
 * Secrets (GitHub token) are injected host-side only for their allowed hosts;
 * the guest sees an opaque placeholder, never the real token.
 */
import { createHttpHooks, type HttpHooks, type SecretDefinition } from "@earendil-works/gondolin";
import type { AllowList } from "./allowlist.ts";

export interface HttpGateResult {
	httpHooks: HttpHooks;
	/** Placeholder env to merge into the VM env (e.g. GITHUB_TOKEN=<placeholder>). */
	env: Record<string, string>;
	/** Whether a real GitHub token was found and wired for injection. */
	githubTokenWired: boolean;
}

/** Hosts the GitHub token may be injected into. */
const GITHUB_SECRET_HOSTS = [
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"uploads.github.com",
	"*.githubusercontent.com",
	"ghcr.io",
];

function hostnameOf(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

export function buildHttpGate(allowList: AllowList, githubToken: string | undefined): HttpGateResult {
	const secrets: Record<string, SecretDefinition> = {};
	if (githubToken) {
		secrets.GITHUB_TOKEN = { hosts: GITHUB_SECRET_HOSTS, value: githubToken };
		secrets.GH_TOKEN = { hosts: GITHUB_SECRET_HOSTS, value: githubToken };
	}

	const { httpHooks, env } = createHttpHooks({
		// undefined => Gondolin's built-in host check is "*"; our callbacks decide.
		allowedHosts: undefined,
		blockInternalRanges: true,
		secrets,
		isRequestAllowed: async (request) => {
			const host = hostnameOf(request.url);
			if (!host) return false;
			return allowList.check(host, `${request.method} ${host}`);
		},
		isIpAllowed: async (info) => {
			return allowList.check(info.hostname, `connect ${info.hostname}`);
		},
	});

	return { httpHooks, env, githubTokenWired: Boolean(githubToken) };
}
