import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { BackgroundManager } from "./manager.js";

class BackgroundHint implements Component {
	readonly body: Component;
	private enabled: () => boolean;
	private hint: string;

	constructor(body: Component, enabled: () => boolean, hint: string) {
		this.body = body;
		this.enabled = enabled;
		this.hint = hint;
	}

	render(width: number): string[] {
		const lines = this.body.render(width);
		if (!this.enabled()) return lines;
		let index = lines.length - 1;
		while (index >= 0 && !/^Elapsed \d/.test(stripTerminalSequences(lines[index]!).trim())) index--;
		if (index === -1) return lines;
		const timer = lines[index]!.trimEnd();
		const separator = visibleWidth(timer) + visibleWidth(this.hint) + 3 <= width ? " · " : "\n";
		const annotated = new Text(`${timer}${separator}${this.hint}`, 0, 0).render(width);
		return [...lines.slice(0, index), ...annotated, ...lines.slice(index + 1)];
	}

	invalidate(): void { this.body.invalidate(); }
}

export function registerBackgroundHint(pi: ExtensionAPI, getManager: () => BackgroundManager | undefined): void {
	const parents = new Map<string, string>();
	pi.on("tool_execution_start", event => {
		if (event.parentToolCallId) parents.set(event.toolCallId, event.parentToolCallId);
	});
	pi.on("tool_execution_end", event => { parents.delete(event.toolCallId); });
	pi.on("session_shutdown", () => { parents.clear(); });

	function isTarget(toolCallId: string): boolean {
		let target = getManager()?.foregroundToolCallId();
		while (target) {
			if (target === toolCallId) return true;
			target = parents.get(target);
		}
		return false;
	}

	pi.registerToolRenderer((name, next) => {
		const original = next();
		const renderResult = original?.renderResult;
		if ((name !== "bash" && name !== "codemode") || !renderResult) return original;
		return {
			...original,
			renderResult(result, options, theme, context) {
				const previous = context.lastComponent;
				const body = renderResult(result, options, theme, {
					...context, lastComponent: previous instanceof BackgroundHint ? previous.body : previous,
				});
				const hint = theme.style("ctrl+b", { fg: "text", bold: true }) + theme.fg("muted", " send to background");
				return new BackgroundHint(body, () => options.isPartial && isTarget(context.toolCallId), hint);
			},
		};
	});
}
