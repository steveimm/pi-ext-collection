import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function directorySuggestions(input: string, cwd: string): Promise<{ value: string; label: string }[]> {
	const quote = input.startsWith('"') || input.startsWith("'") ? input[0]! : "";
	let path = quote ? input.slice(1) : input;
	if (quote && path.endsWith(quote)) path = path.slice(0, -1);
	const absolute = (value: string) => resolve(cwd,
		value === "~" ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value);
	let directory = absolute(path);
	let base: string;
	let fragment = "";
	if (await stat(directory).then(entry => entry.isDirectory(), () => false)) {
		base = path === "" || path.endsWith("/") || (process.platform === "win32" && path.endsWith("\\")) ? path : `${path}/`;
	} else {
		const separator = Math.max(path.lastIndexOf("/"), process.platform === "win32" ? path.lastIndexOf("\\") : -1);
		base = path.slice(0, separator + 1);
		fragment = path.slice(separator + 1).toLowerCase();
		directory = absolute(base);
	}
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const matches = await Promise.all(entries.filter(entry => entry.name.toLowerCase().startsWith(fragment)).map(async entry => {
		const isDirectory = entry.isDirectory() || (entry.isSymbolicLink()
			&& await stat(resolve(directory, entry.name)).then(target => target.isDirectory(), () => false));
		if (!isDirectory) return undefined;
		const value = `${base}${entry.name}/`;
		const delimiter = quote || (/\s|^["']/.test(value) ? '"' : "");
		return { value: delimiter ? `${delimiter}${value}${delimiter}` : value, label: `${entry.name}/` };
	}));
	return matches.filter(item => item !== undefined).sort((a, b) => a.label.localeCompare(b.label));
}

export function registerDirectoryCompletions(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const argument = (lines: string[], row: number, col: number) => row === 0
			? lines[0]?.slice(0, col).match(/^\s*\/cd[ \t]+(.*)$/)?.[1] : undefined;
		ctx.ui.addAutocompleteProvider(current => ({
			...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
			async getSuggestions(lines, row, col, options) {
				const prefix = argument(lines, row, col);
				if (prefix === undefined) return current.getSuggestions(lines, row, col, options);
				if (!options.force || options.signal.aborted) return null;
				const items = await directorySuggestions(prefix, ctx.cwd);
				return options.signal.aborted || items.length === 0 ? null : { items, prefix };
			},
			applyCompletion(lines, row, col, item, prefix) {
				if (argument(lines, row, col) === undefined) return current.applyCompletion(lines, row, col, item, prefix);
				const line = lines[row]!;
				const before = line.slice(0, col - prefix.length);
				let after = line.slice(col);
				const quote = item.value.startsWith('"') || item.value.startsWith("'") ? item.value[0]! : "";
				if (quote && after.startsWith(quote)) after = after.slice(1);
				const result = [...lines];
				result[row] = before + item.value + after;
				return { lines: result, cursorLine: row, cursorCol: before.length + item.value.length - (quote ? 1 : 0) };
			},
			shouldTriggerFileCompletion(lines, row, col) {
				return argument(lines, row, col) !== undefined || (current.shouldTriggerFileCompletion?.(lines, row, col) ?? true);
			},
		}));
	});
}
