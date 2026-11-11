import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const cliPath = process.env.PI_CHANGE_DIR_TEST_CLI ?? join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");

function assistant(text) {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
}

async function start(t, { history = true, persistent = true, trust = true, hooks = "", setup } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-change-dir-test-")));
	const a = join(root, "a");
	const b = join(root, "b space");
	for (const [directory, name, enabled] of [[a, "alpha", true], [b, "beta", false]]) {
		mkdirSync(join(directory, ".pi/extensions"), { recursive: true });
		mkdirSync(join(directory, ".pi/skills", name), { recursive: true });
		mkdirSync(join(directory, ".pi/prompts"), { recursive: true });
		writeFileSync(join(directory, "AGENTS.md"), `Unique instructions for project ${name}.`);
		writeFileSync(join(directory, ".pi/settings.json"), JSON.stringify({ compaction: { enabled } }));
		writeFileSync(join(directory, ".pi/extensions/project.ts"), `export default pi => pi.registerCommand("${name}", {handler: async () => {}});`);
		writeFileSync(join(directory, ".pi/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\nProject ${name} skill.`);
		writeFileSync(join(directory, ".pi/prompts", `${name}-prompt.md`), `Project ${name} prompt.`);
	}
	const probePath = join(root, "probe.ts");
	writeFileSync(probePath, `
import { rmSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("test-state", { handler: async (_, ctx) => ctx.ui.notify(JSON.stringify({
    cwd: ctx.cwd, prompt: ctx.getSystemPrompt(), trusted: ctx.isProjectTrusted(),
    leaf: ctx.sessionManager.getLeafId(), header: ctx.sessionManager.getHeader(),
    tools: pi.getAllTools().map(tool => tool.name)
  }), "info") });
  pi.registerCommand("test-branch", { handler: async (id, ctx) => { await ctx.navigateTree(id, {summarize: false}); } });
  ${hooks}
}
`);
	await setup?.({ root, a, b });
	let firstReply;
	let lastReply;
	const source = SessionManager.create(a, join(root, "source-sessions"));
	if (history) {
		source.appendMessage({ role: "user", content: "Remember the first turn.", timestamp: Date.now() });
		firstReply = source.appendMessage(assistant("First answer."));
		source.appendMessage({ role: "user", content: "This belongs to the later branch.", timestamp: Date.now() });
		lastReply = source.appendMessage(assistant("Later answer."));
		source.appendSessionInfo("Directory test");
	}
	const client = new RpcClient({
		cliPath, cwd: a,
		env: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		args: ["--offline", trust ? "--approve" : "--no-approve", ...(persistent ? ["--session", source.getSessionFile()] : ["--no-session"]), "-e", extensionPath, "-e", probePath],
	});
	const events = [];
	client.onEvent(event => events.push(event));
	t.after(async () => {
		await client.stop();
		rmSync(root, { recursive: true, force: true });
	});
	await client.start();
	await client.getState();
	return {
		client, root, a, b, source, firstReply, lastReply, events,
		async probe() {
			await client.prompt("/test-state");
			const event = events.findLast(item => item.type === "extension_ui_request" && item.message?.startsWith("{"));
			return JSON.parse(event.message);
		},
	};
}

test("moves a branched conversation and reloads project resources and tool cwd", { timeout: 20000 }, async t => {
	const { client, a, b, source, firstReply, lastReply, probe } = await start(t);
	await client.prompt(`/test-branch ${firstReply}`);
	const before = await client.getState();
	const entriesBefore = (await client.getEntries()).entries;
	await client.prompt('/cd "../b space"');
	const after = await client.getState();
	const state = await probe();
	assert.equal(state.cwd, b);
	assert.equal(after.sessionId, before.sessionId);
	assert.equal(after.sessionName, "Directory test");
	assert.equal(state.header.timestamp, source.getHeader().timestamp);
	assert.equal(existsSync(before.sessionFile), false);
	assert(existsSync(after.sessionFile));
	const entriesAfter = (await client.getEntries()).entries;
	for (const entry of entriesBefore) assert.deepEqual(entriesAfter.find(item => item.id === entry.id), entry);
	const marker = entriesAfter.findLast(item => item.type === "custom" && item.customType === "pi-change-dir");
	assert.equal(marker.parentId, firstReply);
	assert(entriesAfter.some(entry => entry.id === lastReply));
	const messages = JSON.stringify(await client.getMessages());
	assert(messages.includes("Remember the first turn."));
	assert(!messages.includes("This belongs to the later branch."));
	assert(state.prompt.includes("Unique instructions for project beta."));
	assert(!state.prompt.includes("Unique instructions for project alpha."));
	assert.equal(after.autoCompactionEnabled, false);
	const commands = (await client.getCommands()).map(command => command.name);
	for (const name of ["beta", "skill:beta", "beta-prompt", "cd"]) assert(commands.includes(name), name);
	for (const name of ["alpha", "skill:alpha", "alpha-prompt"]) assert(!commands.includes(name), name);
	assert.equal((await client.bash("pwd")).output.trim(), b);
	const listed = await SessionManager.list(b, dirname(after.sessionFile));
	assert(listed.some(session => session.id === after.sessionId));
	assert.equal((await SessionManager.list(a, dirname(before.sessionFile))).length, 0);
	await client.prompt(`/cd '${a}'`);
	assert.equal((await probe()).cwd, a);
	assert.equal(existsSync(after.sessionFile), false);
});

test("invalid, inaccessible, and equivalent paths leave the session intact", { timeout: 20000 }, async t => {
	const { client, root, a, probe, events } = await start(t);
	const original = (await client.getState()).sessionFile;
	const content = readFileSync(original, "utf8");
	writeFileSync(join(a, "file"), "not a directory");
	symlinkSync(a, join(root, "alias"), "dir");
	symlinkSync(join(root, "missing"), join(a, "broken"), "dir");
	for (const argument of ["missing", "file", "file/child", "broken", '"unfinished', '""', "\0", ".", "../alias", ""]) {
		await client.prompt(`/cd ${argument}`);
		assert.equal((await client.getState()).sessionFile, original, argument);
		assert.equal(readFileSync(original, "utf8"), content, argument);
		assert.equal((await probe()).cwd, a, argument);
	}
	assert(events.some(event => event.message?.includes("does not exist")));
	assert(events.some(event => event.message?.includes("Not a directory")));
	assert(events.some(event => event.message?.includes("Close the quote")));
	assert(events.some(event => event.message?.includes("Already in")));
	const locked = join(root, "locked");
	mkdirSync(locked);
	chmodSync(locked, 0);
	try {
		await client.prompt(`/cd ${locked}`);
		assert.equal((await client.getState()).sessionFile, original);
		assert(events.some(event => event.message?.includes("Permission denied")));
	} finally {
		chmodSync(locked, 0o700);
	}
});

test("expands home paths and rejects destination collisions without overwriting", { timeout: 20000 }, async t => {
	const { client, a, b, probe, events } = await start(t);
	await client.prompt(`/cd ~/${relative(homedir(), b)}`);
	const destination = (await client.getState()).sessionFile;
	assert.equal((await probe()).cwd, b);
	await client.prompt(`/cd ${a}`);
	const original = (await client.getState()).sessionFile;
	const sentinel = "Existing transcript must survive.";
	writeFileSync(destination, sentinel);
	await client.prompt(`/cd ${b}`);
	assert.equal((await client.getState()).sessionFile, original);
	assert.equal(readFileSync(destination, "utf8"), sentinel);
	assert(events.some(event => event.message?.includes("not overwritten")));
});

test("a cancelled switch removes the new file and preserves the original", { timeout: 20000 }, async t => {
	const { client, b, probe, events } = await start(t, {
		hooks: `pi.on("session_before_switch", () => ({cancel: true}));`,
	});
	const original = (await client.getState()).sessionFile;
	const content = readFileSync(original, "utf8");
	await client.prompt(`/cd ${b}`);
	assert.equal((await client.getState()).sessionFile, original);
	assert.equal(readFileSync(original, "utf8"), content);
	assert.notEqual((await probe()).cwd, b);
	assert(events.some(event => event.message === "Directory change cancelled."));
	const sessionsRoot = join(dirname(dirname(original)), "agent/sessions");
	for (const folder of readdirSync(sessionsRoot)) assert.deepEqual(readdirSync(join(sessionsRoot, folder)), []);
});

test("supports a new unsaved session and refuses in-memory sessions", { timeout: 20000 }, async t => {
	const fresh = await start(t, { history: false });
	const before = await fresh.client.getState();
	assert.equal(existsSync(before.sessionFile), false);
	await fresh.client.prompt(`/cd ${fresh.b}`);
	const after = await fresh.client.getState();
	assert.equal(after.sessionId, before.sessionId);
	assert(existsSync(after.sessionFile));
	assert.equal((await fresh.probe()).cwd, fresh.b);
	const memory = await start(t, { persistent: false });
	await memory.client.prompt(`/cd ${memory.b}`);
	assert.equal((await memory.client.getState()).sessionFile, undefined);
	assert.equal((await memory.probe()).cwd, memory.a);
	assert(memory.events.some(event => event.message?.includes("requires a persistent session")));
});

test("respects Pi's trust override at the destination", { timeout: 20000 }, async t => {
	const { client, b, probe } = await start(t, { trust: false });
	await client.prompt(`/cd ${b}`);
	const state = await probe();
	assert.equal(state.cwd, b);
	assert.equal(state.trusted, false);
	const commands = (await client.getCommands()).map(command => command.name);
	assert(!commands.includes("beta"));
});

test("keeps outgoing shutdown writes instead of deleting them", { timeout: 20000 }, async t => {
	const { client, b, events } = await start(t, {
		hooks: `pi.on("session_shutdown", event => { if (event.reason === "resume") pi.appendEntry("shutdown-note", {saved: true}); });`,
	});
	const original = (await client.getState()).sessionFile;
	await client.prompt(`/cd ${b}`);
	assert.notEqual((await client.getState()).sessionFile, original);
	assert(readFileSync(original, "utf8").includes('"customType":"shutdown-note"'));
	assert(events.some(event => event.message?.includes("old transcript changed")));
});

test("rejects a second directory change while the first is running", { timeout: 20000 }, async t => {
	const { client, root, b, probe, events } = await start(t, {
		hooks: `pi.on("session_before_switch", async () => { await new Promise(resolve => setTimeout(resolve, 100)); });`,
	});
	const c = join(root, "c");
	mkdirSync(c);
	await Promise.all([client.prompt(`/cd ${b}`), client.prompt(`/cd ${c}`)]);
	assert.equal((await probe()).cwd, b);
	assert(events.some(event => event.message?.includes("Wait for the current operation")));
});

test("can leave a deleted current directory", { timeout: 20000 }, async t => {
	const { client, a, b, probe } = await start(t);
	rmSync(a, { recursive: true });
	await client.prompt(`/cd ${b}`);
	assert.equal((await probe()).cwd, b);
	assert.equal((await client.bash("pwd")).output.trim(), b);
});

test("retains the original transcript if the destination disappears during the switch", { timeout: 20000 }, async t => {
	const { client, a, b, source, probe, events } = await start(t, {
		hooks: `pi.on("session_before_switch", (_, ctx) => rmSync(ctx.cwd + "/../b space", {recursive: true}));`,
	});
	const original = (await client.getState()).sessionFile;
	const content = readFileSync(original, "utf8");
	await client.prompt(`/cd ${b}`);
	assert.equal((await probe()).cwd, a);
	assert.equal(readFileSync(original, "utf8"), content);
	assert(events.some(event => event.type === "extension_error" && event.error.includes("Cannot finish changing directory")));
	assert.equal((await client.getState()).sessionId, source.getSessionId());
});

test("replaces project MCP connections", {
	timeout: 30000,
	skip: !existsSync(join(dirname(cliPath), "extensions/mcp/index.js")),
}, async t => {
	const serverPath = fileURLToPath(new URL("fixtures/mcp-server.mjs", import.meta.url));
	const { client, root, a, b, probe, events: rpcEvents } = await start(t, {
		setup: ({ root, a, b }) => {
			for (const [directory, name] of [[a, "alpha"], [b, "beta"]]) {
				writeFileSync(join(directory, ".pi/mcp.json"), JSON.stringify({
					mcpServers: { [name]: { command: process.execPath, args: [serverPath, name, join(root, "mcp.jsonl")], exposure: "direct" } },
				}));
			}
		},
	});
	async function waitForTool(name) {
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			const state = await probe();
			if (state.tools.includes(name)) return state;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		const errors = rpcEvents.filter(event => event.type === "extension_error" || event.notifyType === "error");
		assert.fail(`${name} did not become available: ${JSON.stringify(errors)}`);
	}
	await waitForTool("mcp__alpha__probe");
	await client.prompt(`/cd ${b}`);
	const state = await waitForTool("mcp__beta__probe");
	assert(!state.tools.includes("mcp__alpha__probe"));
	const events = readFileSync(join(root, "mcp.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert(events.some(event => event.name === "alpha" && event.event === "start" && event.cwd === a));
	assert(events.some(event => event.name === "alpha" && event.event === "stop"));
	assert(events.some(event => event.name === "beta" && event.event === "start" && event.cwd === b));
});
