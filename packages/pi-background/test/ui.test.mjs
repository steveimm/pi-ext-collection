import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { BackgroundManager } from "../manager.ts";
import { showBackgroundTasks } from "../ui.ts";
import { assertKeyHints, until } from "./helpers.mjs";

const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
initTheme("dark");

function setup(t) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-background-ui-"));
	const manager = new BackgroundManager(join(cwd, "logs"));
	t.after(async () => { await manager.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	return { cwd, manager };
}

function processJob(manager, cwd, output = "working") {
	let finish;
	let signal;
	const job = manager.start({ command: "run-the-build", cwd, label: "Build" }, {
		exec(_command, _cwd, options) {
			signal = options.signal;
			options.onData(Buffer.from(output));
			return new Promise(resolve => {
				finish = exitCode => resolve({ exitCode });
				signal.addEventListener("abort", () => finish(null), { once: true });
			});
		},
	});
	return { job, finish: code => finish(code), signal };
}

function open(t, manager) {
	let component;
	let closed = false;
	let close;
	const finished = showBackgroundTasks(manager, { mode: "tui", ui: {
		custom(factory) {
			return new Promise(resolve => {
				close = () => { closed = true; component.dispose(); resolve(); };
				component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, getKeybindings(), close);
			});
		},
	} });
	t.after(() => { if (!closed) close(); });
	return {
		finished, isClosed: () => closed,
		press: data => component.handleInput(data),
		lines: (width = 100) => component.render(width),
		text: (width = 100) => component.render(width).map(stripTerminalSequences).join("\n"),
	};
}

test("Enter opens process and watcher details, and esc returns to the selected list item before closing", async t => {
	const { manager, cwd } = setup(t);
	processJob(manager, cwd);
	manager.watch({ mode: "interval", cwd, label: "Reminder", intervalSeconds: 3600, instruction: "Check progress." }, {
		async exec() { throw new Error("A reminder must not run a command."); },
	});
	const ui = open(t, manager);
	assertKeyHints(ui.lines().find(line => stripTerminalSequences(line).includes("esc close")), ["up/down", "enter", "x", "esc"]);
	ui.press("\r");
	assert.match(ui.text(), /Status: running/);
	assert.match(ui.text(), /Command: run-the-build/);
	assert(ui.text().includes(cwd));
	assert.match(ui.text(), /Recent output\s+working/);
	assert.match(ui.text(), /esc back/);
	assert(!ui.isClosed());
	ui.press("\x1b");
	assert.match(ui.text(), /→ Process: Build/);
	assert(!ui.isClosed());
	ui.press("\x1b[B");
	ui.press("\r");
	assert.match(ui.text(), /Mode: interval/);
	assert.match(ui.text(), /Interval: 3600s/);
	assert.match(ui.text(), /Instruction: Check progress\./);
	ui.press("\x1b");
	assert.match(ui.text(), /→ Watcher \(interval\): Reminder/);
	assert(!ui.isClosed());
	ui.press("\x1b");
	await ui.finished;
	assert(ui.isClosed());
});

test("x stops a process from its detail view without closing it", async t => {
	const { manager, cwd } = setup(t);
	const { signal } = processJob(manager, cwd);
	const ui = open(t, manager);
	ui.press("\r");
	assert(!signal.aborted, "Opening details must not kill the task.");
	ui.press("x");
	await until(() => ui.text().includes("Process stopped."));
	assert(signal.aborted);
	assert.match(ui.text(), /Status: stopped/);
	assert.doesNotMatch(ui.text(), /x kill selected task/);
	assert(!ui.isClosed());
	ui.press("\x1b");
	assert.match(ui.text(), /No active background tasks\./);
	assert(!ui.isClosed());
	ui.press("\x1b");
	await ui.finished;
});

test("details retain a completed process and allow long output to be scrolled", async t => {
	const { manager, cwd } = setup(t);
	const { finish } = processJob(manager, cwd, Array.from({ length: 60 }, (_, index) => `output line ${index}`).join("\n"));
	const ui = open(t, manager);
	ui.press("\r");
	finish(7);
	await until(() => ui.text().includes("Status: failed"));
	assert.match(ui.text(), /Exit code: 7/);
	assert(ui.lines().length <= 25, "Details must leave room for Pi's status row.");
	for (let page = 0; page < 10 && !ui.text().includes("output line 59"); page++) ui.press("\x1b[6~");
	assert.match(ui.text(), /output line 59/);
	ui.press("\x1b[5~");
	assert.doesNotMatch(ui.text(), /output line 59/);
	ui.press("\x1b");
	assert.match(ui.text(), /No active background tasks\./);
});

test("a watcher removed while details are open becomes inactive and esc still returns to the list", async t => {
	const { manager, cwd } = setup(t);
	const watcher = manager.watch({ mode: "interval", cwd, intervalSeconds: 3600, instruction: "Check progress." }, {
		async exec() { throw new Error("A reminder must not run a command."); },
	});
	const ui = open(t, manager);
	ui.press("\r");
	await manager.deleteWatcher(watcher.id);
	assert.match(ui.text(), /Status: inactive/);
	assert.doesNotMatch(ui.text(), /x kill selected task/);
	ui.press("\x1b");
	assert.match(ui.text(), /No active background tasks\./);
	assert(!ui.isClosed());
	ui.press("\x1b");
	await ui.finished;
});
