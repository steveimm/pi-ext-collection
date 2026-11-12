import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type Editor } from "@earendil-works/pi-tui";
import type { BackgroundManager } from "./manager.js";
import { activeTasks, counts } from "./ui.js";

function findFooter(components: Component[]): Component | undefined {
	for (const component of components) {
		if ("setAutoCompactEnabled" in component && typeof component.setAutoCompactEnabled === "function") return component;
		if ("children" in component && Array.isArray(component.children)) {
			const footer = findFooter(component.children);
			if (footer) return footer;
		}
	}
	return undefined;
}

function centerStatus(line: string, status: string, width: number): string {
	const text = stripTerminalSequences(line);
	const gap = / {2,}/.exec(text);
	const leftWidth = gap ? visibleWidth(text.slice(0, gap.index)) : visibleWidth(text);
	const rightStart = gap ? leftWidth + gap[0].length : width;
	const statusWidth = visibleWidth(status);
	const start = Math.max(0, Math.floor((width - statusWidth) / 2));
	const end = start + statusWidth;
	const left = truncateToWidth(sliceByColumn(line, 0, leftWidth), Math.max(0, start - 1));
	const right = truncateToWidth(sliceByColumn(line, rightStart, width - rightStart), Math.max(0, width - end - 1));
	return left + " ".repeat(Math.max(0, start - visibleWidth(left))) + status
		+ " ".repeat(Math.max(0, width - end - visibleWidth(right))) + right;
}

export function attachBackgroundStatus(manager: BackgroundManager, ctx: ExtensionContext): () => void {
	const previousFactory = ctx.ui.getEditorComponent();
	let cleanup = () => {};
	const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui) => {
		if (!("getFocusedComponent" in tui) || typeof tui.getFocusedComponent !== "function") {
			throw new Error("Cannot access Pi's editor for background task navigation.");
		}
		const editor = tui.getFocusedComponent() as Editor | null;
		const footer = findFooter(tui.children);
		if (!editor || typeof editor.getCursor !== "function" || !footer) {
			throw new Error("Background task navigation requires Pi's standard editor and footer.");
		}
		let tasks = activeTasks(manager);
		let footerDisposed = false;
		const unsubscribe = manager.subscribe(() => {
			tasks = activeTasks(manager);
			tui.requestRender();
		});
		// Render Pi's existing footer to preserve its token, model, and session information.
		ctx.ui.setFooter(() => ({
			render(width) {
				const lines = footer.render(width);
				if (tasks.length && lines[1] !== undefined) {
					const processes = tasks.filter(task => task.kind === "process").length;
					const label = width >= 80 ? `BG: ${counts(tasks)}` : `BG ${processes}p ${tasks.length - processes}w`;
					lines[1] = centerStatus(lines[1], ctx.ui.theme.fg("accent", truncateToWidth(label, width)), width);
				}
				return lines;
			},
			invalidate() { footer.invalidate(); },
			dispose() { footerDisposed = true; unsubscribe(); },
		}));
		cleanup = () => {
			unsubscribe();
			if (!footerDisposed) ctx.ui.setFooter(undefined);
		};
		return editor;
	};
	ctx.ui.setEditorComponent(factory);
	return () => {
		cleanup();
		if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previousFactory);
	};
}
