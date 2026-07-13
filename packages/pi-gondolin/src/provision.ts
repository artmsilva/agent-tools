/**
 * Boot-time provisioning of the guest.
 *
 * Order matters:
 *   1. Trust the Gondolin MITM CA  -> HTTPS egress (apk/git/npm) can validate.
 *   2. apk add the toolchain        -> idempotent; skipped if a baked image
 *                                      already has the tools.
 *   3. git hardening                -> gc.auto=0 + safe.directory so the shared
 *                                      host repo is never pruned or rejected.
 *   4. Dotfiles skel -> /root       -> the curated zsh/starship experience.
 *   5. (browser profile) chromium + agent-browser.
 *
 * All network steps require the relevant hosts to be on the allowlist
 * (dl-cdn.alpinelinux.org, registry.npmjs.org) — they are, by default.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VM } from "@earendil-works/gondolin";

interface PackageConfig {
	base: string[];
	browser: string[];
}

function loadPackages(): PackageConfig {
	const file = fileURLToPath(new URL("../config/packages.json", import.meta.url));
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PackageConfig>;
	return { base: parsed.base ?? [], browser: parsed.browser ?? [] };
}

export interface ProvisionOptions {
	browser: boolean;
	log?: (message: string) => void;
}

export interface ProvisionResult {
	toolsInstalled: boolean;
	browserInstalled: boolean;
	/** Absolute path to the guest login shell (bash if present, else /bin/sh). */
	shellPath: string;
	notes: string[];
}

/** Env vars that must be set at VM-create time (VM.create `env`). */
export function guestEnv(options: { browser: boolean }): Record<string, string> {
	const env: Record<string, string> = {
		HOME: "/root",
		USER: "root",
		LOGNAME: "root",
		SHELL: "/bin/zsh",
		TERM: "xterm-256color",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PAGER: "less",
		// Trust the MITM CA from Node/tools too (system bundle is patched at boot).
		// Trust the MITM CA everywhere without a slow update-ca-certificates rehash.
		// /etc/ssl/cert.pem is a symlink to this bundle; we append the CA to it at boot.
		NODE_EXTRA_CA_CERTS: "/etc/gondolin/mitm/ca.crt",
		GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
		CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
		REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
		// Quality-of-life for a sandboxed agent shell.
		GONDOLIN_SANDBOX: "1",
	};
	if (options.browser) {
		// agent-browser drives Chrome/Chromium over CDP; point it at the apk build
		// and never let anything try to download a glibc chromium onto musl.
		env.CHROME_BIN = "/usr/bin/chromium-browser";
		env.CHROME_PATH = "/usr/bin/chromium-browser";
		env.PUPPETEER_EXECUTABLE_PATH = "/usr/bin/chromium-browser";
		env.PUPPETEER_SKIP_DOWNLOAD = "1";
		env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
	}
	return env;
}

function buildScript(pkgs: PackageConfig, browser: boolean, starshipB64: string | undefined): string {
	// A representative probe: if these are all present we assume a baked image and
	// skip the base apk pass.
	const probe = ["git", "rg", "zsh", "starship", "bat", "eza"];
	const probeExpr = probe.map((c) => `command -v ${c} >/dev/null 2>&1`).join(" && ");
	const baseList = pkgs.base.join(" ");
	const browserList = pkgs.browser.join(" ");

	return `set -u
log(){ printf '[gondolin-provision] %s\\n' "$1" >&2; }

# 1. Trust the Gondolin MITM CA. /etc/ssl/cert.pem is a symlink to this bundle,
#    so appending the CA trusts it for curl/git/openssl WITHOUT the ~340ms
#    update-ca-certificates rehash. Fresh rootfs each boot => no accumulation.
if [ -f /etc/gondolin/mitm/ca.crt ]; then
  cat /etc/gondolin/mitm/ca.crt >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true
fi

# 2. Base toolchain (idempotent; skipped when already baked in).
if ${probeExpr}; then
  log "base tools already present; skipping apk"
else
  log "installing base tools via apk"
  apk add --no-cache ${baseList} >&2 || log "apk base install had errors"
fi
${
	browser
		? `
# 2b. Browser profile.
if command -v chromium-browser >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1; then
  log "chromium already present"
else
  log "installing chromium + browser deps via apk"
  apk add --no-cache ${browserList} >&2 || log "apk browser install had errors"
fi
# Some images ship chromium as /usr/bin/chromium; expose the expected name.
if [ ! -e /usr/bin/chromium-browser ] && [ -e /usr/bin/chromium ]; then
  ln -sf /usr/bin/chromium /usr/bin/chromium-browser 2>/dev/null || true
fi
if command -v npm >/dev/null 2>&1; then
  log "installing agent-browser (npm -g)"
  npm i -g agent-browser >&2 2>&1 || log "agent-browser install had errors (retry manually)"
  command -v agent-browser >/dev/null 2>&1 && (agent-browser install >&2 2>&1 || true)
fi
`
		: ""
}

# 3. git: never auto-gc/prune the shared host repo; accept foreign-owned mounts.
git config --global gc.auto 0 2>/dev/null || true
git config --global gc.autoDetach false 2>/dev/null || true
git config --global fetch.writeCommitGraph false 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

# 4. Dotfiles skel -> /root, plus writable dirs.
mkdir -p /root/.config /root/.local/bin /root/.local/share/Trash/files /root/.cache 2>/dev/null || true
if [ -d /gondolin/skel ]; then
  cp -a /gondolin/skel/. /root/ 2>/dev/null || true
fi
${
	starshipB64
		? `# Your live starship.toml, folded into this single exec (no extra VFS round-trip).
printf %s '${starshipB64}' | base64 -d > /root/.config/starship.toml 2>/dev/null || true`
		: ""
}
# Make zsh the default shell for interactive attach/ssh sessions.
if command -v zsh >/dev/null 2>&1; then
  command -v chsh >/dev/null 2>&1 && chsh -s /bin/zsh root 2>/dev/null || true
  sed -i 's#^root:\\(.*\\):/bin/[a-z]*#root:\\1:/bin/zsh#' /etc/passwd 2>/dev/null || true
fi

log "provision complete"

# Report the login shell on stdout so the caller can skip a separate probe exec.
printf 'GONDOLIN_SHELL=%s\\n' "$(command -v bash || echo /bin/sh)"
`;
}

export async function provisionGuest(vm: VM, options: ProvisionOptions): Promise<ProvisionResult> {
	const log = options.log ?? (() => {});
	const pkgs = loadPackages();
	const notes: string[] = [];

	// Read the user's live starship.toml (safe: no secrets) and fold it into the
	// single provision exec as base64, avoiding a separate VFS round-trip.
	let starshipB64: string | undefined;
	try {
		starshipB64 = Buffer.from(readFileSync(path.join(homedir(), ".config/starship.toml"), "utf8")).toString(
			"base64",
		);
		notes.push("starship.toml synced");
	} catch {
		// no live starship config; the skel fallback (if any) stands.
	}

	const script = buildScript(pkgs, options.browser, starshipB64);
	const result = await vm.exec(script);
	if (result.exitCode !== 0) {
		log(`provision script exited ${result.exitCode}`);
		notes.push(`provision exit ${result.exitCode}`);
	}

	const shellPath = /GONDOLIN_SHELL=(\S+)/.exec(result.stdout)?.[1] ?? "/bin/sh";

	return {
		toolsInstalled: true,
		browserInstalled: options.browser,
		shellPath,
		notes,
	};
}
