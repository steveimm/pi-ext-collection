import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assertKeyHints, until } from "../../../test/helpers.mjs";
import { messageText } from "./helpers.mjs";

const packagePath = process.env.PI_QUEUE_MESSAGE_TEST_PACKAGE ?? fileURLToPath(new URL("..", import.meta.url));
const backgroundPath = fileURLToPath(new URL("../../pi-background", import.meta.url));
const providerSource = fileURLToPath(new URL("fixtures/provider.js", import.meta.url));
const cliPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const toggleHint = "tab toggle steering or follow up";

function quote(value) { return `'${value.replace(/'/g, `'\''`)}'`; }

async function run(mode, order, withImage = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-queue-terminal-")));
	const providerPath = join(root, "fixture/provider.js");
	// Load outside the package so Pi uses its bundled SDK aliases.
	mkdirSync(join(root, "fixture"));
	copyFileSync(providerSource, providerPath);
	copyFileSync(new URL("helpers.mjs", import.meta.url), join(root, "helpers.mjs"));
	const socket = `pi-queue-${randomUUID()}`;
	const editKey = withImage ? "M-q" : "M-Up";
	let started = false;
	if (withImage) {
		mkdirSync(join(root, "agent"));
		writeFileSync(join(root, "agent/keybindings.json"), JSON.stringify({ "app.message.dequeue": "alt+q" }));
	}

	function tmux(...args) {
		const result = spawnSync("tmux", ["-f", "/dev/null", "-L", socket, ...args], { encoding: "utf8", timeout: 5000 });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout;
	}
	function keys(...args) { tmux("send-keys", "-t", "verify", ...args); }
	function screen(ansi = false) { return tmux("capture-pane", "-t", "verify", "-p", ...(ansi ? ["-e"] : [])); }
	function entries() {
		const directory = join(root, "sessions");
		if (!existsSync(directory)) return [];
		const file = readdirSync(directory).find(name => name.endsWith(".jsonl"));
		return file ? readFileSync(join(directory, file), "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line)) : [];
	}
	function messages() { return entries().filter(entry => entry.type === "message").map(entry => entry.message); }
	async function wait(predicate, label) {
		try { await until(predicate); }
		catch (error) { throw new Error(`Timed out: ${label}`, { cause: error }); }
	}
	async function expectScreen(text) { await wait(() => screen().includes(text), text); }
	async function send(text) {
		keys("-l", text);
		keys("Enter");
		await sleep(50);
	}
	async function snapshot() {
		rmSync(join(root, "snapshot.json"), { force: true });
		keys("C-y");
		await wait(() => existsSync(join(root, "snapshot.json")), "editor and queue snapshot");
		return JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8"));
	}

	try {
		const extensions = order === "bg-first" ? [backgroundPath, packagePath]
			: order === "queue-first" ? [packagePath, backgroundPath] : [packagePath];
		const command = ["env", `PI_CODING_AGENT_DIR=${join(root, "agent")}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
			process.execPath, cliPath, "--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
			"--provider", "queue-test", "--model", "test", "--session-dir", join(root, "sessions"), "--tui-mode", mode,
			...extensions.flatMap(path => ["-e", path]), "-e", providerPath].map(quote).join(" ");
		tmux("new-session", "-d", "-s", "verify", "-x", "110", "-y", "35", "-c", root, "sleep 600");
		started = true;
		tmux("set-option", "-w", "-t", "verify", "remain-on-exit", "on");
		tmux("respawn-pane", "-k", "-t", "verify", "-c", root, `exec ${command}`);
		await expectScreen("0.0%/128k");
		await send("/test-reload");
		await expectScreen("Reloaded");
		assert(!JSON.parse(readFileSync(join(root, "commands.json"), "utf8")).includes("unqueue"));
		await send("START");
		await wait(() => existsSync(join(root, "started-a")), "first tool");
		await send("/test-notifications");
		const first = withImage ? "SAME" : "FIRST";
		const second = withImage ? "SAME" : "SECOND";
		await send(first);
		await send(withImage ? "/test-image SAME" : second);
		await expectScreen(toggleHint);
		let state = await snapshot();
		assert.deepEqual(state.steering, [first, second]);
		assert.deepEqual(state.followUp, []);
		keys("Tab");
		await expectScreen(`Follow-up: ${second}`);
		state = await snapshot();
		assert.deepEqual(state.steering, []);
		assert.deepEqual(state.followUp, [first, second]);
		assert.deepEqual(state.customSteer, ["background-steer"]);
		assert.deepEqual(state.customFollow, ["background-follow"]);

		await expectScreen(toggleHint);
		const lines = screen().split("\n");
		const lastMessage = lines.findLastIndex(line => line.includes(`Follow-up: ${second}`));
		const nativeHint = lines[lastMessage + 1];
		assert(nativeHint.includes("to edit all queued messages"), "Pi's native edit hint must remain unchanged.");
		assert(nativeHint.includes(withImage ? "+Q" : "+Up"));
		const hintIndex = lines.findIndex(line => line.includes(toggleHint));
		assert(hintIndex > lastMessage + 1, "The extension hint must be outside the native pending-message block.");
		assert(lines.slice(hintIndex + 1).some(line => line.includes("Working")), "The hint must be above the working/input row.");
		assertKeyHints(screen(true).split("\n").find(line => stripTerminalSequences(line).includes(toggleHint)), ["tab"]);
		assert(!screen().includes("tab follow-up all"));
		assert(!screen().includes("tab steer all"));

		await send("THIRD");
		state = await snapshot();
		assert.deepEqual(state.followUp, [first, second, "THIRD"]);
		assert.deepEqual(state.steering, []);
		keys("Tab");
		await expectScreen("Steering: THIRD");
		state = await snapshot();
		assert.deepEqual(state.steering, [first, second, "THIRD"]);
		assert.deepEqual(state.followUp, []);
		await send("FOURTH");
		state = await snapshot();
		assert.deepEqual(state.steering, [first, second, "THIRD", "FOURTH"]);
		keys("Tab");
		await expectScreen("Follow-up: FOURTH");
		keys("-l", "draft");
		keys("Tab");
		await sleep(75);
		assert(!screen().includes(toggleHint), "The toggle hint must hide while editing a draft.");
		state = await snapshot();
		assert.equal(state.text, "draft");
		assert.deepEqual(state.followUp, [first, second, "THIRD", "FOURTH"]);
		keys("-l", "/b");
		await expectScreen("Report a bug");
		keys("Tab");
		await sleep(75);
		state = await snapshot();
		assert(state.text.startsWith("/b") && state.text !== "/b", "Tab must still complete a slash command.");
		assert.deepEqual(state.followUp, [first, second, "THIRD", "FOURTH"]);
		await send("/test-dialog");
		await expectScreen("Test dialog");
		keys("Tab");
		await sleep(75);
		keys("Escape");
		await wait(() => !screen().includes("Test dialog"), "dialog closed");
		state = await snapshot();
		assert.deepEqual(state.followUp, [first, second, "THIRD", "FOURTH"]);

		for (const file of ["release-a", "release-b", "release-second"]) writeFileSync(join(root, file), "");
		await wait(() => existsSync(join(root, "settled")), "all follow-ups complete");
		const history = messages();
		const finalIndex = history.findIndex(message => message.role === "assistant" && messageText(message) === "ORIGINAL_FINAL");
		assert(finalIndex >= 0);
		const queued = history.slice(finalIndex + 1).filter(message => message.role === "user");
		assert.deepEqual(queued.map(messageText), [first, second, "THIRD", "FOURTH"]);
		assert(!history.slice(0, finalIndex).some(message => message.role === "user"
			&& [first, second, "THIRD", "FOURTH"].includes(messageText(message))));
		if (withImage) {
			assert(!queued[0].content.some(part => part.type === "image"));
			assert.equal(queued[1].content.filter(part => part.type === "image").length, 1);
		}

		await send("BLOCK");
		await wait(() => existsSync(join(root, "started-reset")), "new work");
		await send("EDIT_ONE");
		state = await snapshot();
		assert.deepEqual(state.steering, ["EDIT_ONE"]);
		assert.deepEqual(state.followUp, []);
		await send("EDIT_TWO");
		keys("Tab");
		await expectScreen("Follow-up: EDIT_TWO");
		await send("EDIT_THREE");
		await send("/test-mixed");
		state = await snapshot();
		assert.deepEqual(state.steering, ["FORCED_STEER"]);
		assert.deepEqual(state.followUp, ["EDIT_ONE", "EDIT_TWO", "EDIT_THREE", "FORCED_FOLLOW"]);
		keys("-l", "DRAFT");
		keys(editKey);
		await expectScreen("Restored 5 queued messages to editor");
		state = await snapshot();
		assert.equal(state.text, "FORCED_STEER\n\nEDIT_ONE\n\nEDIT_TWO\n\nEDIT_THREE\n\nFORCED_FOLLOW\n\nDRAFT");
		assert.deepEqual(state.steering, []);
		assert.deepEqual(state.followUp, []);
		await send("AFTER_EDIT");
		state = await snapshot();
		assert.deepEqual(state.steering, ["AFTER_EDIT"]);
		keys("Tab");
		await expectScreen("Follow-up: AFTER_EDIT");
		await send("/test-compaction COMPACT_ONE");
		state = await snapshot();
		assert.equal(state.compaction[0].mode, "followUp");
		keys("Tab");
		await expectScreen("Steering: COMPACT_ONE");
		state = await snapshot();
		assert.deepEqual(state.steering, ["AFTER_EDIT"]);
		assert.equal(state.compaction[0].mode, "steer");
		await send("/test-compaction COMPACT_TWO");
		state = await snapshot();
		assert(state.compaction.every(message => message.mode === "steer"));
		keys(editKey);
		await expectScreen("Restored 3 queued messages to editor");
		state = await snapshot();
		assert.equal(state.text, "AFTER_EDIT\n\nCOMPACT_ONE\n\nCOMPACT_TWO");
		assert.equal(state.compaction.length, 0);

		await send("ESC_ONE");
		await send("ESC_TWO");
		keys("Tab");
		await expectScreen("Follow-up: ESC_TWO");
		await send("/test-mixed");
		keys("-l", "ESC_DRAFT");
		keys("Escape");
		await wait(() => existsSync(join(root, "settled")), "Escape stops the run");
		await expectScreen("Command aborted");
		state = await snapshot();
		assert.equal(state.text, "FORCED_STEER\n\nESC_ONE\n\nESC_TWO\n\nFORCED_FOLLOW\n\nESC_DRAFT");
		assert.deepEqual(state.steering, []);
		assert.deepEqual(state.followUp, []);
		assert(!screen().includes(toggleHint));
		assert(!messages().some(message => message.role === "user"
			&& /^(EDIT_|AFTER_EDIT|COMPACT_|FORCED_|ESC_)/.test(messageText(message))));
		await send("/quit");
		await wait(() => tmux("display-message", "-p", "-t", "verify", "#{pane_dead}").trim() === "1", "shutdown");
		console.log(`${mode}, ${order}: toggles, inheritance, ordering, native editing/Escape, compaction, and hint placement passed.`);
	} catch (error) {
		if (started) console.error(tmux("capture-pane", "-t", "verify", "-p", "-S", "-100"));
		throw error;
	} finally {
		if (started) spawnSync("tmux", ["-L", socket, "kill-server"]);
		rmSync(root, { recursive: true, force: true });
	}
}

await run("regular", "alone");
await run("fullscreen", "alone", true);
await run("regular", "bg-first");
await run("fullscreen", "queue-first");
