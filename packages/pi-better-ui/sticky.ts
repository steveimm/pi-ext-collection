import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { isViewportTUI, ScrollView, stripTerminalSequences, truncateToWidth, visibleWidth, VStack, type Component, type TUI } from "@earendil-works/pi-tui";

export type PromptRange = { start: number; end: number; text: string };

export function findPrompts(lines: readonly string[]): PromptRange[] {
	const prompts: PromptRange[] = [];
	let current: PromptRange | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.includes("\x1b]133;A")) {
			current = { start: index, end: lines.length, text: "" };
			prompts.push(current);
		}
		if (!current) continue;
		if (current.text.length < 512) {
			const text = stripTerminalSequences(line).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
			current.text = `${current.text} ${text}`.trim().slice(0, 512);
		}
		if (line.includes("\x1b]133;B")) {
			current.end = index + 1;
			current.text = current.text.replace(/\s+/gu, " ");
			current = undefined;
		}
	}
	return prompts;
}

export function promptAbove(prompts: readonly PromptRange[], scrollTop: number): string | undefined {
	let selected: string | undefined;
	for (const prompt of prompts) {
		if (prompt.start > scrollTop) break;
		if (prompt.end > scrollTop) return undefined;
		selected = prompt.text || "[attachments]";
	}
	return selected;
}

function layoutRoot(tui: TUI): Component | undefined {
	if (!isViewportTUI(tui) || !("layoutRoot" in tui)) return;
	const root = tui.layoutRoot;
	return root && typeof root === "object" && "render" in root && typeof root.render === "function" ? root as Component : undefined;
}

function findTranscript(component: Component): ScrollView | undefined {
	if (component instanceof ScrollView && component.primary) return component;
	if (!("children" in component) || !Array.isArray(component.children)) return;
	for (const child of component.children as Component[]) {
		const scroll = findTranscript(child);
		if (scroll) return scroll;
	}
}

export function attachStickyPrompt(tui: TUI, originalRoot: Component, scroll: ScrollView, theme: () => Theme) {
	const document = scroll.children[0];
	if (!document) throw new Error("Pi's transcript viewport has no document.");
	const originalRender = document.render;
	const originalLayout = scroll.updateLayout;
	let prefetched: { width: number; lines: string[] } | undefined;
	let prompts: PromptRange[] = [];
	let width = 0;
	let shown: string | undefined;
	let disposed = false;

	function selected(top: number): string | undefined {
		return width >= 16 && tui.terminal.rows >= 6 && scroll.viewportHeight > 0 ? promptAbove(prompts, top) : undefined;
	}

	const header: Component = {
		render(columns) {
			if (disposed) return [];
			width = columns;
			const contentWidth = scroll.getContentWidth(columns);
			const lines = originalRender.call(document, contentWidth);
			prefetched = { width: contentWidth, lines };
			prompts = findPrompts(lines);
			const top = scroll.isFollowingEnd ? Math.max(0, lines.length - scroll.viewportHeight) : scroll.scrollTop;
			shown = selected(top);
			if (shown === undefined) return [];
			const text = truncateToWidth(` › ${shown}`, columns, "…");
			return [theme().bg("userMessageBg", theme().fg("userMessageText", text + " ".repeat(Math.max(0, columns - visibleWidth(text)))))];
		},
		invalidate() { prefetched = undefined; },
	};
	const renderDocument = (columns: number) => {
		if (prefetched?.width !== columns) return originalRender.call(document, columns);
		const lines = prefetched.lines;
		prefetched = undefined;
		return lines;
	};
	const updateLayout: ScrollView["updateLayout"] = (contentHeight, viewportHeight, requestRender) => {
		originalLayout.call(scroll, contentHeight, viewportHeight, requestRender);
		if (!disposed && selected(scroll.scrollTop) !== shown) requestRender();
	};
	const root = new VStack([
		{ component: header, basis: "auto", grow: 0, shrink: 0, maxSize: 1 },
		{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	document.render = renderDocument;
	scroll.updateLayout = updateLayout;
	if (isViewportTUI(tui)) tui.setLayoutRoot(root);
	return {
		root,
		dispose() {
			if (disposed) return;
			disposed = true;
			prefetched = undefined;
			prompts = [];
			if (document.render === renderDocument) document.render = originalRender;
			if (scroll.updateLayout === updateLayout) scroll.updateLayout = originalLayout;
			if (isViewportTUI(tui) && layoutRoot(tui) === root) tui.setLayoutRoot(originalRoot);
		},
	};
}

export function registerStickyPrompt(pi: ExtensionAPI): void {
	let cleanup: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("pi-better-ui/viewport", (tui) => {
			let attached: ReturnType<typeof attachStickyPrompt> | undefined;
			const dispose = () => { attached?.dispose(); attached = undefined; };
			cleanup = dispose;
			return {
				render() {
					const root = layoutRoot(tui);
					if (root !== attached?.root) {
						dispose();
						if (root) {
							const scroll = findTranscript(root);
							if (scroll) attached = attachStickyPrompt(tui, root, scroll, () => ctx.ui.theme);
						}
					}
					return [];
				},
				invalidate() {},
				dispose,
			};
		}, { placement: "belowEditor" });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cleanup?.();
		cleanup = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget("pi-better-ui/viewport", undefined);
	});
}
