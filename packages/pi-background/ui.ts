import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, replaceControlCharacters, SelectList, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { BackgroundManager } from "./manager.js";

export function activeTasks(manager: BackgroundManager) {
	return [
		...manager.listProcesses().filter(job => job.status === "running").map(job => ({ ...job, kind: "process" as const })),
		...manager.listWatchers().map(watcher => ({ ...watcher, kind: "watcher" as const })),
	];
}

export function counts(tasks: ReturnType<typeof activeTasks>): string {
	const processes = tasks.filter(task => task.kind === "process").length;
	const watchers = tasks.length - processes;
	return `${processes} background ${processes === 1 ? "process" : "processes"}, ${watchers} ${watchers === 1 ? "watcher" : "watchers"}`;
}

export async function showBackgroundTasks(manager: BackgroundManager, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/bg requires TUI mode.", "error");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		let tasks: ReturnType<typeof activeTasks> = [];
		let detail: (typeof tasks)[number] | undefined;
		let detailOffset = 0;
		let detailHeight = 1;
		let list: SelectList;
		let busy = false;
		let disposed = false;
		let message = "";
		const title = new Text("", 1, 1);
		const hint = new Text("", 1, 1);
		const feedback = new Text("", 1, 0);
		const detailBody = new Text("", 1, 0);
		const keyHint = (key: string, action: string) => theme.style(key, { fg: "text", bold: true }) + theme.fg("dim", ` ${action}`);
		const plain = (value: unknown) => stripTerminalSequences(String(value)).split("\n").map(replaceControlCharacters).join("\n");

		function detailText(task: NonNullable<typeof detail>): string {
			let fields: [string, unknown][];
			let output: string;
			if (task.kind === "process") {
				const job = manager.readProcess(task.id);
				fields = [
					["Status", job.status], ["Command", job.command], ["Directory", job.cwd],
					["Started", job.started_at], ["Finished", job.finished_at], ["Exit code", job.exit_code],
					["Error", job.error], ["Log", job.log_path],
				];
				output = job.output;
			} else {
				const watcher = manager.listWatchers().find(watcher => watcher.id === task.id);
				const latest = watcher ?? task;
				fields = [
					["Status", watcher ? "active" : "inactive"], ["Mode", latest.mode],
					["Interval", `${latest.interval_seconds}s`], ["Command", latest.command],
					["Instruction", latest.instruction], ["Directory", latest.cwd],
					["Last check", latest.last_check], ["Last exit code", latest.last_exit_code],
					["Error", latest.last_error], ["Log", latest.log_path],
				];
				output = latest.output;
			}
			fields.push(["ID", task.id]);
			return fields.filter(([, value]) => value !== undefined && value !== null)
				.map(([label, value]) => theme.fg("muted", `${label}: `) + plain(value)).join("\n")
				+ `\n\n${theme.bold("Recent output")}\n${output ? plain(output) : "(no output)"}`;
		}

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
			if (detail) detail = tasks.find(task => task.id === detail?.id) ?? detail;
			const heading = detail ? `${detail.kind === "process" ? "Process" : "Watcher"}: ${detail.label || detail.id}` : counts(tasks);
			title.setText(theme.fg("accent", replaceControlCharacters(plain(heading))));
			list = new SelectList(tasks.map(task => {
				const name = task.label || task.command || (task.kind === "watcher" ? task.instruction : "") || task.id;
				const kind = task.kind === "process" ? "Process" : `Watcher (${task.mode})`;
				return { value: task.id, label: `${kind}: ${name.replace(/\s+/g, " ")}` };
			}), 8, getSelectListTheme());
			list.setSelectedIndex(Math.max(0, tasks.findIndex(task => task.id === selected)));
			list.onSelect = item => {
				detail = tasks.find(task => task.id === item.value);
				detailOffset = 0;
				message = "";
				refresh();
			};
			const actions = [];
			if (!busy && (detail || tasks.length)) {
				const navigation = `${keys.getKeys("tui.select.up").join("/")}/${keys.getKeys("tui.select.down").join("/")}`;
				actions.push(keyHint(navigation, detail ? "scroll" : "select"));
				if (!detail) actions.push(keyHint(keys.getKeys("tui.select.confirm").join("/"), "details"));
				if (!detail || tasks.some(task => task.id === detail?.id)) actions.push(keyHint("x", "kill selected task"));
			}
			actions.push(keyHint("esc", detail ? "back" : "close"));
			hint.setText(actions.join(theme.fg("dim", " | ")));
			feedback.setText(message);
			tui.requestRender();
		}

		refresh();
		const unsubscribe = manager.subscribe(refresh);
		return {
			capturesViewportInput: true,
			render(width: number) {
				const heading = title.render(width);
				const hints = hint.render(width);
				const messages = message ? feedback.render(width) : [];
				let body: string[];
				if (detail) {
					detailBody.setText(detailText(detail));
					const lines = detailBody.render(width);
					detailHeight = Math.max(1, Math.min(20, tui.terminal.rows - heading.length - hints.length - messages.length - 6));
					detailOffset = Math.max(0, Math.min(detailOffset, lines.length - detailHeight));
					body = lines.slice(detailOffset, detailOffset + detailHeight);
					if (lines.length > detailHeight) body.push(theme.fg("dim", ` ${detailOffset + 1}-${detailOffset + body.length}/${lines.length}`));
				} else {
					body = tasks.length ? list.render(width) : new Text("No active background tasks.", 1, 0).render(width);
				}
				return [...heading, ...body, ...hints, ...messages];
			},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) {
					if (!detail) done();
					else { detail = undefined; message = ""; refresh(); }
				} else if (!busy && matchesKey(data, "x")) {
					const id = detail?.id ?? list.getSelectedItem()?.value;
					if (id) void stop(id);
				} else if (detail) {
					if (keys.matches(data, "tui.select.up")) detailOffset--;
					else if (keys.matches(data, "tui.select.down")) detailOffset++;
					else if (keys.matches(data, "tui.select.pageUp")) detailOffset -= detailHeight;
					else if (keys.matches(data, "tui.select.pageDown")) detailOffset += detailHeight;
				} else if (!busy) list.handleInput(data);
				tui.requestRender();
			},
			invalidate() { title.invalidate(); list.invalidate(); hint.invalidate(); feedback.invalidate(); detailBody.invalidate(); },
			dispose() { disposed = true; unsubscribe(); },
		};
	});
}
