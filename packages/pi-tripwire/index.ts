/**
 * pi-tripwire — tool_result hook that redacts secrets from outbound tool
 * results before they enter model context.
 */

import type { ExtensionAPI, TextContent } from "@earendil-works/pi-coding-agent";

/** Pattern configuration for secret detection. */
interface RedactionPattern {
   readonly name: string;
   readonly regex: RegExp;
   readonly replacement: string;
   readonly preservePrefix?: (match: string) => string | undefined;
}

const PATTERNS: readonly RedactionPattern[] = [
   {
      name: "github-token",
      regex: /\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g,
      replacement: "[TRIPWIRE:github-token]",
   },
   {
      name: "slack-token",
      regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
      replacement: "[TRIPWIRE:slack-token]",
   },
   {
      name: "aws-access-key",
      regex: /\bAKIA[0-9A-Z]{16}\b/g,
      replacement: "[TRIPWIRE:aws-access-key]",
   },
   {
      name: "aws-secret-key",
      regex: /aws_secret_access_key\s*[:=]\s*\S+/gi,
      replacement: "aws_secret_access_key [TRIPWIRE:aws-secret-key]",
   },
   {
      name: "anthropic-key",
      regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
      replacement: "[TRIPWIRE:anthropic-key]",
   },
   {
      name: "openai-key",
      regex: /\bsk-[A-Za-z0-9_-]{20,}/g,
      replacement: "[TRIPWIRE:openai-key]",
   },
   {
      name: "jwt",
      regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      replacement: "[TRIPWIRE:jwt]",
   },
   {
      name: "pem-private-key",
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
      replacement: "-----BEGIN PRIVATE KEY-----\n[TRIPWIRE:pem-private-key]\n-----END PRIVATE KEY-----",
   },
   {
      name: "bearer-token",
      regex: /(Authorization:\s*Bearer\s+)\S+/gi,
      replacement: "[TRIPWIRE:bearer-token]",
      preservePrefix: (match) => {
         const m = /(Authorization:\s*Bearer\s+)/i.exec(match);
         return m?.[1];
      },
   },
   {
      name: "npm-token",
      regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
      replacement: "[TRIPWIRE:npm-token]",
   },
];

/** Safe reference pattern — do NOT redact these. */
const OP_REFERENCE = /\bop:\/\/[^\s]+/g;

export interface RedactResult {
   text: string;
   hits: Record<string, number>;
}

/**
 * Pure redaction function. Scans text for secrets and replaces them with
 * [TRIPWIRE:<type>] markers. Does not redact op:// references.
 */
export function redact(text: string): RedactResult {
   const hits: Record<string, number> = {};

   // Extract op:// references and preserve them.
   const opRefs: string[] = [];
   const textWithPlaceholders = text.replace(OP_REFERENCE, (match) => {
      const placeholder = `__OP_REF_${opRefs.length}__`;
      opRefs.push(match);
      return placeholder;
   });

   let redacted = textWithPlaceholders;

   for (const pattern of PATTERNS) {
      redacted = redacted.replace(pattern.regex, (match) => {
         hits[pattern.name] = (hits[pattern.name] ?? 0) + 1;
         if (pattern.preservePrefix) {
            const prefix = pattern.preservePrefix(match);
            return prefix ? prefix + pattern.replacement : pattern.replacement;
         }
         return pattern.replacement;
      });
   }

   // Restore op:// references.
   for (let i = 0; i < opRefs.length; i++) {
      redacted = redacted.replace(`__OP_REF_${i}__`, opRefs[i]);
   }

   return { text: redacted, hits };
}

export default function activate(pi: ExtensionAPI) {
   const sessionStats: Record<string, number> = {};

   pi.on("tool_result", (event) => {
      let anyRedacted = false;
      const newContent: (TextContent | { type: "image"; source: { type: string; data: string } })[] = [];

      for (const block of event.content) {
         if (block.type !== "text") {
            newContent.push(block);
            continue;
         }

         const result = redact(block.text);
         if (Object.keys(result.hits).length > 0) {
            anyRedacted = true;
            for (const [name, count] of Object.entries(result.hits)) {
               sessionStats[name] = (sessionStats[name] ?? 0) + count;
            }
         }

         newContent.push({ type: "text", text: result.text });
      }

      if (anyRedacted) {
         return { content: newContent };
      }
   });

   pi.registerCommand("tripwire", {
      description: "Show redaction statistics for this session",
      handler: async (_args, ctx) => {
         if (Object.keys(sessionStats).length === 0) {
            ctx.ui.notify("No secrets redacted this session", "info");
            return;
         }

         const lines = ["🚨 Tripwire redaction stats:", ""];
         for (const [name, count] of Object.entries(sessionStats)) {
            lines.push(`  ${name}: ${count}`);
         }
         lines.push("");
         lines.push(`Total: ${Object.values(sessionStats).reduce((a, b) => a + b, 0)} secrets redacted`);

         ctx.ui.notify(lines.join("\n"), "info");
      },
   });
}
