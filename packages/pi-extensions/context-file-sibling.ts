// Load the context file pi skipped.
//
// Pi loads `AGENTS.md` OR `CLAUDE.md` per directory, and AGENTS.md wins
// (README "Context Files"). A repo whose AGENTS.md is a one-line pointer at a
// long CLAUDE.md therefore hands the agent the pointer and drops everything it
// points at — silently, with no warning that instructions went missing.
//
// This appends the skipped sibling to the system prompt. When the sibling is
// too big to inject without eating the context window, it appends a notice
// naming the path instead, so the omission is visible rather than silent.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "<!-- pi-context-file-sibling -->";

/** Injected per sibling. Above this, name the file instead of pasting it. */
const DEFAULT_MAX_BYTES = 32 * 1024;
/** Injected across all siblings, so many repo levels cannot stack up. */
const DEFAULT_TOTAL_BYTES = 64 * 1024;

/** `AGENTS.override.md` is a deliberate replacement — pi is *meant* to ignore
 *  the other files in that directory, so this extension stays out of it. */
const OVERRIDE = "AGENTS.override.md";
const PAIR: Record<string, string> = {
  "AGENTS.md": "CLAUDE.md",
  "CLAUDE.md": "AGENTS.md",
};

export interface SiblingContextOptions {
  maxBytes?: number;
  totalBytes?: number;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Build the text to append for every loaded context file whose sibling pi
 * skipped. Returns an empty string when there is nothing to add.
 *
 * A sibling is skipped-and-worth-adding when it exists, is not itself already
 * loaded, and does not resolve to the same file as something loaded — that last
 * check is what keeps an `AGENTS.md -> CLAUDE.md` symlink from double-injecting.
 */
export function siblingContextBlock(
  loadedPaths: readonly string[],
  options: SiblingContextOptions = {},
): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = options.totalBytes ?? DEFAULT_TOTAL_BYTES;

  const loadedReal = new Set(loadedPaths.map(realOrSelf));
  const seen = new Set<string>();
  const sections: string[] = [];
  let spent = 0;

  for (const loaded of loadedPaths) {
    const sibling = PAIR[basename(loaded)];
    if (!sibling) continue;

    const dir = dirname(loaded);
    if (existsSync(join(dir, OVERRIDE))) continue;

    const path = join(dir, sibling);
    if (!existsSync(path)) continue;

    const real = realOrSelf(path);
    if (loadedReal.has(real) || seen.has(real)) continue;
    seen.add(real);

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }

    if (size > maxBytes || spent + size > totalBytes) {
      sections.push(
        `### ${path} — NOT LOADED (${formatSize(size)})\n\n` +
          `Pi loads \`AGENTS.md\` or \`CLAUDE.md\` per directory, not both, and this ` +
          `file is too large to inject automatically. Read it with the read tool ` +
          `before following this project's conventions.`,
      );
      continue;
    }

    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;

    spent += size;
    sections.push(`### ${path}\n\n${content.trim()}`);
  }

  if (sections.length === 0) return "";
  return (
    `\n\n${MARKER}\n## Additional project instructions\n\n` +
    `Pi loads only one of \`AGENTS.md\` / \`CLAUDE.md\` per directory. These ` +
    `sibling files were skipped by that rule and carry instructions that apply ` +
    `to this work. Treat them with the same authority as the context files above.\n\n` +
    `${sections.join("\n\n")}\n`
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (typeof event.systemPrompt !== "string") return;
    if (event.systemPrompt.includes(MARKER)) return;

    const files = event.systemPromptOptions?.contextFiles ?? [];
    const paths = files
      .map((file: unknown) =>
        typeof file === "string" ? file : (file as { path?: unknown })?.path,
      )
      .filter((path: unknown): path is string => typeof path === "string" && path.length > 0);
    if (paths.length === 0) return;

    const block = siblingContextBlock(paths, {
      ...(process.env.PI_SIBLING_CONTEXT_MAX_BYTES
        ? { maxBytes: Number(process.env.PI_SIBLING_CONTEXT_MAX_BYTES) }
        : {}),
    });
    if (!block) return;

    return { systemPrompt: event.systemPrompt + block };
  });
}
