/**
 * Egress allowlist with interactive, single-flight approval.
 *
 * A host is permitted if it matches a pattern in either the committed default
 * list (config/allowlist.default.json) or the user's saved list
 * (~/.pi/agent/gondolin/allowlist.json). Anything else triggers a prompt:
 *
 *   Allow once  -> permitted for this session only (in-memory)
 *   Allow & save -> permitted now and written to the saved list
 *   Deny        -> blocked for the rest of this session (no re-prompt spam)
 *
 * Both the HTTP request gate and the DNS/IP gate call {@link AllowList.check};
 * concurrent calls for the same host share a single prompt via {@link pending}.
 *
 * When no interactive UI is available (print/json modes, headless cron), unknown
 * hosts fail closed (denied) — a sandbox that silently allows in headless mode
 * would defeat the point.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Decision = "allow-once" | "allow-save" | "deny";

/** Asks the human to make a decision about a host. Returns their choice. */
export type Prompter = (host: string, reason: string | undefined) => Promise<Decision>;

export interface AllowListOptions {
	/** Path to the committed default list shipped with the package. */
	defaultsPath: string;
	/** Path to the user's persisted list (created on first save). */
	savedPath: string;
	/** Optional logger for notable events (denials in headless mode, saves). */
	log?: (message: string) => void;
}

function readHosts(file: string): string[] {
	try {
		if (!existsSync(file)) return [];
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { hosts?: unknown };
		if (!Array.isArray(parsed.hosts)) return [];
		return parsed.hosts.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase());
	} catch {
		return [];
	}
}

/**
 * Does `host` match `pattern`?
 *  - exact:        api.github.com  ~ api.github.com
 *  - wildcard:     *.github.com    ~ api.github.com  (and github.com)
 *  - bare domain:  github.com      ~ github.com and any *.github.com subdomain
 */
export function hostMatches(host: string, pattern: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	const p = pattern.toLowerCase().replace(/\.$/, "");
	if (!p) return false;
	if (p === "*") return true;
	if (p.startsWith("*.")) {
		const suffix = p.slice(1); // ".github.com"
		return h === p.slice(2) || h.endsWith(suffix);
	}
	if (h === p) return true;
	// bare-domain: allow subdomains of the pattern too
	return h.endsWith(`.${p}`);
}

export class AllowList {
	readonly #defaults: string[];
	readonly #saved: Set<string>;
	readonly #sessionAllow = new Set<string>();
	readonly #sessionDeny = new Set<string>();
	readonly #pending = new Map<string, Promise<boolean>>();
	readonly #savedPath: string;
	readonly #log: (message: string) => void;
	#prompter: Prompter | undefined;

	constructor(options: AllowListOptions) {
		this.#defaults = readHosts(options.defaultsPath);
		this.#saved = new Set(readHosts(options.savedPath));
		this.#savedPath = options.savedPath;
		this.#log = options.log ?? (() => {});
	}

	/** Wire up (or replace) the interactive prompter as the UI context changes. */
	setPrompter(prompter: Prompter | undefined): void {
		this.#prompter = prompter;
	}

	/** All statically-permitted patterns (defaults + saved + session), for display. */
	patterns(): { defaults: string[]; saved: string[]; session: string[] } {
		return {
			defaults: [...this.#defaults],
			saved: [...this.#saved],
			session: [...this.#sessionAllow],
		};
	}

	#isStaticallyAllowed(host: string): boolean {
		const h = host.toLowerCase();
		for (const p of this.#defaults) if (hostMatches(h, p)) return true;
		for (const p of this.#saved) if (hostMatches(h, p)) return true;
		for (const p of this.#sessionAllow) if (hostMatches(h, p)) return true;
		return false;
	}

	/** Add a pattern. `persist` writes it to the saved list on disk. */
	add(pattern: string, persist: boolean): void {
		const p = pattern.trim().toLowerCase();
		if (!p) return;
		if (persist) {
			this.#saved.add(p);
			this.#persist();
		} else {
			this.#sessionAllow.add(p);
		}
		// A freshly-allowed host should clear any session denial.
		this.#sessionDeny.delete(p);
	}

	/** Remove a pattern from the saved list (and session). */
	remove(pattern: string): void {
		const p = pattern.trim().toLowerCase();
		this.#saved.delete(p);
		this.#sessionAllow.delete(p);
		this.#persist();
	}

	#persist(): void {
		try {
			mkdirSync(path.dirname(this.#savedPath), { recursive: true });
			writeFileSync(
				this.#savedPath,
				`${JSON.stringify({ hosts: [...this.#saved].sort() }, null, 2)}\n`,
				"utf8",
			);
		} catch (error) {
			this.#log(`failed to persist allowlist: ${(error as Error).message}`);
		}
	}

	/**
	 * Is egress to `host` permitted? Prompts (once, deduped) when unknown.
	 */
	async check(host: string, reason?: string): Promise<boolean> {
		const key = host.toLowerCase();
		if (this.#isStaticallyAllowed(key)) return true;
		if (this.#sessionDeny.has(key)) return false;

		const inFlight = this.#pending.get(key);
		if (inFlight) return inFlight;

		const decision = this.#decide(key, reason);
		this.#pending.set(key, decision);
		decision.finally(() => this.#pending.delete(key));
		return decision;
	}

	async #decide(host: string, reason?: string): Promise<boolean> {
		const prompter = this.#prompter;
		if (!prompter) {
			this.#log(`blocked egress to ${host} (no interactive UI to approve; failing closed)`);
			this.#sessionDeny.add(host);
			return false;
		}
		let choice: Decision;
		try {
			choice = await prompter(host, reason);
		} catch {
			// Dialog dismissed / errored -> treat as deny, but do not make it sticky
			// so the next attempt can prompt again.
			return false;
		}
		switch (choice) {
			case "allow-save":
				this.add(host, true);
				this.#log(`allowed + saved ${host}`);
				return true;
			case "allow-once":
				this.add(host, false);
				return true;
			case "deny":
				this.#sessionDeny.add(host);
				return false;
		}
	}
}
