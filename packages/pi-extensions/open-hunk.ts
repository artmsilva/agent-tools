import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const SHORTCUT = "alt+h";
const STATUS_KEY = "open-hunk";

type FooterSlot = { setText(text: string): void };
let footerSlot: Promise<FooterSlot | undefined> | undefined;

function getFooterSlot(): Promise<FooterSlot | undefined> {
	return (footerSlot ??= import("@zigai/pi-footer/api")
		.then(({ registerFooterSlot }) =>
			registerFooterSlot({ id: "open-hunk.status", defaultSide: "left" }),
		)
		.catch(() => undefined));
}

async function worktreeRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 2_000,
	});
	const root = result.stdout.trim();
	return result.code === 0 && root ? root : cwd;
}

async function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<void> {
	if (ctx.mode !== "tui") return;
	const path = await worktreeRoot(pi, cwd);
	const text = `⌥H Review ${basename(path)} in hunk`;
	const hint = ctx.ui.theme.fg("accent", "⌥H");
	const label = ctx.ui.theme.fg("dim", `Review ${basename(path)} in hunk`);
	ctx.ui.setStatus(STATUS_KEY, `${hint} ${label}`);
	(await getFooterSlot())?.setText(text);
}

// hunk is a terminal UI (stdin/stdout takeover), unlike Zed's fire-and-forget
// CLI. pi.exec captures stdio as strings, so it can't host an interactive
// TUI in-process — open a new detached terminal window instead, same as
// `zed --new` opens a new GUI window without touching pi's own terminal.
async function openInHunk(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<void> {
	const path = await worktreeRoot(pi, cwd);
	// Ghostty's -e treats every following arg as its own argv element, not a shell
	// string — do not collapse "hunk", "diff", "--watch" back into one string, or
	// Ghostty will try to exec a binary literally named "hunk diff --watch".
	const result = await pi.exec(
		"open",
		["-na", "Ghostty.app", "--args", `--working-directory=${path}`, "-e", "hunk", "diff", "--watch"],
		{ cwd: path, timeout: 5_000 },
	);

	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		ctx.ui.notify(`Could not open hunk: ${reason}`, "error");
		return;
	}

	ctx.ui.notify(`Opened ${path} in hunk`, "info");
}

export default function openHunkExtension(pi: ExtensionAPI) {
	pi.registerCommand("hunk", {
		description: "Review the current worktree's diff in hunk (new terminal window)",
		handler: async (_args, ctx) => openInHunk(pi, ctx, ctx.cwd),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Review the current worktree's diff in hunk",
		handler: async (ctx) => openInHunk(pi, ctx, ctx.cwd),
	});

	pi.on("session_start", async (_event, ctx) => {
		await updateStatus(pi, ctx, ctx.cwd);
	});
}
