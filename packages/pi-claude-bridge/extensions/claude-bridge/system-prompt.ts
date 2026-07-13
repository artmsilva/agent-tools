// System-prompt sections listing bridged commands and collisions.
// Forked from @entelligentsia/pi-claude-compat (MIT), trimmed: skills are
// registered natively via resources_discover, so pi already documents them.

import type { BridgeCommand } from "./types.ts";

export function buildSystemPromptSections(
  commands: readonly BridgeCommand[],
  collisions: ReadonlyMap<string, string>,
): string {
  if (commands.length === 0 && collisions.size === 0) return "";

  const sections: string[] = [];

  if (commands.length > 0) {
    const commandList = commands
      .map((cmd) => `- \`/${cmd.name}\` (${cmd.source}): ${cmd.description}`)
      .join("\n");

    sections.push(
      "## Claude Custom Commands\n" +
        "The following Claude Code custom commands are loaded via pi-claude-bridge:\n\n" +
        `${commandList}\n\n` +
        "Use `/commandname` to invoke a command. Pass arguments after the command name; " +
        "the `$ARGUMENTS` placeholder in command files is replaced with the provided arguments.",
    );
  }

  if (collisions.size > 0) {
    const collisionList = [...collisions.entries()]
      .map(([name, owner]) => `- \`/${name}\`: already registered by ${owner}`)
      .join("\n");

    sections.push(
      "## Claude Command Collisions\n" +
        "These Claude command names conflict with existing pi commands and were not registered:\n\n" +
        collisionList,
    );
  }

  return sections.join("\n\n");
}
