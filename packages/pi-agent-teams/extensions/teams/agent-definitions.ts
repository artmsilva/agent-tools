import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface TeammateAgentDefinition {
	name: string;
	description?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	readonly: boolean;
	prompt: string;
	skillPaths: string[];
	path: string;
	source: "project" | "global";
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function stringList(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!values) return undefined;
	const result = values.map((item) => String(item).trim()).filter(Boolean);
	return result.length > 0 ? result : undefined;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === "true";
}

function resolveSkillPaths(skills: string[] | undefined, cwd: string, agentDir: string): string[] {
	if (!skills) return [];
	const roots = [
		path.join(cwd, ".pi", "skills"),
		path.join(cwd, ".agents", "skills"),
		path.join(agentDir, "skills"),
		path.join(homedir(), ".agents", "skills"),
	];
	const paths: string[] = [];
	for (const skill of skills) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill)) continue;
		for (const root of roots) {
			const candidate = path.join(root, skill, "SKILL.md");
			if (fs.existsSync(candidate)) {
				paths.push(candidate);
				break;
			}
		}
	}
	return paths;
}

export async function loadTeammateAgentDefinition(
	name: string,
	opts: { cwd: string; agentDir?: string },
): Promise<TeammateAgentDefinition> {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
		throw new Error(`Invalid agent definition name: ${JSON.stringify(name)}`);
	}

	const agentDir = opts.agentDir ?? getAgentDir();
	const candidates = [
		{ path: path.join(opts.cwd, ".pi", "agents", `${name}.md`), source: "project" as const },
		{ path: path.join(opts.cwd, ".agents", "agents", `${name}.md`), source: "project" as const },
		{ path: path.join(agentDir, "agents", `${name}.md`), source: "global" as const },
		{ path: path.join(homedir(), ".agents", "agents", `${name}.md`), source: "global" as const },
	];
	const candidate = candidates.find((entry) => fs.existsSync(entry.path));
	if (!candidate) throw new Error(`Agent definition not found: ${name}`);

	const raw = await fs.promises.readFile(candidate.path, "utf8");
	const { frontmatter, body } = parseFrontmatter(raw);
	if (booleanValue(frontmatter.disabled) || booleanValue(frontmatter["disable-model-invocation"])) {
		throw new Error(`Agent definition is disabled: ${name}`);
	}

	const thinkingRaw = typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined;
	const thinking = thinkingRaw && THINKING_LEVELS.has(thinkingRaw as ThinkingLevel)
		? (thinkingRaw as ThinkingLevel)
		: undefined;
	const tools = stringList(frontmatter.tools);
	const readonly = booleanValue(frontmatter.readonly);
	// `bash` can write anywhere, so a readonly definition cannot safely retain it.
	const effectiveTools = readonly ? tools?.filter((tool) => !["bash", "edit", "write"].includes(tool)) : tools;
	const skills = stringList(frontmatter.skills);

	return {
		name,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking,
		tools: effectiveTools,
		readonly,
		prompt: body.trim(),
		skillPaths: resolveSkillPaths(skills, opts.cwd, agentDir),
		path: candidate.path,
		source: candidate.source,
	};
}
