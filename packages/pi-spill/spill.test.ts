import { describe, expect, test } from 'bun:test';
import { spillToolResult } from './index';
import {
	MAX_INLINE_BYTES,
	createSpillPlan,
	formatBytes,
	replaceTextBlocks,
} from './spill';

describe('createSpillPlan', () => {
	test('leaves bounded output alone', () => {
		expect(createSpillPlan([{ type: 'text', text: 'x'.repeat(MAX_INLINE_BYTES) }])).toBeNull();
	});

	test('keeps a UTF-8-safe head and tail', () => {
		const text = `START-${'媒体上传'.repeat(3_000)}-END`;
		const plan = createSpillPlan([{ type: 'text', text }]);

		expect(plan).not.toBeNull();
		expect(plan?.fullText).toBe(text);
		expect(plan?.preview).toStartWith('START-');
		expect(plan?.preview).toEndWith('-END');
		expect(plan?.preview).not.toContain('�');
		expect(plan?.omittedBytes).toBeGreaterThan(0);
	});

	test('joins multiple text blocks but ignores images', () => {
		const plan = createSpillPlan(
			[
				{ type: 'text', text: 'first' },
				{ type: 'image', data: 'not text' },
				{ type: 'text', text: 'second' },
			],
			5,
		);
		expect(plan?.fullText).toBe('first\n\nsecond');
	});
});

describe('replaceTextBlocks', () => {
	test('replaces all text with one preview and preserves non-text blocks', () => {
		const image = { type: 'image', data: 'abc' };
		expect(replaceTextBlocks([
			{ type: 'text', text: 'one' },
			image,
			{ type: 'text', text: 'two' },
		], 'preview')).toEqual([
			{ type: 'text', text: 'preview' },
			image,
		]);
	});
});

describe('spillToolResult', () => {
	test('saves large output and returns only its preview', async () => {
		const fullText = `START-${'x'.repeat(MAX_INLINE_BYTES)}-END`;
		let written = '';
		const result = await spillToolResult(
			{ toolName: 'bash', content: [{ type: 'text', text: fullText }] },
			async (toolName, content) => {
				expect(toolName).toBe('bash');
				written = content;
				return '/tmp/pi-spill-test/bash.txt';
			},
		);

		expect(written).toBe(fullText);
		const preview = (result?.content[0] as { text: string }).text;
		expect(preview).toContain('/tmp/pi-spill-test/bash.txt');
		expect(preview.length < fullText.length).toBe(true);
	});

	test('keeps the preview when local storage fails', async () => {
		const result = await spillToolResult(
			{ toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(MAX_INLINE_BYTES + 1) }] },
			async () => { throw new Error('disk full'); },
		);
		expect(result?.content[0]).toMatchObject({
			text: expect.stringContaining('full output could not be saved: disk full'),
		});
	});
});

test('formatBytes stays compact', () => {
	expect(formatBytes(10)).toBe('10 B');
	expect(formatBytes(2_048)).toBe('2.0 KiB');
	expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MiB');
});
