import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createSpillPlan,
	formatBytes,
	replaceTextBlocks,
	type TextLikeContent,
} from './spill';

export type SpillWriter = (toolName: string, content: string) => Promise<string>;

async function writeSpill(toolName: string, content: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'pi-spill-'));
	const tool = toolName.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60) || 'tool';
	const path = join(directory, `${tool}.txt`);
	await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
	return path;
}

export async function spillToolResult<T extends TextLikeContent>(
	event: { toolName: string; content: readonly T[] },
	writer: SpillWriter = writeSpill,
): Promise<{ content: T[] } | undefined> {
	const plan = createSpillPlan(event.content);
	if (!plan) return;

	let notice: string;
	try {
		const path = await writer(event.toolName, plan.fullText);
		notice = `[pi-spill: ${formatBytes(plan.totalBytes)} saved to ${path}. Use read or bash to inspect it.]`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notice = `[pi-spill: full output could not be saved: ${message}]`;
	}

	return {
		content: replaceTextBlocks(event.content, `${plan.preview}\n\n${notice}`),
	};
}

export default function (pi: ExtensionAPI) {
	pi.on('tool_result', (event) => spillToolResult(event));
}
