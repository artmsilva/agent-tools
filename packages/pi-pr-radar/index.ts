import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface PRStatus {
  number: number;
  title: string;
  url: string;
  state: "failing" | "pending" | "green" | "unknown";
}

interface PRCounts {
  failing: number;
  pending: number;
  green: number;
}

interface StatusCheckRollup {
  state: string;
  contexts?: Array<{ state: string; isRequired?: boolean }>;
}

/**
 * Classify a PR based on its statusCheckRollup.
 */
export function classifyPr(
  rollup: StatusCheckRollup | undefined
): "failing" | "pending" | "green" | "unknown" {
  if (!rollup) return "unknown";

  // Check contexts first (more specific than top-level state)
  const contexts = rollup.contexts ?? [];
  const hasFailure = contexts.some((c) => c.state === "FAILURE" || c.state === "ERROR");
  if (hasFailure) return "failing";

  const hasPending = contexts.some((c) => c.state === "PENDING" || c.state === "EXPECTED");
  if (hasPending) return "pending";

  const allSuccess = contexts.length > 0 && contexts.every((c) => c.state === "SUCCESS");
  if (allSuccess) return "green";

  // Fall back to top-level state
  const state = rollup.state.toUpperCase();
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (state === "SUCCESS") return "green";

  return "unknown";
}

/**
 * Select the "worst" PR: failing first, then pending, then newest green.
 */
export function worstPr(prs: PRStatus[]): PRStatus | undefined {
  const failing = prs.filter((pr) => pr.state === "failing");
  if (failing.length > 0) return failing[0];

  const pending = prs.filter((pr) => pr.state === "pending");
  if (pending.length > 0) return pending[0];

  const green = prs.filter((pr) => pr.state === "green");
  if (green.length > 0) return green[0];

  return prs[0];
}

/**
 * Render a compact footer segment.
 */
export function renderSegment(counts: PRCounts): string {
  const parts: string[] = [];
  if (counts.failing > 0) parts.push(`✗${counts.failing}`);
  if (counts.pending > 0) parts.push(`●${counts.pending}`);
  if (counts.green > 0) parts.push(`✓${counts.green}`);
  return `PR ${parts.join(" ")}`;
}

export default function (pi: ExtensionAPI) {
  let cachedPrs: PRStatus[] = [];
  let pollTimer: NodeJS.Timeout | undefined;
  let currentCtx: ExtensionContext | undefined;

  const intervalMs =
    parseInt(process.env.PR_RADAR_INTERVAL_MS || "", 10) || 120_000;

  async function fetchPrs(): Promise<PRStatus[]> {
    try {
      const repos = (process.env.PR_RADAR_REPOS || "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);

      const queries: Promise<PRStatus[]>[] = [];

      if (repos.length === 0) {
        // Default: current repo
        queries.push(queryRepo(undefined));
      } else {
        // Query each repo
        for (const repo of repos) {
          queries.push(queryRepo(repo));
        }
      }

      const results = await Promise.all(queries);
      return results.flat();
    } catch {
      return [];
    }
  }

  async function queryRepo(repo: string | undefined): Promise<PRStatus[]> {
    const args = [
      "pr",
      "list",
      "--author",
      "@me",
      "--state",
      "open",
      "--json",
      "number,title,url,statusCheckRollup",
    ];
    if (repo) {
      args.push("--repo", repo);
    }

    const result = await pi.exec("gh", args, { timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error("gh failed");

    const prs = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      url: string;
      statusCheckRollup?: StatusCheckRollup;
    }>;

    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: classifyPr(pr.statusCheckRollup),
    }));
  }

  function updateFooter(prs: PRStatus[]) {
    if (!currentCtx) return;

    if (prs.length === 0) {
      currentCtx.ui.setStatus("pr-radar", undefined);
      return;
    }

    const counts: PRCounts = {
      failing: prs.filter((p) => p.state === "failing").length,
      pending: prs.filter((p) => p.state === "pending").length,
      green: prs.filter((p) => p.state === "green").length,
    };

    const segment = renderSegment(counts);
    currentCtx.ui.setStatus("pr-radar", segment);
  }

  async function poll() {
    const prs = await fetchPrs();
    cachedPrs = prs;
    updateFooter(prs);
  }

  // Start polling on session start
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    await poll();
    pollTimer = setInterval(poll, intervalMs);
    if (pollTimer.unref) pollTimer.unref();
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    currentCtx = undefined;
  });

  // Register alt+p shortcut
  pi.registerShortcut("alt+p", {
    description: "Open worst PR in browser",
    handler: async (_ctx) => {
      const worst = worstPr(cachedPrs);
      if (!worst) return;
      await pi.exec("open", [worst.url]);
    },
  });

  // Register /prs command
  pi.registerCommand("prs", {
    description: "List open PRs with status",
    handler: async (_args, ctx) => {
      if (cachedPrs.length === 0) {
        ctx.ui.notify("No open PRs", "info");
        return;
      }

      const lines = cachedPrs.map((pr) => {
        const glyph =
          pr.state === "failing" ? "✗" :
          pr.state === "pending" ? "●" :
          pr.state === "green" ? "✓" :
          "?";
        return `${glyph} #${pr.number} ${pr.title}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
