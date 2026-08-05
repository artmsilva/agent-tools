import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFetch, requestTavily, validateSearch } from "./client.ts";

test("validates search-only option combinations", () => {
	assert.throws(() => validateSearch({ query: "x", chunks_per_source: 2 }), /advanced/);
	assert.throws(() => validateSearch({ query: "x", topic: "news", country: "canada" }), /general/);
	assert.doesNotThrow(() => validateSearch({ query: "x", search_depth: "advanced", chunks_per_source: 2 }));
});

test("normalizes and validates fetch URLs", () => {
	assert.deepEqual(normalizeFetch({ urls: "https://example.com" }).urls, ["https://example.com"]);
	assert.throws(() => normalizeFetch({ urls: ["https://example.com"], chunks_per_source: 2 }), /requires query/);
});

test("uses native fetch with bearer auth", async () => {
	let request: { input: string; init?: RequestInit } | undefined;
	const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
		request = { input: String(input), init };
		return new Response(JSON.stringify({ results: [] }), { status: 200 });
	};

	assert.deepEqual(await requestTavily("search", { query: "pi" }, undefined, fakeFetch, "secret"), { results: [] });
	assert.equal(request?.input, "https://api.tavily.com/search");
	assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer secret");
	assert.deepEqual(JSON.parse(String(request?.init?.body)), { query: "pi" });
});

test("surfaces Tavily API errors", async () => {
	const fakeFetch = async () => new Response(JSON.stringify({ detail: "bad query" }), { status: 400 });
	await assert.rejects(requestTavily("search", { query: "x" }, undefined, fakeFetch, "secret"), /bad query/);
});
