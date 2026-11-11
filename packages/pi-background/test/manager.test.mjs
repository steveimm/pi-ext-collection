import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createLocalBashOperations, SessionManager } from "@earendil-works/pi-coding-agent";
import { BackgroundManager, resolveDirectory } from "../manager.ts";
import { createManagedBash } from "../foreground.ts";
import { until } from "./helpers.mjs";

function setup(t) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-background-manager-"));
	const manager = new BackgroundManager(join(cwd, "logs"));
	const operations = createLocalBashOperations();
	const events = [];
	manager.attach({ isIdle: () => true, send: batch => events.push(...batch) });
	t.after(async () => { await manager.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	return { cwd, manager, operations, events };
}

test("large output is bounded while the last output remains readable", async t => {
	const { cwd, manager, operations, events } = setup(t);
	const job = manager.start({ command: `node -e 'process.stdout.write("x".repeat(11 * 1024 * 1024) + "END")'`, cwd }, operations);
	await until(() => events.some(event => event.id === job.id));
	const result = manager.readProcess(job.id);
	assert.equal(result.exit_code, 0);
	assert.equal(statSync(result.log_path).size, 10 * 1024 * 1024);
	assert.equal(result.log_truncated, true);
	assert(Buffer.byteLength(result.output) <= 16 * 1024);
	assert(result.output.endsWith("END"));
	assert(events[0].output.length <= 2000);
});

test("stop cancels child processes and supports concurrent stop calls", async t => {
	const { cwd, manager, operations, events } = setup(t);
	const job = manager.start({ command: "(sleep 1; echo leaked > leaked) & wait", cwd }, operations);
	await sleep(100);
	const results = await Promise.all([manager.stopProcess(job.id), manager.stopProcess(job.id)]);
	assert(results.every(result => result.status === "stopped" && result.finished_at));
	await sleep(1100);
	assert(!existsSync(join(cwd, "leaked")));
	assert.equal(events.length, 0);
});

test("failed launches and process timeouts notify once", async t => {
	const { cwd, manager, operations, events } = setup(t);
	assert.throws(() => resolveDirectory("missing", cwd), /ENOENT/);
	writeFileSync(join(cwd, "file"), "file");
	assert.throws(() => resolveDirectory("file", cwd), /Not a directory/);
	const missing = manager.start({ command: "printf never", cwd: join(cwd, "missing") }, operations);
	const timeout = manager.start({ command: "sleep 10", cwd, timeoutSeconds: 1 }, operations);
	await until(() => events.length === 2);
	assert(events.every(event => event.event === "failed"));
	assert.match(events.find(event => event.id === missing.id).error, /does not exist/);
	assert.match(events.find(event => event.id === timeout.id).error, /Timed out/);
});

test("watcher timeouts are reported once and recovery is reported as a change", async t => {
	const { cwd, manager, operations, events } = setup(t);
	const watcher = manager.watch({ command: "if test -f ready; then printf ready; else sleep 5; fi", cwd,
		mode: "on_change", intervalSeconds: 1, timeoutSeconds: 1 }, operations);
	await until(() => events.length === 1);
	assert.equal(events[0].event, "check_failed");
	await sleep(2200);
	assert.equal(events.length, 1);
	writeFileSync(join(cwd, "ready"), "");
	await until(() => events.length === 2);
	assert.equal(events[1].event, "changed");
	assert.equal(events[1].output, "ready");
	await manager.deleteWatcher(watcher.id);
});

test("pending notifications attach to the new context and deliver all completed jobs", async t => {
	const { cwd, manager, operations, events } = setup(t);
	manager.detach();
	const jobs = Array.from({ length: 12 }, (_, i) => manager.start({ command: `printf ${i}`, cwd }, operations));
	await until(() => manager.listProcesses().every(job => job.status === "completed"));
	assert.equal(events.length, 0);
	manager.attach({ isIdle: () => true, send: batch => events.push(...batch) });
	await until(() => events.length === 12);
	assert.equal(new Set(events.map(event => event.id)).size, 12);
	jobs.forEach((job, i) => assert.equal(manager.readProcess(job.id).output, String(i)));
});

test("foreground Bash retains normal output, errors, prefix, and session environment", async t => {
	const { cwd, manager, events } = setup(t);
	const sessionManager = SessionManager.inMemory(cwd);
	const ctx = { cwd, sessionManager, model: undefined };
	const tool = createManagedBash(() => manager, () => ({ commandPrefix: "export TEST_PREFIX=prefix" }));
	const result = await tool.execute("normal", { command: 'printf "%s:%s" "$TEST_PREFIX" "$PI_SESSION_ID"' }, undefined, undefined, ctx);
	assert.equal(result.structuredContent.output, `prefix:${sessionManager.getSessionId()}`);
	assert.equal(result.structuredContent.exit_code, 0);
	const failed = await tool.execute("failed", { command: "printf failed; exit 7" }, undefined, undefined, ctx);
	assert.equal(failed.isError, true);
	assert.equal(failed.structuredContent.exit_code, 7);
	assert.equal(events.length, 0);
	assert.deepEqual(manager.listProcesses(), []);
	assert.deepEqual(readdirSync(join(cwd, "logs")), []);
});

test("backgrounding foreground Bash releases the call and detaches its abort signal", async t => {
	const { cwd, manager, events } = setup(t);
	const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd), model: undefined };
	const tool = createManagedBash(() => manager, () => ({}));
	const signal = new AbortController();
	const updates = [];
	const result = tool.execute("foreground", {
		command: "printf before; touch started; while [ ! -f release ]; do sleep 0.1; done; printf after",
	}, signal.signal, update => updates.push(update), ctx);
	await until(() => existsSync(join(cwd, "started")));
	const id = manager.backgroundLatest();
	assert(id);
	const handoff = await result;
	assert.equal(handoff.structuredContent.background, true);
	assert.equal(handoff.structuredContent.exit_code, null);
	assert.equal(handoff.structuredContent.id, id);
	signal.abort();
	writeFileSync(join(cwd, "release"), "");
	await until(() => events.some(event => event.id === id));
	assert.equal(events[0].event, "completed");
	assert.equal(events[0].output, "beforeafter");
	assert(!JSON.stringify(updates).includes("after"));
	assert.equal(readFileSync(manager.readProcess(id).log_path, "utf8"), "beforeafter");
});
