import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundManager } from "../manager.ts";
import { registerBackgroundHint } from "../hint.ts";

const moduleUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const { theme } = await import(new URL("./modes/interactive/theme/theme.js", moduleUrl));
const { codemodeRenderers } = await import(new URL("./extensions/codemode/renderer.js", moduleUrl));
initTheme("dark");
const hint = "ctrl+b send to background";

function setup(t) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-background-hint-"));
	const manager = new BackgroundManager(join(cwd, "logs"));
	const events = new Map();
	const rows = [];
	let resolver;
	registerBackgroundHint({
		on: (name, handler) => { events.set(name, handler); },
		registerToolRenderer: value => { resolver = value; },
	}, () => manager);
	const unsubscribe = manager.subscribe(() => { for (const row of rows) row.invalidate(); });
	t.after(async () => {
		await manager.dispose();
		unsubscribe();
		for (const row of rows) row.updateResult({ content: [], details: undefined });
		rmSync(cwd, { recursive: true, force: true });
	});

	function row(id, name = "bash") {
		const original = name === "bash" ? createBashToolDefinition(cwd) : codemodeRenderers;
		const component = new ToolExecutionComponent(name, id, name === "bash" ? { command: "build" } : { code: "await tools.bash(...)" },
			{}, { ...original, ...resolver(name, () => original) }, { requestRender() {} }, cwd);
		rows.push(component);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "build output" }], details: {} }, true);
		return {
			component,
			lines: (width = 100) => component.render(width),
			text: (width = 100) => component.render(width).map(stripTerminalSequences).join("\n"),
		};
	}

	function start(id, parentToolCallId) {
		events.get("tool_execution_start")({ toolCallId: id, parentToolCallId });
		let finish;
		const running = manager.startForeground({ command: "build", cwd }, {
			exec(_command, _cwd, { signal }) {
				return new Promise(resolve => {
					finish = () => resolve({ exitCode: 0 });
					signal.addEventListener("abort", finish, { once: true });
				});
			},
		}, () => {}, id);
		const completed = running.completed.catch(() => {});
		return { id: running.id, finish: async () => { finish(); await completed; } };
	}
	return { manager, row, start, events };
}

test("the shortcut follows the latest foreground command through completion and backgrounding", async t => {
	const { manager, row, start } = setup(t);
	const firstRow = row("first");
	assert(!firstRow.text().includes(hint));
	start("first");
	assert.match(firstRow.text(), /Elapsed [\d.]+s · ctrl\+b send to background/);
	assert.match(firstRow.text(), /build output/);
	assert(firstRow.lines().some(line => line.includes(theme.style("ctrl+b", { fg: "text", bold: true }))));
	const secondRow = row("second");
	const second = start("second");
	assert(!firstRow.text().includes(hint));
	assert(secondRow.text().includes(hint));
	await second.finish();
	assert(!secondRow.text().includes(hint));
	assert(firstRow.text().includes(hint));
	secondRow.component.updateResult({ content: [], details: {} });
	assert.match(secondRow.text(), /Took/);
	assert(!secondRow.text().includes(hint));
	manager.backgroundLatest();
	assert(!firstRow.text().includes(hint));
	assert(!secondRow.text().includes(hint));
});

test("the hint wraps below elapsed time on narrow terminals without changing the native output", t => {
	const { row, start } = setup(t);
	const view = row("narrow");
	start("narrow");
	const narrow = view.lines(32);
	assert(narrow.every(line => visibleWidth(line) <= 32));
	assert.match(view.text(32), /Elapsed [\d.]+s[^\n]*\n[^\n]*ctrl\+b send to background/);
	assert.match(view.text(), /Elapsed [\d.]+s · ctrl\+b send to background/);
	view.component.invalidate();
	assert.equal(view.text().split(hint).length - 1, 1);
	assert.match(view.text(), /build output/);
});

test("codemode hints follow the parent of the eligible nested command and clear on cancellation and shutdown", async t => {
	const { manager, row, start, events } = setup(t);
	const firstScript = row("script-a", "codemode");
	const secondScript = row("script-b", "codemode");
	start("nested-a", "script-a");
	assert(firstScript.text().includes(hint));
	const second = start("nested-b", "script-b");
	assert(!firstScript.text().includes(hint));
	assert(secondScript.text().includes(hint));
	await manager.stopProcess(second.id);
	assert(!secondScript.text().includes(hint));
	assert(firstScript.text().includes(hint));
	start("nested-a2", "script-a");
	manager.backgroundLatest();
	assert(firstScript.text().includes(hint));
	events.get("session_shutdown")();
	assert(!firstScript.text().includes(hint));
});
