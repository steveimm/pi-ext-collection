# pi-web-search

Web search and readable page fetching for Pi.
Requires Pi 1.5.1 or later and Node.js 22.19 or later.

## Setup

Try the local package from this repository:

```bash
pi --no-extensions -e ./packages/pi-web-search
```

After publishing, install it with:

```bash
pi install npm:@steveimm/pi-web-search
```

Search uses [Exa's hosted MCP service](https://exa.ai/docs/get-started/exa-mcp), which supports keyless searches subject to its free rate limit.
To use your own Exa account, set `EXA_API_KEY` before starting Pi:

```bash
export EXA_API_KEY="your-key"
pi
```

The key is sent only to Exa and is not a tool argument.
Page fetching connects directly to the requested website and requires no Exa key.

## Tools

### web_search

Find relevant web pages and return their titles, URLs, excerpts, and publication dates when available.

| Argument | Meaning |
| --- | --- |
| `query` | Required search question or keywords. |
| `count` | Maximum results, 1–15. Defaults to 5. |
| `include_domains` | Restrict results to these domain names. |
| `exclude_domains` | Exclude these domain names. |
| `published_after` | Earliest publication date, `YYYY-MM-DD`. |
| `published_before` | Latest publication date, `YYYY-MM-DD`. |

```json
{
  "query": "TypeScript generic constraints",
  "include_domains": ["typescriptlang.org"],
  "count": 3
}
```

The structured result is `{ provider, results, warnings? }`.
Each result contains `{ title, url, snippet, published_at? }`.
Excerpts are limited to 1,200 characters and 2,400 UTF-8 bytes per result.
Search does not automatically download every result or generate an answer.

### web_fetch

Read HTML as Markdown, or retrieve plain text, JSON, and XML.
Links, code blocks, and tables are retained without a summarization model.

| Argument | Meaning |
| --- | --- |
| `url` | Required absolute HTTP or HTTPS URL. |
| `offset` | Position to read or search from. Defaults to 0. |
| `max_chars` | Returned content budget, 1,000–24,000 characters. Defaults to 12,000. |
| `find` | Case-insensitive literal text to find. Returns matching passages. |
| `refresh` | Download again instead of using the cached page. |

Read a page:

```json
{"url":"https://www.typescriptlang.org/docs/handbook/2/generics.html"}
```

Find a section:

```json
{"url":"https://www.typescriptlang.org/docs/handbook/2/generics.html","find":"generic constraints"}
```

Both forms return `url`, `title`, `fetched_at`, `total_chars`, and `next_offset`.
The URL is the final destination after redirects.
A normal read also returns `offset` and `content`.
A find returns `find` and up to 10 `matches`, each with an `offset` and `content`.

Pass `next_offset` as `offset` with the same URL to continue.
Keep `find` to continue through matching passages, or omit it to read a page chunk at a passage's offset.
A null `next_offset` means there is no more content or no more matching passages.
Offsets use JavaScript string indices, not byte or line numbers.
Returned content also has a 24 KiB UTF-8 limit, so a chunk can be shorter than `max_chars`.

Pages stay in memory for 15 minutes, with at most 32 cached URL entries and 8 million text characters.
Concurrent reads of the same URL share a download.
Cancelling one reader does not cancel other readers, and cancelling all readers stops the download.
Refreshing or expiring a page can change its content and offsets.
No page cache or other files are written to disk.

Fetches only access public addresses, including after redirects and DNS resolution.
Downloads are limited to 5 MiB, extracted text to 2 million characters, and redirects to five.
JavaScript execution, browser login, binary downloads, and PDF extraction are outside this tool's scope.
Browser tools can be configured separately through MCP.

## Code mode and errors

Both tools return structured objects to Pi's code mode.
They support concurrent calls and cancellation.
Failures return `{ error: { code, message } }` and mark the tool result as an error.
An empty search result or empty match list is a successful response.
Invalid tool arguments are rejected by Pi before execution.

```js
const search = await tools.web_search({ query: "TypeScript generic constraints", count: 3 });
if (search.error) throw new Error(search.error.message);
const pages = await Promise.all(search.results.map(result => tools.web_fetch({ url: result.url })));
text(pages);
```

## Development

```bash
npm run check --workspace=packages/pi-web-search
npm test --workspace=packages/pi-web-search
```

The tests use fixture responses and Pi's SDK, including actual code-mode execution.
They do not require Exa credentials or call a model.

`SearchProvider` in `search.ts` defines the provider-independent request and result types.
`exa.ts` handles Exa's transport and response format.
To add another provider, implement that interface and select it in `index.ts`.
Page extraction and caching do not depend on the search provider.
