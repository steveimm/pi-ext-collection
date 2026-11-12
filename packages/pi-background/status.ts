import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { BackgroundManager } from "./manager.js";
import { activeTasks, counts, showBackgroundTasks } from "./ui.js";

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
	const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, _theme, keys) => {
		if (!("getFocusedComponent" in tui) || typeof tui.getFocusedComponent !== "function") {
			throw new Error("Cannot access Pi's editor for background task navigation.");
		}
		const editor = tui.getFocusedComponent() as CustomEditor | null;
		const footer = findFooter(tui.children);
		if (!editor || typeof editor.getCursor !== "function" || typeof editor.isShowingAutocomplete !== "function" || !footer) {
			throw new Error("Background task navigation requires Pi's standard editor and footer.");
		}
		let tasks = activeTasks(manager);
		let footerDisposed = false;
		let dialogOpen = false;
		const originalInput = editor.handleInput;
		const unsubscribe = manager.subscribe(() => {
			tasks = activeTasks(manager);
			if (!tasks.length && status.focused) tui.setFocus(input);
			tui.requestRender();
		});
		// Render Pi's existing footer to preserve its token, model, and session information.
		const status = {
			focused: false,
			render(width: number) {
				const lines = footer.render(width);
				if (tasks.length && lines[1] !== undefined) {
					const processes = tasks.filter(task => task.kind === "process").length;
					const label = width >= 80 ? `BG: ${counts(tasks)}` : `BG ${processes}p ${tasks.length - processes}w`;
					const text = ctx.ui.theme.fg("accent", truncateToWidth(label, width));
					lines[1] = centerStatus(lines[1], this.focused ? ctx.ui.theme.inverse(text) : text, width);
				}
				return lines;
			},
			handleInput(data: string) {
				if (keys.matches(data, "tui.editor.cursorDown")) return;
				tui.setFocus(input);
				if (keys.matches(data, "tui.input.submit")) {
					dialogOpen = true;
					void showBackgroundTasks(manager, ctx).catch(error => {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}).finally(() => { dialogOpen = false; tui.requestRender(); });
				} else if (!keys.matches(data, "tui.editor.cursorUp") && !keys.matches(data, "tui.select.cancel")) {
					input.handleInput(data);
				}
				tui.requestRender();
			},
			invalidate() { footer.invalidate(); },
			dispose() {
				footerDisposed = true;
				unsubscribe();
				if (this.focused) tui.setFocus(input);
			},
		};
		const handleInput = (data: string) => {
			if (dialogOpen && !footerDisposed) return;
			if (footerDisposed || !tasks.length || !keys.matches(data, "tui.editor.cursorDown") || editor.isShowingAutocomplete()) {
				originalInput.call(editor, data);
				return;
			}
			const before = editor.getCursor();
			const text = editor.getText();
			const onChange = editor.onChange;
			let changed = false;
			editor.onChange = value => { changed = true; onChange?.(value); };
			try {
				originalInput.call(editor, data);
			} finally {
				if (onChange) editor.onChange = onChange;
				else delete editor.onChange;
			}
			const after = editor.getCursor();
			if (!changed && text === editor.getText() && before.line === after.line && before.col === after.col) {
				tui.setFocus(status);
				tui.requestRender();
			}
		};
		const input = {
			get focused() { return editor.focused; },
			set focused(value: boolean) { editor.focused = value; },
			get capturesViewportInput() { return editor.capturesViewportInput; },
			get borderColor() { return editor.borderColor; },
			set borderColor(value: typeof editor.borderColor) { editor.borderColor = value; },
			get embedWorkingStatus() { return editor.embedWorkingStatus; },
			setWorkingStatusIndicator: editor.setWorkingStatusIndicator?.bind(editor),
			render: editor.render.bind(editor), invalidate: editor.invalidate.bind(editor), handleInput,
			handleMouse: editor.handleMouse.bind(editor),
			getText: editor.getText.bind(editor), setText: editor.setText.bind(editor),
			getExpandedText: editor.getExpandedText.bind(editor), addToHistory: editor.addToHistory.bind(editor),
			insertTextAtCursor: editor.insertTextAtCursor.bind(editor),
			setAutocompleteProvider: editor.setAutocompleteProvider.bind(editor),
			setPaddingX: editor.setPaddingX.bind(editor), setAutocompleteMaxVisible: editor.setAutocompleteMaxVisible.bind(editor),
		};
		// Forward editor callbacks without triggering CustomEditor's app-handler rewiring.
		for (const key of ["onSubmit", "onChange"] as const) {
			Object.defineProperty(input, key, {
				get: () => editor[key],
				set: (value: (text: string) => void) => { editor[key] = value; },
			});
		}
		ctx.ui.setFooter(() => status);
		cleanup = () => {
			unsubscribe();
			if (!footerDisposed) ctx.ui.setFooter(undefined);
		};
		return input;
	};
	// /reload focuses a loading panel before session_start runs.
	ctx.ui.setEditorComponent(previousFactory);
	ctx.ui.setEditorComponent(factory);
	return () => {
		cleanup();
		if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previousFactory);
	};
}
