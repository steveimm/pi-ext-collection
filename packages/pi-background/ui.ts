import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text } from "@earendil-works/pi-tui";
import type { BackgroundManager } from "./manager.js";

function activeTasks(manager: BackgroundManager) {
	return [
		...manager.listProcesses().filter(job => job.status === "running").map(job => ({ ...job, kind: "process" as const })),
		...manager.listWatchers().map(watcher => ({ ...watcher, kind: "watcher" as const })),
	];
}

function counts(tasks: ReturnType<typeof activeTasks>): string {
	const processes = tasks.filter(task => task.kind === "process").length;
	const watchers = tasks.length - processes;
	return `${processes} ${processes === 1 ? "process" : "processes"}, ${watchers} ${watchers === 1 ? "watcher" : "watchers"}`;
}

export function attachBackgroundStatus(manager: BackgroundManager, ctx: ExtensionContext): () => void {
	const update = () => {
		const tasks = activeTasks(manager);
		ctx.ui.setStatus("pi-background", tasks.length ? `BG: ${counts(tasks)} (/bg)` : undefined);
	};
	const unsubscribe = manager.subscribe(update);
	update();
	return () => {
		unsubscribe();
		ctx.ui.setStatus("pi-background", undefined);
	};
}

export async function showBackgroundTasks(manager: BackgroundManager, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/bg requires TUI mode.", "error");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		let tasks: ReturnType<typeof activeTasks> = [];
		let list: SelectList;
		let busy = false;
		let disposed = false;
		let message = "";
		const title = new Text("", 1, 1);
		const hint = new Text("", 1, 1);
		const feedback = new Text("", 1, 0);

		async function stop(id: string) {
			const task = tasks.find(task => task.id === id);
			if (!task || busy) return;
			busy = true;
			message = "Stopping...";
			refresh();
			try {
				if (task.kind === "process") await manager.stopProcess(task.id);
				else await manager.deleteWatcher(task.id);
				message = task.kind === "process" ? "Process stopped." : "Watcher stopped.";
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			} finally {
				busy = false;
				if (!disposed) refresh();
			}
		}

		function refresh() {
			const selected = list?.getSelectedItem()?.value;
			tasks = activeTasks(manager);
			title.setText(theme.fg("accent", `Background tasks: ${counts(tasks)}`));
			list = new SelectList(tasks.map(task => {
				const name = task.label || task.command || (task.kind === "watcher" ? task.instruction : "") || task.id;
				const kind = task.kind === "process" ? "Process" : `Watcher (${task.mode})`;
				return { value: task.id, label: `${kind}: ${name.replace(/\s+/g, " ")}` };
			}), 8, getSelectListTheme());
			list.setSelectedIndex(Math.max(0, tasks.findIndex(task => task.id === selected)));
			list.onSelect = item => { void stop(item.value); };
			const actions = tasks.length && !busy
				? `${keys.getKeys("tui.select.up").join("/")}/${keys.getKeys("tui.select.down").join("/")} select | ${keys.getKeys("tui.select.confirm").join("/")} stop selected task | `
				: "";
			hint.setText(theme.fg("dim", `${actions}${keys.getKeys("tui.select.cancel").join("/")} close`));
			feedback.setText(message);
			tui.requestRender();
		}

		refresh();
		const unsubscribe = manager.subscribe(refresh);
		return {
			capturesViewportInput: true,
			render(width: number) {
				return [
					...title.render(width),
					...(tasks.length ? list.render(width) : new Text("No active background tasks.", 1, 0).render(width)),
					...hint.render(width),
					...(message ? feedback.render(width) : []),
				];
			},
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) done();
				else if (!busy) list.handleInput(data);
				tui.requestRender();
			},
			invalidate() { title.invalidate(); list.invalidate(); hint.invalidate(); feedback.invalidate(); },
			dispose() { disposed = true; unsubscribe(); },
		};
	});
}
