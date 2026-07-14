export interface BridgeCommand {
  /** Command name as invoked in pi, e.g. "pr", "xyz:test1", "coderabbit:code-review". */
  name: string;
  /** Absolute path to the command .md file. */
  absolutePath: string;
  /** Description extracted from frontmatter or content. */
  description: string;
  /** Human-readable provenance, e.g. "project", "user", "plugin:coderabbit". */
  source: string;
}

export interface BridgeSkill {
  /** Skill name (directory name). */
  name: string;
  /** Absolute path to the SKILL.md file. */
  skillMdPath: string;
  /** Absolute path to the skill directory. */
  dirPath: string;
  /** Description extracted from SKILL.md frontmatter. */
  description: string;
  /** Provenance label. */
  source: string;
}

export interface BridgeAgent {
  /** Agent name (file basename without .md). */
  name: string;
  /** Absolute path to the agent .md file. */
  absolutePath: string;
  /** Provenance label. */
  source: string;
}

export interface EnabledPlugin {
  name: string;
  marketplace: string;
}

export interface ResolvedPlugin extends EnabledPlugin {
  /** Absolute path to the plugin root directory. */
  root: string;
}

export interface PersistedState {
  loaded?: boolean;
}

export interface ProjectConfig {
  loaded?: boolean;
  /** Skill directory names to ignore during discovery. */
  ignoredSkills?: string[];
}
