import { Buffer } from 'node:buffer';

export const MAX_INLINE_BYTES = 8 * 1024;
const PREVIEW_BYTES = 4 * 1024;

export interface TextLikeContent {
	type: string;
}

function blockText(block: TextLikeContent): string | null {
	if (block.type !== 'text' || !('text' in block)) return null;
	const text = (block as { text?: unknown }).text;
	return typeof text === 'string' ? text : null;
}

export interface SpillPlan {
	fullText: string;
	preview: string;
	totalBytes: number;
	omittedBytes: number;
}

function takeHead(text: string, maxBytes: number): string {
	let bytes = 0;
	let output = '';
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		output += character;
		bytes += size;
	}
	return output;
}

function takeTail(text: string, maxBytes: number): string {
	let bytes = 0;
	const characters: string[] = [];
	for (let end = text.length; end > 0;) {
		let start = end - 1;
		const code = text.charCodeAt(start);
		if (code >= 0xdc00 && code <= 0xdfff && start > 0) start--;
		const character = text.slice(start, end);
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		characters.push(character);
		bytes += size;
		end = start;
	}
	return characters.reverse().join('');
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function createSpillPlan<T extends TextLikeContent>(
	content: readonly T[],
	maxInlineBytes = MAX_INLINE_BYTES,
	previewBytes = PREVIEW_BYTES,
): SpillPlan | null {
	const fullText = content
		.map(blockText)
		.filter((text): text is string => text !== null)
		.join('\n\n');
	const totalBytes = Buffer.byteLength(fullText);
	if (totalBytes <= maxInlineBytes) return null;

	const headBudget = Math.ceil(previewBytes * 0.65);
	const tailBudget = Math.max(0, previewBytes - headBudget);
	const head = takeHead(fullText, headBudget);
	const tail = takeTail(fullText, tailBudget);
	const omittedBytes = Math.max(
		0,
		totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail),
	);

	return {
		fullText,
		preview: `${head}\n\n… ${formatBytes(omittedBytes)} omitted …\n\n${tail}`,
		totalBytes,
		omittedBytes,
	};
}

export function replaceTextBlocks<T extends TextLikeContent>(
	content: readonly T[],
	replacement: string,
): T[] {
	let replaced = false;
	const output: T[] = [];
	for (const block of content) {
		if (blockText(block) === null) {
			output.push(block);
			continue;
		}
		if (replaced) continue;
		output.push({ ...block, text: replacement });
		replaced = true;
	}
	return output;
}
