import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ExaSearch } from "./exa.js";
import { PageStore } from "./pages.js";
import { cleanText, validateSearch, WebError, type SearchProvider } from "./search.js";

const errorSchema = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) });
const domains = (description: string) => Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 10, uniqueItems: true, description });
const date = (description: string) => Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description });
const pageFields = {
	url: Type.String(), title: Type.String(), fetched_at: Type.String(), total_chars: Type.Integer(),
	next_offset: Type.Union([Type.Integer(), Type.Null()]),
};

function result(value: NonNullable<AgentToolResult<undefined>["structuredContent"]>, text: string, isError = false): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined, structuredContent: value, ...(isError && { isError }) };
}

async function execute(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<AgentToolResult<undefined>>) {
	const deadline = AbortSignal.timeout(45_000);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		combined.throwIfAborted();
		return await operation(combined);
	} catch (error) {
		if (signal?.aborted) throw signal.reason;
		const timedOut = deadline.aborted || (error instanceof Error && error.name === "TimeoutError");
		const code = timedOut ? "timeout" : error instanceof WebError ? error.code : "network_error";
		const message = timedOut ? "The web request timed out." : cleanText(error instanceof Error ? error.message : String(error));
		return result({ error: { code, message } }, `${code}: ${message}`, true);
	}
}

export default function (pi: ExtensionAPI) {
	let search: SearchProvider | undefined;
	let pages: PageStore | undefined;
	pi.on("session_shutdown", async () => {
		await Promise.all([search?.close(), pages?.close()]);
		search = undefined;
		pages = undefined;
	});

	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: `Search the web for pages relevant to a query. Returns titles, URLs, short excerpts, and publication dates when available.
Use web_fetch to read a result before relying on details beyond its excerpt. Domain and publication-date filters narrow the search. An empty results array means no matches, while failures return error with code and message.`,
		promptSnippet: "Search the web for current information and source URLs.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 1000, description: "Search question or keywords." }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum results. Defaults to 5." })),
			include_domains: Type.Optional(domains("Restrict results to these domains, such as docs.python.org.")),
			exclude_domains: Type.Optional(domains("Exclude results from these domains.")),
			published_after: Type.Optional(date("Earliest publication date, YYYY-MM-DD.")),
			published_before: Type.Optional(date("Latest publication date, YYYY-MM-DD.")),
		}, { additionalProperties: false }),
		outputSchema: Type.Union([Type.Object({
			provider: Type.String(),
			results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String(), published_at: Type.Optional(Type.String()) })),
			warnings: Type.Optional(Type.Array(Type.String())),
		}), errorSchema]),
		executionMode: "parallel",
		async execute(_callId, params, signal) {
			return execute(signal, async active => {
				const value = await (search ??= new ExaSearch()).search(validateSearch(params), active);
				const text = value.results.map((item, i) => `${i + 1}. ${item.title}\n${item.url}${item.published_at ? `\nPublished: ${item.published_at}` : ""}\n${item.snippet}`).join("\n\n");
				return result({ ...value }, (text || "No results found.") + (value.warnings ? `\n\n${value.warnings.join("\n")}` : ""));
			});
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Fetch web page",
		description: `Read a public web page as Markdown or plain text. Preserves links, code, and tables without generating a summary. Does not execute JavaScript.
Read long pages in chunks by passing next_offset as offset on the next call with the same URL. Offsets count characters from zero, not bytes or lines.
With find, return up to 10 matching passages from a case-insensitive literal text search. Each passage has an offset for reading more context. Keep find when continuing through matches with next_offset. Null next_offset means there is no more content or no more matches.
Pages are cached for 15 minutes. Set refresh to fetch the page again. Failures return error with code and message.`,
		promptSnippet: "Read a web page or find text within it.",
		parameters: Type.Object({
			url: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute HTTP or HTTPS page URL." }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to read or search from. Defaults to 0." })),
			max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 24_000, description: "Maximum returned content characters. Defaults to 12000." })),
			find: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Literal text to find. Returns matching passages instead of a page chunk." })),
			refresh: Type.Optional(Type.Boolean({ description: "Download again instead of using the cached page." })),
		}, { additionalProperties: false }),
		outputSchema: Type.Union([
			Type.Object({ ...pageFields, offset: Type.Integer(), content: Type.String() }),
			Type.Object({ ...pageFields, find: Type.String(), matches: Type.Array(Type.Object({ offset: Type.Integer(), content: Type.String() })) }),
			errorSchema,
		]),
		executionMode: "parallel",
		async execute(_callId, params, signal) {
			return execute(signal, async active => {
				const value = await (pages ??= new PageStore()).read(params, active);
				const body = "matches" in value
					? value.matches.map(match => `[offset ${match.offset}]\n${match.content}`).join("\n\n") || "No matches found."
					: `[offset ${value.offset}]\n${value.content}`;
				const continuation = value.next_offset === null ? "" : `\n\nNext offset: ${value.next_offset}`;
				return result(value, `${value.title}\n${value.url}\nFetched: ${value.fetched_at} | ${value.total_chars} characters\n\n${body}${continuation}`);
			});
		},
	});
}
