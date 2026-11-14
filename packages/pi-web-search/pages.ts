import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { PageDownloader, pageUrl } from "./network.js";
import { abortable, boundedText, cleanText, WebError } from "./search.js";

export type Page = { url: string; title: string; text: string; fetched_at: string };
export type FetchOptions = { url: string; offset?: number; max_chars?: number; find?: string; refresh?: boolean };
type PageInfo = { url: string; title: string; fetched_at: string; total_chars: number; next_offset: number | null };
export type PageRead = PageInfo & { offset: number; content: string };
export type PageFind = PageInfo & { find: string; matches: { offset: number; content: string }[] };
type PendingPage = { promise: Promise<Page>; controller: AbortController; readers: number };

export function extractPage(source: { url: string; type: string; text: string }): Page {
	let title = new URL(source.url).hostname;
	let text = source.text;
	if (source.type === "text/html" || source.type === "application/xhtml+xml") {
		const { document } = parseHTML(text);
		title = document.title || title;
		let base = source.url;
		const declaredBase = document.querySelector("base[href]")?.getAttribute("href");
		if (declaredBase) { try { base = new URL(declaredBase, base).href; } catch {} }
		for (const node of document.querySelectorAll("a[href], img[src]")) {
			const attribute = node.tagName === "A" ? "href" : "src";
			try {
				const url = new URL(node.getAttribute(attribute)!, base);
				if (/^https?:$/.test(url.protocol)) node.setAttribute(attribute, url.href);
				else node.removeAttribute(attribute);
			} catch { node.removeAttribute(attribute); }
		}
		const article = new Readability(document.cloneNode(true) as Document, { maxElemsToParse: 100_000, keepClasses: true }).parse();
		if (article?.title) title = article.title;
		document.querySelectorAll("script, style, noscript, nav, header, footer, aside, form").forEach(node => node.remove());
		const html = article?.content || (document.querySelector("main, article, [role=main]") ?? document.body).innerHTML;
		const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
		markdown.use(gfm);
		text = markdown.turndown(html);
	}
	text = cleanText(text).replace(/\r\n?/g, "\n").trim();
	if (!text) throw new WebError("empty_content", "The page has no readable text. It may require JavaScript or a browser session.");
	if (text.length > 2_000_000) throw new WebError("too_large", "The extracted page exceeds the 2 million character limit.");
	return { url: source.url, title: boundedText(cleanText(title).trim(), 300), text, fetched_at: new Date().toISOString() };
}

export class PageStore {
	private readonly cache = new Map<string, Page>();
	private readonly pending = new Map<string, PendingPage>();
	private chars = 0;
	private closed = false;

	constructor(private readonly downloader: Pick<PageDownloader, "download" | "close"> = new PageDownloader()) {}

	private remember(key: string, page: Page): void {
		this.chars -= this.cache.get(key)?.text.length ?? 0;
		this.cache.delete(key);
		this.cache.set(key, page);
		this.chars += page.text.length;
		while (this.cache.size > 32 || this.chars > 8_000_000) {
			const oldest = this.cache.keys().next().value!;
			this.chars -= this.cache.get(oldest)!.text.length;
			this.cache.delete(oldest);
		}
	}

	async get(value: string, refresh: boolean, signal: AbortSignal): Promise<Page> {
		signal.throwIfAborted();
		if (this.closed) throw new WebError("closed", "The web session has closed.");
		const key = pageUrl(value).href;
		const cached = this.cache.get(key);
		if (!refresh && cached && Date.now() - Date.parse(cached.fetched_at) < 15 * 60_000) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}
		let pending = this.pending.get(key);
		if (!pending || pending.controller.signal.aborted) {
			const controller = new AbortController();
			const active = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
			pending = { controller, readers: 0, promise: this.downloader.download(key, active).then(source => {
				active.throwIfAborted();
				const page = extractPage(source);
				this.remember(key, page);
				if (page.url !== key) this.remember(page.url, page);
				return page;
			}).finally(() => { if (this.pending.get(key)?.controller === controller) this.pending.delete(key); }) };
			this.pending.set(key, pending);
		}
		pending.readers++;
		try { return await abortable(pending.promise, signal); }
		finally { if (--pending.readers === 0) pending.controller.abort(); }
	}

	async read(options: FetchOptions, signal: AbortSignal): Promise<PageRead | PageFind> {
		if (options.find !== undefined && !options.find.trim()) throw new WebError("invalid_argument", "find must contain text.");
		const page = await this.get(options.url, options.refresh ?? false, signal);
		const offset = options.offset ?? 0;
		if (offset > page.text.length) throw new WebError("invalid_argument", `offset exceeds this page's ${page.text.length} characters.`);
		const maxChars = options.max_chars ?? 12_000;
		const info = { url: page.url, title: page.title, fetched_at: page.fetched_at, total_chars: page.text.length };
		if (options.find === undefined) {
			const content = boundedText(page.text.slice(offset, offset + maxChars), maxChars);
			const end = offset + content.length;
			return { ...info, offset, content, next_offset: end < page.text.length ? end : null };
		}
		const pattern = new RegExp(options.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
		pattern.lastIndex = offset;
		const matches: PageFind["matches"] = [];
		let chars = 0;
		let bytes = 0;
		let next: number | null = null;
		let previousEnd = offset;
		while (true) {
			const match = pattern.exec(page.text);
			if (!match) break;
			if (matches.length === 10 || maxChars - chars < 800 || 24 * 1024 - bytes < 3200) { next = match.index; break; }
			const start = Math.max(previousEnd, match.index - 200);
			const end = Math.min(page.text.length, match.index + match[0].length + 400);
			const content = page.text.slice(start, end);
			matches.push({ offset: start, content });
			chars += content.length;
			bytes += Buffer.byteLength(content);
			previousEnd = end;
			pattern.lastIndex = end;
		}
		return { ...info, find: options.find, matches, next_offset: next };
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.pending.values()) job.controller.abort();
		this.cache.clear();
		this.pending.clear();
		this.chars = 0;
		await this.downloader.close();
	}
}
