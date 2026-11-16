import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { until } from "../../../test/helpers.mjs";

const packagePath = fileURLToPath(new URL("..", import.meta.url));
const background = fileURLToPath(new URL("../../pi-background", import.meta.url));
const queue = fileURLToPath(new URL("../../pi-queue-message", import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;

async function run(mode, order) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-ui-")));
	const fixture = join(root, "provider.js");
	copyFileSync(new URL("fixtures/provider.js", import.meta.url), fixture);
	const socket = `pi-better-ui-${randomUUID()}`;
	let started = false;
	function tmux(...args) {
		const result = spawnSync("tmux", ["-f", "/dev/null", "-L", socket, ...args], { encoding: "utf8", timeout: 5000 });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout;
	}
	const keys = (...args) => tmux("send-keys", "-t", "verify", ...args);
	const screen = () => stripTerminalSequences(tmux("capture-pane", "-t", "verify", "-p"));
	async function wait(predicate, label) {
		try { await until(predicate); } catch (error) { throw new Error(`Timed out: ${label}`, { cause: error }); }
	}
	async function send(text) { keys("-l", text); keys("Enter"); await sleep(60); }
	function entries() {
		const directory = join(root, "sessions");
		const file = existsSync(directory) && readdirSync(directory).find(name => name.endsWith(".jsonl"));
		return file ? readFileSync(join(directory, file), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
	}
	const completions = () => entries().filter(entry => entry.type === "custom_message" && entry.customType === "pi-better-ui/worked");
	async function state() {
		rmSync(join(root, "ui-state.json"), { force: true });
		keys("C-y");
		await wait(() => existsSync(join(root, "ui-state.json")), "UI snapshot");
		return JSON.parse(readFileSync(join(root, "ui-state.json"), "utf8"));
	}
	async function complete(name, expectedCount) {
		writeFileSync(join(root, `release-${name}`), "");
		await wait(() => completions().length === expectedCount, "completion metadata");
		await wait(() => existsSync(join(root, "settled")), "agent settled");
		await wait(() => screen().includes("Worked for"), "completion line");
	}
	try {
		const extensions = order === "first" ? [packagePath, background, queue] : order === "last" ? [background, queue, packagePath] : [packagePath];
		const command = ["env", `PI_CODING_AGENT_DIR=${join(root, "agent")}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
			process.execPath, cli, "--offline", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
			"--provider", "better-ui-test", "--model", "test", "--session-dir", join(root, "sessions"), "--tui-mode", mode,
			...extensions.flatMap(path => ["-e", path]), "-e", fixture].map(quote).join(" ");
		tmux("new-session", "-d", "-s", "verify", "-x", "100", "-y", "32", "-c", root, "sleep 600");
		started = true;
		tmux("set-option", "-w", "-t", "verify", "remain-on-exit", "on");
		tmux("respawn-pane", "-k", "-t", "verify", "-c", root, `exec ${command}`);
		await wait(() => screen().includes("0.0%/128k"), "Pi startup");
		await send("FIRST first question");
		await wait(() => screen().includes("Working 1s"), "live duration beside Working");
		await complete("FIRST", 1);
		assert.match(completions()[0].content, /^Worked for \d+s • \d{1,2}:\d{2} [AP]M$/);
		assert(!screen().includes("Working "));
		assert.equal((await state()).mode, mode);
		if (mode === "regular") {
			assert(!screen().split("\n")[0].includes("› FIRST"));
			await send("/test-mode fullscreen");
		}
		await wait(() => screen().split("\n")[0].includes("› FIRST first question"), "first sticky prompt");
		keys("C-Home");
		await wait(() => (screen().split("\n")[0] ?? "").includes("›") === false, "header hidden at transcript start");
		keys("C-End");
		await wait(() => screen().split("\n")[0].includes("› FIRST"), "return to latest");
		const longPrompt = `SECOND second question ${"한글 😀 longer prompt ".repeat(15)}`;
		await send(longPrompt);
		await wait(() => existsSync(join(root, "started-SECOND")), "second response");
		await complete("SECOND", 2);
		await wait(() => screen().split("\n")[0].includes("› SECOND second question"), "new sticky prompt");
		const beforeWheel = (await state()).scrollTop;
		keys("-l", "\x1b[<64;5;5M".repeat(6));
		await wait(async () => (await state()).scrollTop < beforeWheel, "mouse wheel scroll");
		for (let i = 0; i < 20 && !screen().split("\n")[0].includes("› FIRST"); i++) { keys("PPage"); await sleep(60); }
		await wait(() => screen().split("\n")[0].includes("› FIRST"), "older prompt while reading older response");
		keys("C-End");
		await send("/test-reload");
		await wait(() => screen().includes("Reloaded"), "reload complete");
		await wait(() => screen().split("\n")[0].includes("› SECOND"), "sticky prompt after reload");
		assert.equal(completions().length, 2);
		assert(!screen().includes("[pi-better-ui/worked]"));
		tmux("resize-window", "-t", "verify", "-x", "40", "-y", "18");
		await wait(() => screen().split("\n")[0].includes("…"), "truncated sticky prompt after resize");
		assert(visibleWidth(screen().split("\n")[0]) <= 40);
		tmux("resize-window", "-t", "verify", "-x", "100", "-y", "32");
		await send("/test-mode regular");
		assert.equal((await state()).mode, "regular");
		await send("/test-mode fullscreen");
		await wait(() => screen().split("\n")[0].includes("› SECOND"), "sticky prompt after mode switch");
		await send("TOOLS run a command");
		await wait(() => existsSync(join(root, "started-TOOLS")), "tool run");
		await complete("TOOLS", 3);
		assert(completions()[2].details.durationMs >= 1000);
		await send("ABORT stop this request");
		await wait(() => existsSync(join(root, "started-ABORT")), "abortable response");
		keys("Escape");
		await wait(() => completions().length === 4, "interrupted run timing");
		if (order !== "alone") {
			await send("FORCE wait for queued input");
			await wait(() => existsSync(join(root, "started-FORCE")), "force-send source run");
			await send("FORCED queued message");
			keys("Tab");
			await wait(() => screen().includes("force send"), "queue controls beside working indicator");
			keys("M-s");
			await wait(() => existsSync(join(root, "started-FORCED")), "forced queued input");
			assert.equal(completions().length, 5);
			await complete("FORCED", 6);
			await wait(() => screen().split("\n")[0].includes("› FORCED queued message"), "sticky forced prompt");
		}
		assert(!readFileSync(join(root, "requests.jsonl"), "utf8").includes("Worked for"));
		await send("/quit");
		await wait(() => tmux("display-message", "-p", "-t", "verify", "#{pane_dead}").trim() === "1", "shutdown");
		console.log(`${mode}, ${order}: sticky prompts, scrolling, resizing, mode changes, timing, context filtering, and reload passed.`);
	} catch (error) {
		if (started) console.error(await state());
		if (started) console.error(tmux("capture-pane", "-t", "verify", "-p", "-S", "-65"));
		throw error;
	} finally {
		if (started) spawnSync("tmux", ["-L", socket, "kill-server"]);
		rmSync(root, { recursive: true, force: true });
	}
}

await run("fullscreen", "alone");
await run("regular", "alone");
await run("fullscreen", "first");
await run("fullscreen", "last");
