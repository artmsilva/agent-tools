const API = "https://api.tavily.com";

export type SearchInput = {
	query: string;
	search_depth?: "advanced" | "basic" | "fast" | "ultra-fast";
	chunks_per_source?: number;
	topic?: "general" | "news" | "finance";
	country?: string;
	[key: string]: unknown;
};

export type FetchInput = {
	urls: string | string[];
	query?: string;
	chunks_per_source?: number;
	timeout?: number;
	[key: string]: unknown;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function validateSearch(params: SearchInput): void {
	if (params.chunks_per_source !== undefined && params.search_depth !== "advanced") {
		throw new Error("chunks_per_source requires search_depth=advanced");
	}
	if (params.country && params.topic && params.topic !== "general") {
		throw new Error("country is valid only with topic=general");
	}
}

export function normalizeFetch(params: FetchInput): FetchInput & { urls: string[] } {
	const urls = typeof params.urls === "string" ? [params.urls] : params.urls;
	if (urls.length === 0 || urls.length > 20) throw new Error("urls must contain 1 to 20 entries");
	if (params.chunks_per_source !== undefined && !params.query) {
		throw new Error("chunks_per_source requires query");
	}
	return { ...params, urls };
}

export async function requestTavily(
	endpoint: "search" | "extract",
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchImpl: FetchLike = fetch,
	apiKey = process.env.TAVILY_API_KEY?.trim(),
): Promise<unknown> {
	if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

	const response = await fetchImpl(`${API}/${endpoint}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"X-Client-Source": "pi-tavily-native",
		},
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	if (!response.ok) {
		let message = text;
		try {
			const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown };
			message = String(parsed.detail ?? parsed.error ?? text);
		} catch {}
		throw new Error(`Tavily ${endpoint} failed (${response.status}): ${message || response.statusText}`);
	}

	return text ? JSON.parse(text) : {};
}
