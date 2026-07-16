import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TextContent } from "@earendil-works/pi-coding-agent";

export interface ToolExecution {
  id?: number;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  started_at: number;
  ended_at?: number;
  duration_ms?: number;
  is_error: number;
  summary?: string;
  args_summary?: string;
}

export interface TimelineStats {
  total_tools: number;
  error_count: number;
  slowest: Array<{ tool_name: string; duration_ms: number; started_at: number }>;
  first_error?: { tool_name: string; started_at: number; summary: string };
  wall_span_ms?: number;
}

const MAX_ROWS = 20_000;

export function openDB(path: string): DatabaseSync | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL,
        summary TEXT,
        args_summary TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_session_id ON tool_executions(session_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_started_at ON tool_executions(started_at)");
    return db;
  } catch {
    return undefined;
  }
}

export function insertExecution(db: DatabaseSync, exec: ToolExecution): void {
  try {
    db.prepare(`
      INSERT INTO tool_executions (
        session_id, tool_call_id, tool_name, started_at, ended_at, 
        duration_ms, is_error, summary, args_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exec.session_id,
      exec.tool_call_id,
      exec.tool_name,
      exec.started_at,
      exec.ended_at ?? null,
      exec.duration_ms ?? null,
      exec.is_error,
      exec.summary ?? null,
      exec.args_summary ?? null
    );
  } catch {
    // Fail soft
  }
}

export function pruneOldRows(db: DatabaseSync): void {
  try {
    db.prepare(`
      DELETE FROM tool_executions WHERE id IN (
        SELECT id FROM tool_executions 
        ORDER BY started_at ASC 
        LIMIT (SELECT MAX(0, COUNT(*) - ?) FROM tool_executions)
      )
    `).run(MAX_ROWS);
  } catch {
    // Fail soft
  }
}

export function summarizeContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  const textBlock = content.find((b): b is TextContent => 
    typeof b === "object" && b !== null && "type" in b && b.type === "text"
  );
  if (!textBlock?.text) return "";
  return textBlock.text.slice(0, 200);
}

export function summarizeArgs(args: unknown): string {
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return "";
  }
}

export function getSessionTimeline(db: DatabaseSync, sessionId: string): TimelineStats {
  const rows = db.prepare(`
    SELECT tool_name, started_at, ended_at, duration_ms, is_error, summary
    FROM tool_executions 
    WHERE session_id = ? 
    ORDER BY started_at ASC
  `).all(sessionId) as Array<{
    tool_name: string;
    started_at: number;
    ended_at: number | null;
    duration_ms: number | null;
    is_error: number;
    summary: string | null;
  }>;

  return buildStats(rows);
}

export function getAllTimeline(db: DatabaseSync): TimelineStats {
  const rows = db.prepare(`
    SELECT tool_name, started_at, ended_at, duration_ms, is_error, summary
    FROM tool_executions 
    ORDER BY started_at ASC
  `).all() as Array<{
    tool_name: string;
    started_at: number;
    ended_at: number | null;
    duration_ms: number | null;
    is_error: number;
    summary: string | null;
  }>;

  return buildStats(rows);
}

function buildStats(
  rows: Array<{
    tool_name: string;
    started_at: number;
    ended_at: number | null;
    duration_ms: number | null;
    is_error: number;
    summary: string | null;
  }>
): TimelineStats {
  const total_tools = rows.length;
  const error_count = rows.filter((r) => r.is_error).length;

  const withDuration = rows.filter((r): r is typeof r & { duration_ms: number } => 
    r.duration_ms !== null
  );
  const slowest = withDuration
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 5)
    .map((r) => ({
      tool_name: r.tool_name,
      duration_ms: r.duration_ms,
      started_at: r.started_at,
    }));

  const firstErrorRow = rows.find((r) => r.is_error);
  const first_error = firstErrorRow
    ? {
        tool_name: firstErrorRow.tool_name,
        started_at: firstErrorRow.started_at,
        summary: firstErrorRow.summary || "(no summary)",
      }
    : undefined;

  const wall_span_ms =
    rows.length > 0
      ? rows[rows.length - 1].started_at - rows[0].started_at
      : undefined;

  return { total_tools, error_count, slowest, first_error, wall_span_ms };
}
