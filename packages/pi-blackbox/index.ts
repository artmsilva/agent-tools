import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openDB,
  insertExecution,
  pruneOldRows,
  summarizeContent,
  summarizeArgs,
  getSessionTimeline,
  getAllTimeline,
  type ToolExecution,
} from "./db.ts";

interface PendingExecution {
  tool_name: string;
  started_at: number;
  args: unknown;
}

let db: DatabaseSync | undefined;
let disabled = false;
const pending = new Map<string, PendingExecution>();

export default function (pi: ExtensionAPI) {
  const dbPath = join(homedir(), ".pi", "agent", "blackbox.db");
  db = openDB(dbPath);

  if (!db) {
    disabled = true;
    console.warn("pi-blackbox: DB init failed, recorder disabled");
    return;
  }

  pi.on("tool_execution_start", (event) => {
    if (disabled || !db) return;
    pending.set(event.toolCallId, {
      tool_name: event.toolName,
      started_at: Date.now(),
      args: event.args,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (disabled || !db) return;

    const p = pending.get(event.toolCallId);
    if (!p) return;

    pending.delete(event.toolCallId);

    const ended_at = Date.now();
    const duration_ms = ended_at - p.started_at;

    const exec: ToolExecution = {
      session_id: ctx.sessionManager.getSessionId(),
      tool_call_id: event.toolCallId,
      tool_name: p.tool_name,
      started_at: p.started_at,
      ended_at,
      duration_ms,
      is_error: event.isError ? 1 : 0,
      summary: summarizeContent(event.result.content ?? []),
      args_summary: summarizeArgs(p.args),
    };

    insertExecution(db, exec);
    pruneOldRows(db);
  });

  pi.registerCommand("blackbox", {
    description: "Show session tool timeline (use 'all' for all sessions)",
    handler: async (args, ctx) => {
      if (disabled || !db) {
        ctx.ui.notify("Blackbox recorder is disabled", "warning");
        return;
      }

      const isAll = args.trim() === "all";
      const stats = isAll
        ? getAllTimeline(db)
        : getSessionTimeline(db, ctx.sessionManager.getSessionId());

      const lines: string[] = [];
      lines.push(isAll ? "=== All Sessions ===" : "=== Current Session ===");
      lines.push(`Total tools run: ${stats.total_tools}`);
      lines.push(`Errors: ${stats.error_count}`);

      if (stats.slowest.length > 0) {
        lines.push("");
        lines.push("Top 5 slowest:");
        for (const s of stats.slowest) {
          const when = new Date(s.started_at).toISOString().slice(11, 19);
          lines.push(`  ${s.tool_name} - ${s.duration_ms}ms (${when})`);
        }
      }

      if (stats.first_error) {
        const when = new Date(stats.first_error.started_at).toISOString().slice(11, 19);
        lines.push("");
        lines.push(`First error: ${stats.first_error.tool_name} at ${when}`);
        lines.push(`  ${stats.first_error.summary}`);
      }

      if (stats.wall_span_ms !== undefined) {
        lines.push("");
        lines.push(`Wall-clock span: ${(stats.wall_span_ms / 1000).toFixed(1)}s`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
