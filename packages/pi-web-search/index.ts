import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ExaSearch } from "./exa.js";
import { cleanText, validateSearch, WebError, type SearchProvider } from "./search.js";

const errorSchema = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) });
const domains = (description: string) => Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 10, uniqueItems: true, description });
const date = (description: string) => Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description });

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
		const code = deadline.aborted ? "timeout" : error instanceof WebError ? error.code : "network_error";
		const message = deadline.aborted ? "The web request timed out." : cleanText(error instanceof Error ? error.message : String(error));
		return result({ error: { code, message } }, `${code}: ${message}`, true);
	}
}

export default function (pi: ExtensionAPI) {
	let search: SearchProvider = new ExaSearch();
	pi.on("session_start", () => { search = new ExaSearch(); });
	pi.on("session_shutdown", async () => { await search.close(); });

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
				const value = await search.search(validateSearch(params), active);
				const text = value.results.map((item, i) => `${i + 1}. ${item.title}\n${item.url}${item.published_at ? `\nPublished: ${item.published_at}` : ""}\n${item.snippet}`).join("\n\n");
				return result({ ...value }, (text || "No results found.") + (value.warnings ? `\n\n${value.warnings.join("\n")}` : ""));
			});
		},
	});
}
