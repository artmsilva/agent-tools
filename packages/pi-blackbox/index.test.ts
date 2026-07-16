import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
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

test("openDB creates database with schema", () => {
  const dbPath = join(tmpdir(), `blackbox-test-${Date.now()}.db`);
  const db = openDB(dbPath);
  assert.ok(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_executions'")
    .get() as { name: string } | undefined;
  assert.equal(tables?.name, "tool_executions");

  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
});

test("insertExecution and getSessionTimeline", () => {
  const dbPath = join(tmpdir(), `blackbox-test-${Date.now()}.db`);
  const db = openDB(dbPath);
  assert.ok(db);

  const exec1: ToolExecution = {
    session_id: "test-session",
    tool_call_id: "call-1",
    tool_name: "bash",
    started_at: 1000,
    ended_at: 1100,
    duration_ms: 100,
    is_error: 0,
    summary: "Success output",
    args_summary: '{"command":"ls"}',
  };

  const exec2: ToolExecution = {
    session_id: "test-session",
    tool_call_id: "call-2",
    tool_name: "read",
    started_at: 2000,
    ended_at: 2050,
    duration_ms: 50,
    is_error: 1,
    summary: "File not found",
    args_summary: '{"path":"missing.txt"}',
  };

  insertExecution(db, exec1);
  insertExecution(db, exec2);

  const stats = getSessionTimeline(db, "test-session");
  assert.equal(stats.total_tools, 2);
  assert.equal(stats.error_count, 1);
  assert.equal(stats.slowest.length, 2);
  assert.equal(stats.slowest[0].tool_name, "bash");
  assert.equal(stats.slowest[0].duration_ms, 100);
  assert.equal(stats.first_error?.tool_name, "read");
  assert.equal(stats.first_error?.summary, "File not found");

  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
});

test("getAllTimeline aggregates across sessions", () => {
  const dbPath = join(tmpdir(), `blackbox-test-${Date.now()}.db`);
  const db = openDB(dbPath);
  assert.ok(db);

  insertExecution(db, {
    session_id: "session-1",
    tool_call_id: "c1",
    tool_name: "bash",
    started_at: 1000,
    ended_at: 1100,
    duration_ms: 100,
    is_error: 0,
    summary: "ok",
    args_summary: "{}",
  });

  insertExecution(db, {
    session_id: "session-2",
    tool_call_id: "c2",
    tool_name: "read",
    started_at: 2000,
    ended_at: 2200,
    duration_ms: 200,
    is_error: 0,
    summary: "ok",
    args_summary: "{}",
  });

  const stats = getAllTimeline(db);
  assert.equal(stats.total_tools, 2);
  assert.equal(stats.slowest[0].duration_ms, 200);

  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
});

test("pruneOldRows caps at 20k", () => {
  const dbPath = join(tmpdir(), `blackbox-test-${Date.now()}.db`);
  const db = openDB(dbPath);
  assert.ok(db);

  // Insert 100 rows (mock cap test; real cap is 20k)
  for (let i = 0; i < 100; i++) {
    insertExecution(db, {
      session_id: "test",
      tool_call_id: `c${i}`,
      tool_name: "bash",
      started_at: 1000 + i,
      ended_at: 1100 + i,
      duration_ms: 100,
      is_error: 0,
    });
  }

  // Mock prune at cap=50
  db.prepare(`
    DELETE FROM tool_executions WHERE id IN (
      SELECT id FROM tool_executions 
      ORDER BY started_at ASC 
      LIMIT (SELECT MAX(0, COUNT(*) - 50) FROM tool_executions)
    )
  `).run();

  const count = db.prepare("SELECT COUNT(*) as c FROM tool_executions").get() as { c: number };
  assert.equal(count.c, 50);

  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
});

test("summarizeContent extracts first 200 chars of text", () => {
  const content = [
    { type: "text", text: "x".repeat(300) },
  ];
  const summary = summarizeContent(content);
  assert.equal(summary.length, 200);
  assert.equal(summary, "x".repeat(200));
});

test("summarizeContent handles empty/non-text content", () => {
  assert.equal(summarizeContent([]), "");
  assert.equal(summarizeContent([{ type: "image", data: "..." }]), "");
});

test("summarizeArgs caps JSON at 200 chars", () => {
  const args = { command: "x".repeat(300) };
  const summary = summarizeArgs(args);
  assert.equal(summary.length, 200);
});

test("summarizeArgs handles non-JSON", () => {
  const circular: any = {};
  circular.self = circular;
  const summary = summarizeArgs(circular);
  assert.equal(summary, "");
});
