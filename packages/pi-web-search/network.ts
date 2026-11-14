import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch, type Response } from "undici";
import { WebError } from "./search.js";

function publicAddress(address: string): boolean {
	return ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";
}

export function pageUrl(value: string): URL {
	let url: URL;
	try { url = new URL(value); } catch { throw new WebError("invalid_argument", "url must be an absolute HTTP or HTTPS URL."); }
	if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
		throw new WebError("invalid_argument", "Use an HTTP or HTTPS URL without embedded credentials.");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || (ipaddr.isValid(hostname) && !publicAddress(hostname))) {
		throw new WebError("blocked_address", "web_fetch only accesses public web addresses.");
	}
	url.hash = "";
	return url;
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
	lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) return callback(error, "", 0);
		if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
			return callback(new WebError("blocked_address", "The hostname resolves to a non-public address."), "", 0);
		}
		if (options.all) callback(null, addresses);
		else callback(null, addresses[0]!.address, addresses[0]!.family);
	});
};

const MAX_BYTES = 5 * 1024 * 1024;

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.length;
			if (bytes > MAX_BYTES) throw new WebError("too_large", "The page exceeds the 5 MiB download limit.");
			chunks.push(chunk.value);
		}
	} finally { await reader.cancel().catch(() => {}); }
	const charset = /charset=["']?([^;\s"']+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
	let decoder: TextDecoder;
	try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
	return decoder.decode(Buffer.concat(chunks));
}

export class PageDownloader {
	private readonly agent = new Agent({ connections: 4, connect: { lookup: publicLookup, timeout: 10_000 } });

	async download(value: string, signal: AbortSignal): Promise<{ url: string; type: string; text: string }> {
		let url = pageUrl(value);
		try {
			for (let redirects = 0; redirects <= 5; redirects++) {
				const response = await fetch(url, {
					dispatcher: this.agent,
					redirect: "manual",
					signal,
					headers: { "user-agent": "pi-web-search/0.1.0", accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.7, application/xml;q=0.6" },
				});
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					await response.body?.cancel();
					const location = response.headers.get("location");
					if (!location) throw new WebError("http_error", "The server returned a redirect without a destination.");
					url = pageUrl(new URL(location, url).href);
					continue;
				}
				if (!response.ok) {
					await response.body?.cancel();
					const code = response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "access_denied" : "http_error";
					throw new WebError(code, `The page returned HTTP ${response.status}.`);
				}
				const type = (response.headers.get("content-type") ?? "text/plain").split(";")[0]!.trim().toLowerCase();
				if (!type.startsWith("text/") && !/^(application\/(json|xml|xhtml\+xml)|application\/.+\+(json|xml))$/.test(type)) {
					await response.body?.cancel();
					throw new WebError("unsupported_content", `Cannot read ${type}. web_fetch supports HTML, text, JSON, and XML.`);
				}
				return { url: url.href, type, text: await readBody(response, signal) };
			}
			throw new WebError("http_error", "The page exceeded five redirects.");
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof Error && error.cause instanceof WebError) throw error.cause;
			throw error;
		}
	}

	async close(): Promise<void> { await this.agent.destroy(); }
}
