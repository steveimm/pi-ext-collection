import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
