import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { until } from "./helpers.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-terminal-")));
const socket = `pi-background-${randomUUID()}`;
const packagePath = fileURLToPath(new URL("..", import.meta.url));
const providerPath = fileURLToPath(new URL("fixtures/provider.js", import.meta.url));
const cliPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");

function tmux(...args) {
	const result = spawnSync("tmux", ["-f", "/dev/null", "-L", socket, ...args], { encoding: "utf8", timeout: 5000 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

function quote(value) {
	return `'${value.replace(/'/g, `'\''`)}'`;
}

function entries() {
	const directory = join(root, "sessions");
	if (!existsSync(directory)) return [];
	const file = readdirSync(directory).find(file => file.endsWith(".jsonl"));
	return file ? readFileSync(join(directory, file), "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line)) : [];
}

function sendCall(id, name, args) {
	tmux("send-keys", "-t", "test", "-l", `CALL ${JSON.stringify({ id, name, arguments: args })}`);
	tmux("send-keys", "-t", "test", "Enter");
}

function toolResult(id) {
	return entries().find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === id)?.message;
}

let started = false;
try {
	const command = ["env", `PI_CODING_AGENT_DIR=${join(root, "agent")}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
		process.execPath, cliPath, "--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
		"--provider", "background-test", "--model", "test", "--session-dir", join(root, "sessions"),
		"--tui-mode", "regular", "-e", packagePath, "-e", providerPath, "-e", "builtin:codemode", "--tools", "+codemode"].map(quote).join(" ");
	tmux("new-session", "-d", "-s", "test", "-x", "100", "-y", "30", "-c", root, "sleep 600");
	started = true;
	tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
	tmux("respawn-pane", "-k", "-t", "test", "-c", root, `exec ${command}`);
	await sleep(1500);
	sendCall("keyboard-task", "bash", { command: "touch started; while [ ! -f release ]; do sleep 0.1; done; printf completed" });
	await until(() => existsSync(join(root, "started")));
	tmux("send-keys", "-t", "test", "C-b");
	await until(() => toolResult("keyboard-task"));
	const result = toolResult("keyboard-task");
	assert.equal(result.isError, false);
	const text = result.content.map(part => part.text ?? "").join("\n");
	assert(text.includes("running in the background"), text);
	const id = text.match(/process-[a-f0-9-]+/)[0];
	sendCall("keyboard-followup", "bash", { command: "printf usable > still-chatting" });
	await until(() => existsSync(join(root, "still-chatting")));
	writeFileSync(join(root, "release"), "");
	await until(() => entries().some(entry => entry.type === "custom_message" && entry.customType === "pi-background"
		&& entry.details.events.some(event => event.id === id && event.event === "completed")));
	await until(() => entries().some(entry => entry.message?.role === "assistant"
		&& entry.message.content.some(part => part.text === "BACKGROUND_HANDLED")));
	console.log("PASS: Ctrl+B released a running Bash command, another user command ran, and completion started a follow-up turn.");

	sendCall("keyboard-codemode", "codemode", { code: `
const [moved, sibling] = await Promise.all([
  tools.bash({command: "touch code-start; while [ ! -f code-release ]; do sleep 0.1; done; printf code-finished"}),
  tools.background_process({action: "start", command: "while [ ! -f sibling-release ]; do sleep 0.1; done; printf sibling-finished"})
]);
if (!moved.background || moved.exit_code !== null) throw new Error("Expected a background result");
text("MOVED:" + moved.id);
text("SIBLING:" + sibling.id);
` });
	await until(() => existsSync(join(root, "code-start")));
	tmux("send-keys", "-t", "test", "C-b");
	await until(() => toolResult("keyboard-codemode"));
	const codeResult = toolResult("keyboard-codemode");
	assert.equal(codeResult.isError, false, JSON.stringify(codeResult));
	const codeText = codeResult.content.map(part => part.text ?? "").join("\n");
	const ids = [codeText.match(/MOVED:(process-[a-f0-9-]+)/)[1], codeText.match(/SIBLING:(process-[a-f0-9-]+)/)[1]];
	assert.notEqual(ids[0], ids[1]);
	writeFileSync(join(root, "code-release"), "");
	writeFileSync(join(root, "sibling-release"), "");
	await until(() => ids.every(id => entries().some(entry => entry.type === "custom_message" && entry.customType === "pi-background"
		&& entry.details.events.some(event => event.id === id && event.event === "completed"))));
	console.log("PASS: Ctrl+B released a Bash call inside codemode, and both that process and a parallel background process completed afterward.");
} catch (error) {
	if (started) {
		const capture = spawnSync("tmux", ["-L", socket, "capture-pane", "-t", "test", "-p", "-S", "-100"], { encoding: "utf8" });
		console.error(capture.stdout || capture.stderr);
	}
	throw error;
} finally {
	if (started) spawnSync("tmux", ["-L", socket, "kill-server"]);
	rmSync(root, { recursive: true, force: true });
}
