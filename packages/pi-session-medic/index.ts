/**
 * pi-session-medic — recover from poisoned sessions caused by Anthropic API
 * contract violations that brick the conversation loop.
 *
 * PROBLEM: Anthropic rejects tool_result blocks with is_error:true containing
 * non-text content. When such a result is persisted, every subsequent request
 * replays it and gets a 400 → session permanently bricked.
 *
 * SOLUTION: Detect the poison pattern, locate the offending message(s), strip
 * the invalid blocks, and let the user continue. Complements the preventive
 * sanitize-error-results.ts hook.
 */

import type { ExtensionAPI, TextContent } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";

/** Detection patterns for known Anthropic API violations. */
const POISON_PATTERNS = [
   /all content must be type ['"]text['"] if ['"]is_error['"] is true/i,
   /image exceeds \d+ MB maximum/i,
   /unexpected [`']tool_use_id[`'] found/i,
] as const;

/** Parse message index from Anthropic error text (e.g. "messages.164.content.0.tool_result" → 164). */
export function parseMessageIndex(errorText: string): number | undefined {
   const match = /messages\.(\d+)\./.exec(errorText);
   return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Check if error text matches known poison patterns. */
export function isPoisonError(errorText: string): boolean {
   return POISON_PATTERNS.some((pattern) => pattern.test(errorText));
}

/**
 * Strip non-text content from tool_result entries in a message array.
 * Returns a new array with poisoned blocks replaced by text tombstones.
 */
export function sanitizeMessages(messages: unknown[]): unknown[] {
   return messages.map((msg, idx) => {
      if (typeof msg !== "object" || !msg || !("role" in msg)) return msg;
      if (msg.role !== "assistant") return msg;
      if (!("content" in msg) || !Array.isArray(msg.content)) return msg;

      let modified = false;
      const cleaned = msg.content.map((block: unknown) => {
         if (typeof block !== "object" || !block) return block;
         if (!("type" in block)) return block;
         if (block.type === "tool_result" && "is_error" in block && block.is_error === true) {
            // Strip non-text content from error tool_result blocks
            if (!("content" in block) || !Array.isArray(block.content)) return block;
            const nonTextCount = block.content.filter((c: unknown) => typeof c === "object" && c && "type" in c && c.type !== "text").length;
            if (nonTextCount === 0) return block;

            modified = true;
            const textOnly = block.content.filter((c: unknown) => typeof c === "object" && c && "type" in c && c.type === "text");
            return {
               ...block,
               content: [
                  ...textOnly,
                  {
                     type: "text",
                     text: `[${nonTextCount} non-text block(s) removed by pi-session-medic: Anthropic requires error tool results to be text-only]`,
                  },
               ],
            };
         }
         return block;
      });

      return modified ? { ...msg, content: cleaned } : msg;
   });
}

/**
 * Strip oversized images (>5MB) from tool_result blocks.
 * Returns a new array with oversized images replaced by text tombstones.
 */
export function stripOversizedImages(messages: unknown[], maxBytes = 5 * 1024 * 1024): unknown[] {
   return messages.map((msg) => {
      if (typeof msg !== "object" || !msg || !("role" in msg)) return msg;
      if (msg.role !== "assistant") return msg;
      if (!("content" in msg) || !Array.isArray(msg.content)) return msg;

      let modified = false;
      const cleaned = msg.content.map((block: unknown) => {
         if (typeof block !== "object" || !block) return block;
         if (!("type" in block)) return block;
         if (block.type === "tool_result") {
            if (!("content" in block) || !Array.isArray(block.content)) return block;
            const sanitized = block.content.map((c: unknown) => {
               if (typeof c !== "object" || !c || !("type" in c)) return c;
               if (c.type === "image" && "data" in c && typeof c.data === "string") {
                  const sizeBytes = (c.data.length * 3) / 4; // rough base64 decode size
                  if (sizeBytes > maxBytes) {
                     modified = true;
                     return {
                        type: "text",
                        text: `[Image removed by pi-session-medic: exceeded ${(maxBytes / (1024 * 1024)).toFixed(1)}MB limit]`,
                     };
                  }
               }
               return c;
            });
            return modified ? { ...block, content: sanitized } : block;
         }
         return block;
      });

      return modified ? { ...msg, content: cleaned } : msg;
   });
}

export default function activate(pi: ExtensionAPI) {
   let lastError: { text: string; turn: number } | undefined;

   // Detect poison errors after agent turns fail
   pi.on("agent_end", (event, ctx) => {
      // Check if the last message is an error (heuristic: no tool calls, no text)
      const messages = ctx.sessionManager.getEntries().filter((e) => e.type === "message");
      if (messages.length === 0) return;

      const last = messages[messages.length - 1];
      // Look for error indicators in the message or details
      const errorText = JSON.stringify(last);
      if (isPoisonError(errorText)) {
         lastError = { text: errorText, turn: messages.length };
         ctx.ui.notify("⚠️  Poison error detected. Run /medic to repair the session.", "warning");
      }
   });

   pi.registerCommand("medic", {
      description: "Repair a poisoned session (Anthropic API contract violations)",
      handler: async (_args, ctx) => {
         const sessionFile = ctx.sessionManager.getSessionFile();
         if (!sessionFile) {
            ctx.ui.notify("Cannot repair: no session file (ephemeral mode)", "error");
            return;
         }

         // Read the session file
         let raw: string;
         try {
            raw = readFileSync(sessionFile, "utf8");
         } catch (err) {
            ctx.ui.notify(`Failed to read session file: ${err}`, "error");
            return;
         }

         const lines = raw.trim().split("\n");
         let repaired = 0;

         // Parse and sanitize each message entry
         const cleaned = lines.map((line) => {
            const entry = JSON.parse(line);
            if (entry.type !== "message") return line;

            const msg = entry.message;
            const before = JSON.stringify(msg);

            // Apply sanitization passes
            let sanitized = [msg];
            sanitized = sanitizeMessages(sanitized);
            sanitized = stripOversizedImages(sanitized);

            const after = JSON.stringify(sanitized[0]);
            if (before !== after) {
               repaired++;
               return JSON.stringify({ ...entry, message: sanitized[0] });
            }
            return line;
         });

         if (repaired === 0) {
            ctx.ui.notify("No poison blocks found. Session appears clean.", "info");
            return;
         }

         // Write back the repaired session
         try {
            writeFileSync(sessionFile, cleaned.join("\n") + "\n", "utf8");
            ctx.ui.notify(`✅ Repaired ${repaired} message(s). Reload the session to continue.`, "info");
            ctx.ui.notify("Run /reload to refresh the session in memory.", "info");
         } catch (err) {
            ctx.ui.notify(`Failed to write repaired session: ${err}`, "error");
         }
      },
   });
}
