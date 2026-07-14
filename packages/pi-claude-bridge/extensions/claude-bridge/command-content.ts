// Command file loading with $ARGUMENTS substitution.
// Forked from @entelligentsia/pi-claude-compat (MIT); adapted to absolute paths.

import { readFileSafe } from "./fs-utils.ts";

/** Safe string replacement that doesn't interpret $-patterns in the replacement. */
function safeReplace(str: string, search: RegExp, replacement: string): string {
  return str.replace(search, () => replacement);
}

/**
 * Read a command's content and process it for use as a prompt.
 *
 * - Replaces $ARGUMENTS / ${ARGUMENTS} / {{ARGUMENTS}} before frontmatter stripping
 * - Strips YAML frontmatter
 * - If no placeholder found and args provided, appends them as fallback
 */
export function loadCommandContent(absolutePath: string, args?: string): string | null {
  const content = readFileSafe(absolutePath);
  if (content === null) return null;

  const hasArgs = args !== undefined && args.trim() !== "";
  const trimmedArgs = hasArgs ? args.trim() : "";

  let processed = content;
  const hasPlaceholder = /\$ARGUMENTS|\$\{ARGUMENTS\}|\{\{ARGUMENTS\}\}/.test(content);

  if (hasArgs) {
    processed = safeReplace(processed, /\$\{ARGUMENTS\}|\$ARGUMENTS/g, trimmedArgs);
    processed = safeReplace(processed, /\{\{ARGUMENTS\}\}/g, trimmedArgs);
  } else {
    processed = processed
      .replace(/\s*\$\{ARGUMENTS\}\s*/g, " ")
      .replace(/\s*\$ARGUMENTS\s*/g, " ")
      .replace(/\s*\{\{ARGUMENTS\}\}\s*/g, " ")
      .replace(/  +/g, " ");
  }

  const body = processed.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

  if (hasArgs && !hasPlaceholder) {
    return `${body}\n\n${trimmedArgs}`;
  }

  return body;
}
