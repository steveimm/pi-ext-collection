import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { Check } from "typebox/value";
import { Response as FetchResponse } from "undici";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { PageStore, extractPage } = await jiti.import("../pages.ts");
const { PageDownloader, pageUrl, publicLookup } = await jiti.import("../network.ts");
const { ExaSearch, normalizeExa } = await jiti.import("../exa.ts");
const { validateSearch } = await jiti.import("../search.ts");
const { default: extension } = await jiti.import("../index.ts");
const active = () => AbortSignal.timeout(10_000);

function pages(t, text, download) {
	let calls = 0;
	const store = new PageStore({
		download: async (url, signal) => { calls++; return download ? download(url, signal) : { url, type: "text/plain", text }; },
		close: async () => {},
	});
	t.after(() => store.close());
	return { store, calls: () => calls };
}

function mockExa(t, handler) {
	const calls = [];
	let connections = 0;
	t.mock.method(globalThis, "fetch", async (input, init) => {
		assert.equal(new URL(String(input)).origin, "https://mcp.exa.ai");
		if (init?.method === "GET") return new Response(null, { status: 405 });
		const body = JSON.parse(init.body);
		let result;
		if (body.method === "initialize") {
			connections++;
			result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
		} else if (body.method === "tools/call") {
			calls.push({ ...body.params, headers: new Headers(init.headers) });
			result = await handler(body.params, init);
			if (result instanceof Response) return result;
		} else return new Response(null, { status: 202 });
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
	});
	return { calls, connections: () => connections };
}

const searchResult = query => ({ content: [{ type: "text", text: JSON.stringify({ results: [
	{ title: query, url: "https://example.org/docs", highlights: ["Relevant source text"], publishedDate: "2026-10-01" },
] }) }] });

test("HTML extraction preserves code, tables, and resolved links while removing navigation", () => {
	const page = extractPage({ url: "https://example.org/docs/", type: "text/html", text: `<!doctype html><html>
<head><title>API guide</title></head><body><nav>Unrelated navigation</nav><main><h1>Authentication</h1>
<p>Read the <a href="../api">API reference</a> and configure a token.</p>
<pre><code class="language-js">const token = "abc";\n  send(token);</code></pre>
<table><thead><tr><th>Header</th><th>Value</th></tr></thead><tbody><tr><td>Authorization</td><td>Bearer</td></tr></tbody></table>
<script>dangerous()</script></main></body></html>` });
	assert.match(page.text, /https:\/\/example.org\/api/);
	assert.match(page.text, /```js\nconst token = "abc";\n  send\(token\);/);
	assert.match(page.text, /\| Header \| Value \|/);
	assert.doesNotMatch(page.text, /Unrelated navigation|dangerous\(\)/);
	assert.equal(page.title, "API guide");
});

test("chunks reassemble the original text across Unicode boundaries with one download", async t => {
	const source = "Hello 😀 한글\n".repeat(5000);
	const { store, calls } = pages(t, source);
	let offset = 0;
	let actual = "";
	for (;;) {
		const part = await store.read({ url: "https://example.org", offset, max_chars: 1001 }, active());
		assert(Buffer.byteLength(part.content) <= 24 * 1024);
		assert(!/[\uD800-\uDBFF]$/u.test(part.content));
		actual += part.content;
		if (part.next_offset === null) break;
		assert(part.next_offset > offset);
		offset = part.next_offset;
	}
	assert.equal(actual, source.trim());
	assert.equal(calls(), 1);
});

test("find is literal and case-insensitive, with usable offsets and continuation", async t => {
	const source = ("a".repeat(1000) + "İ before AUTH[0].* " + "z".repeat(1000)).repeat(30);
	const { store, calls } = pages(t, source);
	let offset = 0;
	let total = 0;
	for (;;) {
		const result = await store.read({ url: "https://example.org", find: "auth[0].*", offset }, active());
		for (const match of result.matches) {
			assert.equal(source.slice(match.offset, match.offset + match.content.length), match.content);
			assert.match(match.content, /AUTH\[0\]\.\*/);
		}
		total += result.matches.length;
		if (result.next_offset === null) break;
		assert(result.next_offset > offset);
		offset = result.next_offset;
	}
	assert.equal(total, 30);
	assert.equal(calls(), 1);
	assert.deepEqual((await store.read({ url: "https://example.org", find: "missing" }, active())).matches, []);
});

test("concurrent page reads share a request and one cancellation does not cancel another", async t => {
	let finish;
	let requestSignal;
	const { store, calls } = pages(t, "", async (url, signal) => {
		requestSignal = signal;
		await new Promise((resolve, reject) => { finish = resolve; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
		return { url, type: "text/plain", text: "shared page" };
	});
	const cancelled = new AbortController();
	const first = store.get("https://example.org", false, cancelled.signal);
	const second = store.get("https://example.org", false, active());
	cancelled.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(requestSignal.aborted, false);
	finish();
	assert.equal((await second).text, "shared page");
	assert.equal(calls(), 1);
});

test("cancelling the last reader cancels the download and a later call can retry", async t => {
	let requestSignal;
	const { store, calls } = pages(t, "", async (url, signal) => {
		requestSignal = signal;
		if (calls() === 1) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		return { url, type: "text/plain", text: "retried" };
	});
	const controller = new AbortController();
	const pending = store.get("https://example.org", false, controller.signal);
	controller.abort();
	await assert.rejects(pending);
	assert.equal(requestSignal.aborted, true);
	assert.equal((await store.get("https://example.org", false, active())).text, "retried");
	assert.equal(calls(), 2);
});

test("refresh, expiration, redirects, and eviction keep the page cache bounded", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
	const { store, calls } = pages(t, "", async url => ({ url: url.replace("/redirect", "/final"), type: "text/plain", text: `version ${calls()}` }));
	const first = await store.get("https://example.org/redirect", false, active());
	assert.equal(await store.get("https://example.org/final", false, active()), first);
	assert.equal(calls(), 1);
	assert.notEqual(await store.get("https://example.org/redirect", true, active()), first);
	t.mock.timers.tick(15 * 60_000);
	await store.get("https://example.org/final", false, active());
	assert.equal(calls(), 3);
	for (let i = 0; i < 40; i++) await store.get(`https://example.org/page-${i}`, false, active());
	await store.get("https://example.org/page-0", false, active());
	assert.equal(calls(), 44);
	await store.close();
	await assert.rejects(store.get("https://example.org", false, active()), { code: "closed" });
});

test("page errors are not cached and invalid offsets and empty find are explicit errors", async t => {
	const { store, calls } = pages(t, "", async url => {
		if (calls() === 1) throw new Error("temporary failure");
		return { url, type: "text/plain", text: "valid page" };
	});
	await assert.rejects(store.get("https://example.org", false, active()), /temporary failure/);
	await store.get("https://example.org", false, active());
	await assert.rejects(store.read({ url: "https://example.org", offset: 999 }, active()), { code: "invalid_argument" });
	await assert.rejects(store.read({ url: "https://example.org", find: " " }, active()), { code: "invalid_argument" });
	assert.equal(calls(), 2);
});

test("public URL checks cover encoded IPs, IPv6, credentials, and private DNS results", async () => {
	for (const url of ["file:///etc/hosts", "http://127.1", "http://0x7f000001", "http://[::1]", "http://[::ffff:127.0.0.1]",
		"http://169.254.169.254/", "http://10.0.0.1", "http://[fc00::1]", "http://localhost", "https://user:pass@example.org"]) {
		assert.throws(() => pageUrl(url), undefined, url);
	}
	assert.equal(pageUrl("https://example.org/docs#part").href, "https://example.org/docs");
	await assert.rejects(new Promise((resolve, reject) => publicLookup("localhost", {}, (error, address) => error ? reject(error) : resolve(address))), { code: "blocked_address" });
});

test("redirect destinations are checked before requesting them", async t => {
	let requests = 0;
	const downloader = new PageDownloader(async (_url, options) => {
		requests++;
		assert.equal(options.redirect, "manual");
		return new FetchResponse(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
	});
	t.after(() => downloader.close());
	await assert.rejects(downloader.download("https://example.org", active()), { code: "blocked_address" });
	assert.equal(requests, 1);
});

test("HTTP failures, unsupported media, charset decoding, and download limits are distinct", async t => {
	let response;
	const downloader = new PageDownloader(async () => response);
	t.after(() => downloader.close());
	response = new FetchResponse("blocked", { status: 403 });
	await assert.rejects(downloader.download("https://example.org", active()), { code: "access_denied" });
	response = new FetchResponse("PDF", { headers: { "content-type": "application/pdf" } });
	await assert.rejects(downloader.download("https://example.org", active()), { code: "unsupported_content" });
	response = new FetchResponse(Uint8Array.from([99, 97, 102, 233]), { headers: { "content-type": "text/plain; charset=iso-8859-1" } });
	assert.equal((await downloader.download("https://example.org", active())).text, "café");
	response = new FetchResponse("x".repeat(5 * 1024 * 1024 + 1), { headers: { "content-type": "text/plain" } });
	await assert.rejects(downloader.download("https://example.org", active()), { code: "too_large" });
});

test("Exa reuses one connection, forwards filters, and keeps credentials out of results", async t => {
	const { calls, connections } = mockExa(t, params => searchResult(params.arguments.query));
	const provider = new ExaSearch("fixture-secret");
	t.after(() => provider.close());
	const options = validateSearch({ query: "  API docs  ", count: 3, include_domains: ["example.org"], exclude_domains: ["spam.org"],
		published_after: "2026-01-01", published_before: "2026-10-31" });
	const result = await Promise.all([provider.search(options, active()), provider.search({ query: "other" }, active())]);
	assert.equal(connections(), 1);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].arguments, { query: "API docs", numResults: 3, type: "auto", enableHighlights: true, highlightsMaxCharacters: 1200,
		includeDomains: ["example.org"], excludeDomains: ["spam.org"], startPublishedDate: "2026-01-01", endPublishedDate: "2026-10-31" });
	assert.equal(calls[0].headers.get("x-api-key"), "fixture-secret");
	assert.equal(result[0].results[0].published_at, "2026-10-01");
	assert(!JSON.stringify(result).includes("fixture-secret"));
});

test("Exa distinguishes empty results, rate limits, malformed data, and provider failures", async t => {
	let response = { content: [{ type: "text", text: '{"results":[]}' }] };
	mockExa(t, () => response);
	const provider = new ExaSearch("fixture-secret");
	t.after(() => provider.close());
	assert.deepEqual((await provider.search({ query: "none" }, active())).results, []);
	response = { _meta: { "ai.exa/rateLimited": true }, content: [{ type: "text", text: "limit" }] };
	await assert.rejects(provider.search({ query: "limited" }, active()), { code: "rate_limited" });
	response = { content: [{ type: "text", text: "not json" }] };
	await assert.rejects(provider.search({ query: "broken" }, active()), { code: "invalid_response" });
	response = { isError: true, content: [{ type: "text", text: "rejected fixture-secret" }] };
	await assert.rejects(provider.search({ query: "failed" }, active()), error => error.code === "provider_error" && !error.message.includes("fixture-secret"));
	response = new Response("rate limit", { status: 429 });
	await assert.rejects(provider.search({ query: "limited" }, active()), { code: "rate_limited" });
});

test("Exa cancellation returns promptly without cancelling another search", async t => {
	let finish;
	mockExa(t, async params => {
		if (params.arguments.query === "slow") await new Promise(resolve => { finish = resolve; });
		return searchResult(params.arguments.query);
	});
	const provider = new ExaSearch("");
	t.after(() => provider.close());
	await provider.search({ query: "connect" }, active());
	const controller = new AbortController();
	const cancelled = provider.search({ query: "slow" }, controller.signal);
	while (!finish) await new Promise(resolve => setImmediate(resolve));
	controller.abort();
	await assert.rejects(cancelled);
	assert.equal((await provider.search({ query: "independent" }, active())).results[0].title, "independent");
	finish();
});

test("normalization deduplicates URLs and bounds excerpts without changing result meaning", () => {
	const result = normalizeExa({ results: [
		{ title: "Title", url: "https://example.org/#one", highlights: ["한".repeat(5000)] },
		{ title: "Duplicate", url: "https://example.org/#two", highlights: ["other"] },
	], warnings: [{ message: "Filter relaxed" }] }, 5);
	assert.equal(result.results.length, 1);
	assert(Buffer.byteLength(result.results[0].snippet) <= 2400);
	assert.deepEqual(result.warnings, ["Filter relaxed"]);
	for (const options of [{ query: " " }, { query: "q", published_after: "2026-02-30" }, { query: "q", published_after: "2026-99-01" },
		{ query: "q", include_domains: ["https://example.org/path"] }, { query: "q", published_after: "2026-11-01", published_before: "2026-01-01" }]) {
		assert.throws(() => validateSearch(options), { code: "invalid_argument" });
	}
});

test("tool schemas reject invalid options and structured errors match the declared return type", async t => {
	const tools = new Map();
	let shutdown;
	extension({ registerTool: tool => tools.set(tool.name, tool), on: (_event, handler) => { shutdown = handler; } });
	t.after(() => shutdown());
	assert.deepEqual([...tools.keys()], ["web_search", "web_fetch"]);
	for (const [name, args] of [["web_search", { query: "q", count: 0 }], ["web_search", { query: "q", count: 1.5 }],
		["web_fetch", { url: "https://example.org", offset: -1 }], ["web_fetch", { url: "https://example.org", max_chars: 25_000 }]]) {
		assert.equal(Check(tools.get(name).parameters, args), false);
	}
	for (const [name, args] of [["web_search", { query: "q", published_after: "2026-02-30" }], ["web_fetch", { url: "file:///etc/hosts" }]]) {
		const tool = tools.get(name);
		const result = await tool.execute("call", args, active());
		assert.equal(result.isError, true);
		assert(Check(tool.outputSchema, result.structuredContent));
		assert.equal(result.structuredContent.error.code, "invalid_argument");
	}
});

test("Pi loads the package and code mode receives structured results from concurrent calls", { timeout: 20_000 }, async t => {
	mockExa(t, params => searchResult(params.arguments.query));
	const root = mkdtempSync(join(tmpdir(), "pi-web-sdk-"));
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, disabledBuiltinExtensions: ["mcp"],
		additionalExtensionPaths: [fileURLToPath(new URL("..", import.meta.url))],
		extensionFactories: [createCodemodeExtension({ models: false })],
		noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
	});
	let session;
	t.after(async () => {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); session.dispose(); }
		rmSync(root, { recursive: true, force: true });
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager,
		sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
	await session.bindExtensions({});
	assert(session.getActiveToolNames().includes("web_search"));
	assert(session.getActiveToolNames().includes("web_fetch"));
	session.setActiveToolsByName(["web_search", "web_fetch", "codemode"]);
	const signal = active();
	const context = session.extensionRunner.createToolContext("code", signal);
	const code = `
const results = await Promise.all([tools.web_search({query: "one"}), tools.web_search({query: "two"})]);
const failure = await tools.web_fetch({url: "file:///etc/hosts"});
text({titles: results.map(r => r.results[0].title), error: failure.error.code});
`;
	session.agent.state.messages = [...session.agent.state.messages, {
		role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
		content: [{ type: "toolCall", id: "code", name: "codemode", arguments: { code } }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}];
	const result = await session.getToolDefinition("codemode").execute("code", { code }, signal, undefined, context);
	assert(!result.isError, JSON.stringify(result));
	const output = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
	assert.match(output, /"titles":\["one","two"\]/);
	assert.match(output, /"error":"invalid_argument"/);
});
