import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { abortable, boundedText, cleanText, WebError, type SearchOptions, type SearchProvider, type SearchResponse } from "./search.js";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ExaSearch implements SearchProvider {
	private connection: Promise<Client> | undefined;
	private client: Client | undefined;
	private readonly lifetime = new AbortController();

	constructor(private readonly apiKey = process.env.EXA_API_KEY?.trim()) {}

	private connect(): Promise<Client> {
		if (this.connection) return this.connection;
		this.lifetime.signal.throwIfAborted();
		const client = new Client({ name: "pi-web-search", version: "0.1.0" });
		this.client = client;
		const transport = new StreamableHTTPClientTransport(new URL("https://mcp.exa.ai/mcp?tools=web_search_advanced_exa"), {
			requestInit: { headers: this.apiKey ? { "x-api-key": this.apiKey } : {}, redirect: "error" },
		});
		client.onclose = () => { if (this.client === client) { this.connection = undefined; this.client = undefined; } };
		this.connection = client.connect(transport, { signal: this.lifetime.signal, timeout: 20_000 }).then(() => client).catch(async error => {
			await client.close().catch(() => {});
			if (this.client === client) { this.connection = undefined; this.client = undefined; }
			throw error;
		});
		return this.connection;
	}

	async search(options: SearchOptions, signal: AbortSignal): Promise<SearchResponse> {
		try {
			const client = await abortable(this.connect(), signal);
			const response = await client.callTool({ name: "web_search_advanced_exa", arguments: {
				query: options.query,
				numResults: options.count ?? 5,
				type: "auto",
				enableHighlights: true,
				highlightsMaxCharacters: 1200,
				...(options.include_domains && { includeDomains: options.include_domains }),
				...(options.exclude_domains && { excludeDomains: options.exclude_domains }),
				...(options.published_after && { startPublishedDate: options.published_after }),
				...(options.published_before && { endPublishedDate: options.published_before }),
			} }, undefined, { signal, timeout: 30_000 });
			if (response._meta?.["ai.exa/rateLimited"] === true) {
				throw new WebError("rate_limited", "Exa's keyless search allowance is exhausted. Set EXA_API_KEY or try again later.");
			}
			const blocks: unknown[] = Array.isArray(response.content) ? response.content : [];
			const text = blocks.flatMap(item => record(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
			if (response.isError) throw new WebError("provider_error", boundedText(text, 500));
			let data: unknown;
			try { data = JSON.parse(text); } catch { throw new WebError("invalid_response", "Exa returned an unreadable search response."); }
			return normalizeExa(data, options.count ?? 5);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof WebError) {
				if (this.apiKey) error.message = error.message.replaceAll(this.apiKey, "[redacted]");
				throw error;
			}
			if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw new WebError("timeout", "Exa search timed out.");
			if (error instanceof StreamableHTTPError) {
				if (error.code === 429) throw new WebError("rate_limited", "Exa rate limit reached. Try again later or configure EXA_API_KEY.");
				if (error.code === 401 || error.code === 403) throw new WebError("authentication", "Exa rejected authentication. Check EXA_API_KEY.");
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new WebError("provider_error", boundedText(this.apiKey ? message.replaceAll(this.apiKey, "[redacted]") : message, 500));
		}
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		await this.client?.close();
	}
}

export function normalizeExa(data: unknown, count: number): SearchResponse {
	if (!record(data) || !Array.isArray(data.results)) throw new WebError("invalid_response", "Exa's response is missing search results.");
	const results: SearchResponse["results"] = [];
	const seen = new Set<string>();
	for (const item of data.results) {
		if (!record(item) || typeof item.url !== "string") throw new WebError("invalid_response", "Exa returned a result without a URL.");
		let url: URL;
		try { url = new URL(item.url); } catch { throw new WebError("invalid_response", "Exa returned an invalid result URL."); }
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
		url.hash = "";
		if (seen.has(url.href)) continue;
		seen.add(url.href);
		const highlights = Array.isArray(item.highlights) ? item.highlights.filter((value): value is string => typeof value === "string") : [];
		const snippet = highlights.join("\n") || (typeof item.text === "string" ? item.text : "");
		results.push({
			title: boundedText(cleanText(typeof item.title === "string" ? item.title : url.hostname), 300),
			url: url.href,
			snippet: boundedText(cleanText(snippet).trim(), 1200, 2400),
			...(typeof item.publishedDate === "string" && { published_at: item.publishedDate }),
		});
		if (results.length === count) break;
	}
	const warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), ...(Array.isArray(data.notices) ? data.notices : [])]
		.flatMap(item => record(item) && typeof item.message === "string" ? [boundedText(cleanText(item.message), 300)] : []).slice(0, 5);
	return { provider: "exa", results, ...(warnings.length && { warnings }) };
}
