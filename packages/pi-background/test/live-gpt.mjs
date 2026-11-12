import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { backgroundUpdates, until } from "./helpers.mjs";

const provider = process.env.PI_BACKGROUND_TEST_PROVIDER ?? "openai-codex";
const model = process.env.PI_BACKGROUND_TEST_MODEL ?? "gpt-6.1-sol";
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-gpt-")));
const packagePath = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const client = new RpcClient({
	cliPath, cwd: root, provider, model,
	env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
	args: ["--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
		"--no-prompt-templates", "--no-themes", "--thinking", "low", "--session-dir", join(root, "sessions"),
		"--tools", "bg_process,bg_watch,read,write,codemode", "-e", packagePath, "-e", "builtin:codemode"],
});
const events = [];
client.onEvent(event => events.push(event));

try {
	await client.start();
	const prompt = `This is a background-tool integration test in a temporary directory.
Use codemode to start two bg_process commands in parallel with Promise.allSettled, and create one bg_watch.
Process A command: while [ ! -f release ]; do sleep 0.2; done; printf alpha > job-a.txt; printf alpha
Process A instruction: After completion, read job-a.txt and use write to create observed-a.txt containing exactly alpha.
Process B command: while [ ! -f release ]; do sleep 0.2; done; printf beta > job-b.txt; printf beta
Process B instruction: After completion, read job-b.txt and use write to create observed-b.txt containing exactly beta.
Watcher command: test -f watch-ready
Watcher mode: until_success. Interval: 1 second.
Watcher instruction: When matched, use write to create observed-watch.txt containing exactly WATCHED.
The test runner creates release and watch-ready later. Do not create those files yourself.
Await the start/create calls to get their IDs, then let codemode finish and reply LAUNCHED.
Do not wait for completion or poll the tasks. Act on completion notifications when they arrive.`;
	await client.promptAndWait(prompt, undefined, 120000);
	const started = events.filter(event => event.type === "tool_execution_end" && event.toolName === "bg_process")
		.map(event => event.result?.structuredContent).filter(result => result?.status === "running");
	assert.equal(started.length, 2, "GPT did not start both background processes.");
	const sessionFile = (await client.getState()).sessionFile;
	assert(started.every(job => dirname(job.log_path) === `${sessionFile}.bg`));
	assert(!events.some(event => event.type === "message_end" && event.message?.customType === "pi-background"));
	console.log(`${provider}/${model}: launched two processes and a watcher, then finished its reply.`);

	const answer = await client.promptAndWait("While those tasks wait, what is 2+2? Reply only 4 and leave the tasks running.", undefined, 120000);
	assert(answer.some(event => event.type === "message_end" && event.message?.role === "assistant"
		&& event.message.content.some(part => part.type === "text" && part.text.trim() === "4")));
	console.log("GPT answered another user message while the background processes were running.");
	for (const file of ["observed-a.txt", "observed-b.txt", "observed-watch.txt"]) assert(!existsSync(join(root, file)));

	writeFileSync(join(root, "release"), "ready");
	writeFileSync(join(root, "watch-ready"), "ready");
	await until(() => ["observed-a.txt", "observed-b.txt", "observed-watch.txt"].every(file => existsSync(join(root, file))), 120000);
	await until(async () => !(await client.getState()).isStreaming, 120000);
	assert.equal(readFileSync(join(root, "observed-a.txt"), "utf8"), "alpha");
	assert.equal(readFileSync(join(root, "observed-b.txt"), "utf8"), "beta");
	assert.equal(readFileSync(join(root, "observed-watch.txt"), "utf8"), "WATCHED");
	const updates = backgroundUpdates(events);
	assert.equal(updates.filter(event => event.kind === "process" && event.event === "completed").length, 2);
	assert.equal(updates.filter(event => event.kind === "watcher" && event.event === "matched").length, 1);
	const firstNotification = events.findIndex(event => event.type === "message_end" && event.message?.customType === "pi-background");
	const followUpCalls = events.slice(firstNotification + 1).filter(event => event.type === "tool_execution_start");
	for (const file of ["job-a.txt", "job-b.txt"]) {
		assert(followUpCalls.some(event => event.toolName === "read" && basename(event.args.path) === file));
	}
	for (const file of ["observed-a.txt", "observed-b.txt", "observed-watch.txt"]) {
		assert(followUpCalls.some(event => event.toolName === "write" && basename(event.args.path) === file));
	}
	console.log("PASS: completion notifications caused GPT to read both results and write all three follow-up files without another user prompt.");
} finally {
	await client.stop();
	rmSync(root, { recursive: true, force: true });
}
