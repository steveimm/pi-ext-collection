export interface SearchOptions {
	query: string;
	count?: number;
	include_domains?: string[];
	exclude_domains?: string[];
	published_after?: string;
	published_before?: string;
}

export type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	published_at?: string;
};

export type SearchResponse = {
	provider: string;
	results: SearchResult[];
	warnings?: string[];
};

export interface SearchProvider {
	search(options: SearchOptions, signal: AbortSignal): Promise<SearchResponse>;
	close(): Promise<void>;
}

export class WebError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "WebError";
	}
}

export function cleanText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function boundedText(value: string, maxChars: number, maxBytes = 24 * 1024): string {
	let text = value.slice(0, maxChars);
	if (Buffer.byteLength(text) > maxBytes) text = new TextDecoder().decode(Buffer.from(text).subarray(0, maxBytes), { stream: true });
	return text.replace(/[\uD800-\uDBFF]$/u, "");
}

export function validateSearch(options: SearchOptions): SearchOptions {
	const query = options.query.trim();
	if (!query) throw new WebError("invalid_argument", "query must contain text.");
	for (const field of ["published_after", "published_before"] as const) {
		const value = options[field];
		if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
			throw new WebError("invalid_argument", `${field} must be a valid date in YYYY-MM-DD format.`);
		}
	}
	if (options.published_after && options.published_before && options.published_after > options.published_before) {
		throw new WebError("invalid_argument", "published_after must not be later than published_before.");
	}
	for (const domains of [options.include_domains, options.exclude_domains]) {
		for (const domain of domains ?? []) {
			if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
				throw new WebError("invalid_argument", `Use domain names such as example.com, without a scheme or path: ${domain}`);
			}
		}
	}
	return { ...options, query };
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
