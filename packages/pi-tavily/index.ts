import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFetch, requestTavily, validateSearch } from "./client.js";

const SEARCH_DEPTH = ["advanced", "basic", "fast", "ultra-fast"] as const;
const TOPIC = ["general", "news", "finance"] as const;
const TIME_RANGE = ["day", "week", "month", "year", "d", "w", "m", "y"] as const;
const ANSWER_MODE = ["basic", "advanced"] as const;
const RAW_MODE = ["markdown", "text"] as const;
const EXTRACT_DEPTH = ["basic", "advanced"] as const;

const SearchParams = Type.Object({
	query: Type.String({ description: "The search query to execute." }),
	search_depth: Type.Optional(StringEnum(SEARCH_DEPTH, { description: "Latency versus relevance tradeoff." })),
	chunks_per_source: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
	max_results: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
	topic: Type.Optional(StringEnum(TOPIC)),
	time_range: Type.Optional(StringEnum(TIME_RANGE)),
	start_date: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
	end_date: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
	include_answer: Type.Optional(Type.Union([Type.Boolean(), StringEnum(ANSWER_MODE)])),
	include_raw_content: Type.Optional(Type.Union([Type.Boolean(), StringEnum(RAW_MODE)])),
	include_images: Type.Optional(Type.Boolean()),
	include_image_descriptions: Type.Optional(Type.Boolean()),
	include_favicon: Type.Optional(Type.Boolean()),
	include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 300 })),
	exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 150 })),
	country: Type.Optional(Type.String({ description: "Country boost; valid only for general topic." })),
	auto_parameters: Type.Optional(Type.Boolean()),
	exact_match: Type.Optional(Type.Boolean()),
	include_usage: Type.Optional(Type.Boolean()),
});

const FetchParams = Type.Object({
	urls: Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 20 })]),
	query: Type.Optional(Type.String()),
	chunks_per_source: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	extract_depth: Type.Optional(StringEnum(EXTRACT_DEPTH)),
	include_images: Type.Optional(Type.Boolean()),
	include_favicon: Type.Optional(Type.Boolean()),
	format: Type.Optional(StringEnum(RAW_MODE)),
	timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
	include_usage: Type.Optional(Type.Boolean()),
});

async function formatOutput(prefix: string, payload: unknown): Promise<string> {
	const text = JSON.stringify(payload, null, 2);
	const truncated = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncated.truncated) return text;

	const file = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
	await writeFile(file, text, "utf8");
	return `${truncated.content}\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines (${formatSize(truncated.outputBytes)}/${formatSize(truncated.totalBytes)}). Full output: ${file}]`;
}

export default function tavilyNative(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tavily_search",
		label: "Tavily Search",
		description: "Search the web using Tavily Search.",
		promptSnippet: "Search the web with Tavily for current information, external facts, and sources.",
		promptGuidelines: [
			"Use tavily_search for current web information; keep queries concise and use tavily_fetch for deep extraction from selected URLs.",
		],
		parameters: SearchParams,
		async execute(_id, params, signal, _update, ctx) {
			validateSearch(params);
			const payload = await requestTavily(
				"search",
				{ ...params },
				signal,
			);
			const text = await formatOutput("tavily-search", payload);
			return { content: [{ type: "text", text }], details: payload };
		},
	});

	pi.registerTool({
		name: "tavily_fetch",
		label: "Tavily Fetch",
		description: "Extract web page content from one or more URLs using Tavily Extract.",
		promptSnippet: "Fetch and extract content from known URLs with Tavily.",
		promptGuidelines: [
			"Use tavily_fetch when the user provides URLs; use query plus chunks_per_source for focused extraction.",
		],
		parameters: FetchParams,
		async execute(_id, params, signal, _update, ctx) {
			const normalized = normalizeFetch(params);
			const { timeout, ...body } = normalized;
			const timeoutSignal = timeout ? AbortSignal.timeout(timeout * 1_000) : undefined;
			const requestSignal = timeoutSignal && signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal ?? signal;
			const payload = await requestTavily("extract", body, requestSignal);
			const text = await formatOutput("tavily-extract", payload);
			return { content: [{ type: "text", text }], details: payload };
		},
	});
}
