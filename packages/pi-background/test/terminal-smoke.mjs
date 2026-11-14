import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assertKeyHints, until } from "./helpers.mjs";

const packagePath = process.env.PI_BACKGROUND_TEST_PACKAGE ?? fileURLToPath(new URL("..", import.meta.url));
const providerPath = fileURLToPath(new URL("fixtures/provider.js", import.meta.url));
const backgroundHint = "ctrl+b send to background";
const cliPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");

function quote(value) {
	return `'${value.replace(/'/g, `'\''`)}'`;
}

async function run(mode) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-terminal-")));
	const socket = `pi-background-${randomUUID()}`;
	let started = false;

	function tmux(...args) {
		const result = spawnSync("tmux", ["-f", "/dev/null", "-L", socket, ...args], { encoding: "utf8", timeout: 5000 });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout;
	}

	function keys(...values) { tmux("send-keys", "-t", "test", ...values); }
	function screen(ansi = false) { return tmux("capture-pane", "-t", "test", "-p", ...(ansi ? ["-e"] : [])); }
	function statusRow(ansi = false) {
		return screen(ansi).split("\n").findLast(line => {
			const text = stripTerminalSequences(line).trimEnd();
			return /\d+ background process(?:es)?, \d+ watchers?/.test(text) && text.endsWith("test");
		});
	}
	function focused() { return /\x1b\[(?:\d+;)*7(?:;\d+)*m/.test(statusRow(true) ?? ""); }
	async function expectScreen(text) { await until(() => screen().includes(text)); }
	async function expectFocus(value) { await until(() => focused() === value); }
	function editorText() {
		const lines = screen().split("\n");
		const borders = lines.flatMap((line, index) => /^─{3}/.test(line) ? [index] : []);
		return lines.slice(borders.at(-2) + 1, borders.at(-1)).join("\n").trim();
	}
	function entries() {
		const directory = join(root, "sessions");
		if (!existsSync(directory)) return [];
		const file = readdirSync(directory).find(file => file.endsWith(".jsonl"));
		return file ? readFileSync(join(directory, file), "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line)) : [];
	}
	function toolResult(id) {
		return entries().find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === id)?.message;
	}
	function updates() {
		return entries().filter(entry => entry.type === "custom_message" && entry.customType === "pi-background")
			.flatMap(entry => entry.details.events);
	}
	function sendCall(id, name, args) {
		keys("-l", `CALL ${JSON.stringify({ id, name, arguments: args })}`);
		keys("Enter");
	}
	async function result(id) {
		await until(() => {
			const history = entries();
			const index = history.findIndex(entry => entry.message?.toolCallId === id);
			return index !== -1 && history.slice(index + 1).some(entry => entry.message?.role === "assistant"
				&& entry.message.content.some(part => part.text === "REPLY_DONE"));
		});
		const response = toolResult(id);
		assert.equal(response.isError, false, JSON.stringify(response));
		return response.content.map(part => part.text ?? "").join("\n");
	}
	async function prompt(text) {
		const before = entries().length;
		keys("-l", text);
		keys("Enter");
		await until(() => entries().slice(before).some(entry => entry.message?.role === "assistant"
			&& entry.message.content.some(part => part.text === "REPLY_DONE")));
	}

	try {
		const command = ["env", `PI_CODING_AGENT_DIR=${join(root, "agent")}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
			process.execPath, cliPath, "--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
			"--provider", "background-test", "--model", "test", "--session-dir", join(root, "sessions"),
			"--tui-mode", mode, "-e", packagePath, "-e", providerPath, "-e", "builtin:codemode", "--tools", "+codemode"].map(quote).join(" ");
		tmux("new-session", "-d", "-s", "test", "-x", "110", "-y", "35", "-c", root, "sleep 600");
		started = true;
		tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
		tmux("respawn-pane", "-k", "-t", "test", "-c", root, `exec ${command}`);
		await expectScreen("0.0%/128k");
		sendCall("keyboard-task", "bash", { command: "touch started; while [ ! -f release ]; do sleep 0.1; done; printf completed" });
		await until(() => existsSync(join(root, "started")));
		assert.equal(statusRow(), undefined, "Foreground commands must not be counted as background work.");
		await until(() => screen().split("\n").some(line => /Elapsed [\d.]+s/.test(line) && line.includes(backgroundHint)));
		tmux("resize-window", "-t", "test", "-x", "32", "-y", "35");
		await until(() => /Elapsed [\d.]+s[^\n]*\n[^\n]*ctrl\+b send to background/.test(screen()));
		tmux("resize-window", "-t", "test", "-x", "110", "-y", "35");
		await until(() => screen().split("\n").some(line => /Elapsed [\d.]+s/.test(line) && line.includes(backgroundHint)));
		keys("C-b");
		const text = await result("keyboard-task");
		assert(!screen().includes(backgroundHint));
		assert.match(text, /The user moved this command to the background/);
		const id = text.match(/process-[a-f0-9-]+/)[0];
		sendCall("keyboard-followup", "bash", { command: "printf usable > still-chatting" });
		await result("keyboard-followup");
		assert(existsSync(join(root, "still-chatting")));
		writeFileSync(join(root, "release"), "");
		await until(() => updates().some(event => event.id === id && event.event === "completed"));
		await expectScreen("BACKGROUND_HANDLED");
		console.log(`${mode}: Ctrl+B releases Bash and completion starts a follow-up turn.`);

		sendCall("keyboard-codemode", "codemode", { code: `
const [moved, sibling] = await Promise.all([
  tools.bash({command: "touch code-start; while [ ! -f code-release ]; do sleep 0.1; done; printf code-finished"}),
  tools.bg_process({action: "start", command: "while [ ! -f sibling-release ]; do sleep 0.1; done; printf sibling-finished"})
]);
if (!moved.background || moved.backgrounded_by !== "user" || moved.exit_code !== null) throw new Error("Expected a user background result");
text("MOVED:" + moved.id);
text("SIBLING:" + sibling.id);
` });
		await until(() => existsSync(join(root, "code-start")));
		await until(() => screen().split("\n").some(line => /Elapsed [\d.]+s/.test(line) && line.includes(backgroundHint)));
		keys("C-b");
		const codeText = await result("keyboard-codemode");
		assert(!screen().includes(backgroundHint));
		const ids = [codeText.match(/MOVED:(process-[a-f0-9-]+)/)[1], codeText.match(/SIBLING:(process-[a-f0-9-]+)/)[1]];
		assert.notEqual(ids[0], ids[1]);
		writeFileSync(join(root, "code-release"), "");
		writeFileSync(join(root, "sibling-release"), "");
		await until(() => ids.every(id => updates().some(event => event.id === id && event.event === "completed")));
		await until(() => statusRow() === undefined);
		console.log(`${mode}: Ctrl+B works inside codemode alongside an independent background process.`);

		sendCall("parallel-hints", "codemode", { code: `
const first = tools.bash({command: "touch parallel-a; while [ ! -f parallel-release ]; do sleep 0.1; done"});
const second = tools.bash({command: "touch parallel-b; while [ ! -f parallel-release ]; do sleep 0.1; done"});
const movedSecond = await second;
if (!movedSecond.background) throw new Error("Second command must be backgrounded first");
text("SECOND:" + movedSecond.id);
const movedFirst = await first;
if (!movedFirst.background) throw new Error("First command must also be backgrounded");
text("FIRST:" + movedFirst.id);
` });
		await until(() => existsSync(join(root, "parallel-a")) && existsSync(join(root, "parallel-b")));
		await expectScreen(backgroundHint);
		assert.equal(screen().split(backgroundHint).length - 1, 1);
		keys("C-b");
		await until(() => statusRow()?.includes("1 background process"));
		assert(screen().includes(backgroundHint));
		assert.equal(toolResult("parallel-hints"), undefined);
		keys("C-b");
		const parallelText = await result("parallel-hints");
		assert.match(parallelText, /SECOND:process-/);
		assert.match(parallelText, /FIRST:process-/);
		assert(!screen().includes(backgroundHint));
		writeFileSync(join(root, "parallel-release"), "");
		await until(() => statusRow() === undefined);
		console.log(`${mode}: elapsed-time hints wrap, follow parallel commands, and disappear after backgrounding.`);

		sendCall("ui-worker", "bg_process", {
			action: "start", label: "Worker", command: "echo $$ > worker.pid; sleep 600 & echo $! > child.pid; wait",
		});
		await result("ui-worker");
		sendCall("ui-reminder", "bg_watch", {
			action: "create", mode: "interval", interval_seconds: 3600, instruction: "Check progress.", label: "Reminder",
		});
		await result("ui-reminder");
		const label = "1 background process, 1 watcher";
		await until(() => statusRow()?.includes(label));
		assert.equal(statusRow().indexOf(label), Math.floor((110 - label.length) / 2));
		assert(statusRow().includes("/128k"));
		assert(!statusRow().includes("BG:"));
		await prompt("history-example");
		keys("Up");
		await until(() => editorText() === "history-example");
		keys("Down");
		await until(() => editorText() === "");
		assert(!focused());
		keys("Down");
		await expectFocus(true);
		keys("Up");
		await expectFocus(false);
		assert.equal(editorText(), "");
		keys("-l", "draft preserved");
		keys("Down");
		await expectFocus(true);
		keys("Enter");
		await expectScreen("x kill selected task | esc close");
		const hint = screen(true).split("\n").find(line => stripTerminalSequences(line).includes("x kill selected task | esc close"));
		assertKeyHints(hint, ["up/down", "enter", "x", "esc"]);
		keys("Escape");
		await until(() => editorText() === "draft preserved");
		keys("C-u");
		keys("-l", "/b");
		await expectScreen("List and stop background processes and watchers");
		keys("Down", "Down", "Down");
		await sleep(75);
		assert(!focused(), "Down must stay in an open autocomplete menu.");
		keys("Escape");
		await until(() => !screen().includes("List and stop background processes and watchers"));
		keys("C-u");
		await until(() => editorText() === "");
		keys("-l", "\x1b[200~first line\nsecond line\x1b[201~");
		keys("Home", "Up", "Down");
		await sleep(75);
		assert(!focused(), "Moving between input lines must not focus the indicator.");
		keys("End", "Down");
		await expectFocus(true);
		keys("Escape");
		await expectFocus(false);
		keys("C-u", "BSpace", "C-u");
		await until(() => editorText() === "");
		keys("-l", "/test-reload");
		keys("Enter");
		await expectScreen("Reloaded keybindings");
		await until(() => statusRow()?.includes(label));
		keys("Down", "Enter");
		await expectScreen("x kill selected task | esc close");
		keys("Escape");
		await until(() => !screen().includes("esc close"));
		tmux("resize-window", "-t", "test", "-x", "45", "-y", "35");
		await until(() => statusRow()?.includes(label) && statusRow().length <= 45);
		tmux("resize-window", "-t", "test", "-x", "110", "-y", "35");
		await until(() => statusRow()?.length === 110);
		keys("-l", "/bg");
		keys("Enter");
		await expectScreen("x kill selected task | esc close");
		keys("Enter");
		await expectScreen("Status: running");
		await expectScreen("Command: echo $$");
		await expectScreen("esc back");
		assert(statusRow().includes(label), "Enter must open details without stopping a task.");
		keys("Escape");
		await expectScreen("x kill selected task | esc close");
		keys("Down");
		await expectScreen("→ Watcher (interval): Reminder");
		keys("Enter");
		await expectScreen("Mode: interval");
		await expectScreen("Instruction: Check progress.");
		keys("Escape");
		await expectScreen("→ Watcher (interval): Reminder");
		keys("Up", "Enter");
		await expectScreen("Status: running");
		keys("x");
		await expectScreen("Process stopped.");
		await expectScreen("Status: stopped");
		await until(() => statusRow()?.includes("0 background processes, 1 watcher"));
		for (const file of ["worker.pid", "child.pid"]) {
			const pid = Number(readFileSync(join(root, file), "utf8"));
			await until(() => {
				try { process.kill(pid, 0); return false; }
				catch (error) { assert.equal(error.code, "ESRCH"); return true; }
			});
		}
		keys("Escape");
		await expectScreen("→ Watcher (interval): Reminder");
		keys("Enter");
		await expectScreen("Mode: interval");
		keys("x");
		await expectScreen("Status: inactive");
		keys("Escape");
		await expectScreen("No active background tasks.");
		await until(() => statusRow() === undefined);
		keys("Escape");
		await until(() => !screen().includes("esc close"));

		sendCall("ui-completion", "bg_process", { action: "start", command: "while [ ! -f ui-release ]; do sleep 0.1; done" });
		await result("ui-completion");
		keys("Down");
		await expectFocus(true);
		writeFileSync(join(root, "ui-release"), "");
		await until(() => statusRow() === undefined);
		await prompt("after-completion");
		assert(!screen().includes("esc close"));
		console.log(`${mode}: centered counts, history, drafts, autocomplete, reload, details, x/esc, and completion focus passed.`);
		keys("-l", "/quit");
		keys("Enter");
		await until(() => tmux("display-message", "-p", "-t", "test", "#{pane_dead}").trim() === "1");
	} catch (error) {
		if (started) console.error(tmux("capture-pane", "-t", "test", "-p", "-S", "-100"));
		throw error;
	} finally {
		if (started) spawnSync("tmux", ["-L", socket, "kill-server"]);
		rmSync(root, { recursive: true, force: true });
	}
}

for (const mode of ["regular", "fullscreen"]) await run(mode);
