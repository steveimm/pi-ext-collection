import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { backgroundUpdates, until } from "./helpers.mjs";

const packagePath = process.env.PI_BACKGROUND_TEST_PACKAGE ?? fileURLToPath(new URL("..", import.meta.url));
const changeDirPath = fileURLToPath(new URL("../../pi-change-dir", import.meta.url));
const providerPath = fileURLToPath(new URL("fixtures/provider.js", import.meta.url));
const cliPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");

async function start(t, settings = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-test-")));
	const cwd = join(root, "project");
	mkdirSync(cwd);
	mkdirSync(join(root, "other"));
	mkdirSync(join(root, "agent"));
	writeFileSync(join(root, "agent/settings.json"), JSON.stringify(settings));
	const client = new RpcClient({
		cliPath, cwd, provider: "background-test", model: "test",
		env: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		args: ["--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
			"-e", packagePath, "-e", providerPath, "-e", changeDirPath, "-e", "builtin:codemode", "--tools", "+codemode"],
	});
	const events = [];
	client.onEvent(event => events.push(event));
	t.after(async () => { await client.stop(); rmSync(root, { recursive: true, force: true }); });
	await client.start();
	await client.getState();
	async function execute(name, args, expectedError = false) {
		const id = randomUUID();
		for (;;) {
			await until(async () => !(await client.getState()).isStreaming);
			try {
				await client.prompt(`CALL ${JSON.stringify({ id, name, arguments: args })}`);
				break;
			} catch (error) {
				if (!error.message.includes("Agent is already processing")) throw error;
			}
		}
		await until(() => events.some(event => event.type === "tool_execution_end" && event.toolCallId === id));
		const end = events.find(event => event.type === "tool_execution_end" && event.toolCallId === id);
		await until(async () => !(await client.getState()).isStreaming);
		assert.equal(end.isError, expectedError, JSON.stringify(end.result));
		return end.result;
	}
	return {
		client, root, cwd, events, execute,
		updates: () => backgroundUpdates(events),
		async call(name, args) {
			return JSON.parse((await execute(name, args)).content[0].text);
		},
	};
}

test("completion starts a new turn after an unrelated conversation", { timeout: 20000 }, async t => {
	const { client, cwd, call, updates } = await start(t);
	const first = await call("background_process", {
		action: "start", command: "sleep 1; printf first", instruction: "Inspect the first result.",
	});
	const second = await call("background_process", { action: "start", command: "sleep 1.2; printf second; exit 3" });
	assert.equal((await client.getState()).isStreaming, false);
	await client.promptAndWait("An unrelated question.");
	await until(() => updates().some(event => event.id === first.id) && updates().some(event => event.id === second.id));
	await until(async () => !(await client.getState()).isStreaming);
	const messages = await client.getMessages();
	assert(messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("BACKGROUND_HANDLED")));
	const completed = updates().find(event => event.id === first.id);
	assert.equal(completed.cwd, cwd);
	assert.equal(completed.output, "first");
	assert.equal(completed.instruction, "Inspect the first result.");
	assert.equal(updates().find(event => event.id === second.id).exit_code, 3);
	assert.equal(updates().filter(event => event.id === first.id).length, 1);
});

test("delivery waits for a busy turn", { timeout: 20000 }, async t => {
	const { client, call, updates } = await start(t);
	await call("background_process", { action: "start", command: "sleep 0.3; printf done" });
	const busy = client.promptAndWait("BUSY");
	await sleep(600);
	assert.equal(updates().length, 0);
	await busy;
	await until(() => updates().length === 1);
});

test("jobs and watchers survive reload and cd with their original directory", { timeout: 20000 }, async t => {
	const { client, root, cwd, call, updates } = await start(t);
	const process = await call("background_process", { action: "start", command: "sleep 3; pwd" });
	const watcher = await call("background_watch", {
		action: "create", command: "test -f ready && cat ready", mode: "until_success", interval_seconds: 1,
	});
	const sessionId = (await client.getState()).sessionId;
	await client.prompt("/test-reload");
	assert((await call("background_process", { action: "list" })).some(job => job.id === process.id));
	await client.prompt(`/cd ${join(root, "other")}`);
	assert.equal((await client.getState()).sessionId, sessionId);
	assert((await call("background_watch", { action: "list" })).some(item => item.id === watcher.id));
	writeFileSync(join(cwd, "ready"), "original-directory");
	await until(() => updates().some(event => event.id === watcher.id) && updates().some(event => event.id === process.id));
	assert.equal(updates().find(event => event.id === process.id).output.trim(), cwd);
	assert.equal(updates().find(event => event.id === watcher.id).output, "original-directory");
	assert.equal((await call("background_watch", { action: "list" })).length, 0);
});

test("on-change watchers suppress unchanged results and can be deleted", { timeout: 20000 }, async t => {
	const { cwd, call, updates } = await start(t);
	writeFileSync(join(cwd, "progress"), "10");
	const watcher = await call("background_watch", {
		action: "create", command: "cat progress", mode: "on_change", interval_seconds: 1,
	});
	await until(async () => (await call("background_watch", { action: "list" }))[0]?.last_check);
	await sleep(1200);
	assert.equal(updates().length, 0);
	writeFileSync(join(cwd, "progress"), "20");
	await until(() => updates().some(event => event.id === watcher.id));
	assert.equal(updates()[0].output, "20");
	await call("background_watch", { action: "delete", id: watcher.id });
	writeFileSync(join(cwd, "progress"), "30");
	await sleep(1200);
	assert.equal(updates().length, 1);
});

test("changing sessions and quitting stop processes and watchers", { timeout: 20000 }, async t => {
	const { client, cwd, call, updates } = await start(t);
	await call("background_process", { action: "start", command: "sleep 2; echo leaked > process-leaked" });
	await call("background_watch", { action: "create", command: "sleep 2; echo leaked > watch-leaked", interval_seconds: 1 });
	await client.newSession();
	await sleep(2500);
	assert(!existsSync(join(cwd, "process-leaked")));
	assert(!existsSync(join(cwd, "watch-leaked")));
	assert.equal(updates().length, 0);
	assert.deepEqual(await call("background_process", { action: "list" }), []);
	await call("background_process", { action: "start", command: "sleep 2; echo leaked > quit-leaked" });
	await client.stop();
	await sleep(2200);
	assert(!existsSync(join(cwd, "quit-leaked")));
});

test("codemode can start parallel jobs alongside ordinary Bash and return before they finish", { timeout: 20000 }, async t => {
	const { execute, updates, call } = await start(t);
	const response = await execute("codemode", { code: `
const results = await Promise.allSettled([
  tools.background_process({action: "start", command: "sleep 2; printf first"}),
  tools.background_process({action: "start", command: "sleep 2; printf second"}),
  tools.bash({command: "sleep 0.2; printf foreground"})
]);
if (results.some(result => result.status !== "fulfilled")) throw new Error("A call failed");
const [first, second, foreground] = results.map(result => result.value);
if (!first.id || !second.id || foreground.output !== "foreground") throw new Error("Expected structured results");
const watcher = await tools.background_watch({action: "create", command: "exit 1", interval_seconds: 1});
const removed = await tools.background_watch({action: "delete", id: watcher.id});
if (!removed.deleted) throw new Error("Watcher was not deleted");
text("IDS:" + JSON.stringify([first.id, second.id]));
` });
	const text = response.content.map(item => item.text ?? "").join("\n");
	const ids = JSON.parse(text.match(/IDS:(\[[^\n]+\])/)[1]);
	assert.equal(updates().filter(event => ids.includes(event.id)).length, 0);
	await until(() => ids.every(id => updates().some(event => event.id === id)));
	assert.deepEqual(ids.map(id => updates().find(event => event.id === id).output), ["first", "second"]);
	assert.deepEqual(await call("background_watch", { action: "list" }), []);
});

test("a completed background start survives a later codemode error", { timeout: 20000 }, async t => {
	const { execute, updates } = await start(t);
	const response = await execute("codemode", { code: `
const job = await tools.background_process({action: "start", command: "sleep 1; printf survived"});
text("ID:" + job.id);
throw new Error("Intentional script failure");
` }, true);
	const text = response.content.map(item => item.text ?? "").join("\n");
	const id = text.match(/ID:(process-[a-f0-9-]+)/)[1];
	await until(() => updates().some(event => event.id === id));
	assert.equal(updates().find(event => event.id === id).output, "survived");
});

test("codemode can stop one process without affecting another", { timeout: 20000 }, async t => {
	const { execute, updates, call } = await start(t);
	const response = await execute("codemode", { code: `
const [first, second] = await Promise.all([
  tools.background_process({action: "start", command: "sleep 10; printf stopped"}),
  tools.background_process({action: "start", command: "sleep 1; printf completed"})
]);
const stopped = await tools.background_process({action: "stop", id: first.id});
if (stopped.status !== "stopped") throw new Error("Process was not stopped");
text("IDS:" + JSON.stringify([first.id, second.id]));
` });
	const text = response.content.map(item => item.text ?? "").join("\n");
	const [stopped, completed] = JSON.parse(text.match(/IDS:(\[[^\n]+\])/)[1]);
	await until(() => updates().some(event => event.id === completed));
	assert(!updates().some(event => event.id === stopped));
	assert.equal((await call("background_process", { action: "read", id: completed })).output, "completed");
});

test("codemode timeout stops ordinary Bash but preserves a completed background start", { timeout: 20000 }, async t => {
	const { cwd, execute, updates } = await start(t);
	const response = await execute("codemode", { code: `// @options: {"timeout_ms": 3000}
const job = await tools.background_process({action: "start", command: "sleep 4; printf survived-timeout"});
text("ID:" + job.id);
await tools.bash({command: "(sleep 4; echo leaked > timed-foreground) & wait"});
` }, true);
	const text = response.content.map(item => item.text ?? "").join("\n");
	const id = text.match(/ID:(process-[a-f0-9-]+)/)[1];
	await until(() => updates().some(event => event.id === id));
	await sleep(500);
	assert.equal(updates().find(event => event.id === id).output, "survived-timeout");
	assert(!existsSync(join(cwd, "timed-foreground")));
});

test("background commands and watcher checks use Pi's shell settings", { timeout: 20000 }, async t => {
	const { call, updates } = await start(t, {
		shellCommandPrefix: "export BG_TEST_PREFIX=ready", shellPath: `~/${relative(homedir(), "/bin/bash")}`,
	});
	const job = await call("background_process", { action: "start", command: 'printf "%s" "$BG_TEST_PREFIX"' });
	const watcher = await call("background_watch", { action: "create", command: 'test "$BG_TEST_PREFIX" = ready && printf watched' });
	await until(() => updates().some(event => event.id === job.id) && updates().some(event => event.id === watcher.id));
	assert.equal(updates().find(event => event.id === job.id).output, "ready");
	assert.equal(updates().find(event => event.id === watcher.id).output, "watched");
});
