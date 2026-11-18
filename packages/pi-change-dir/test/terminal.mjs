import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { until } from "../../../test/helpers.mjs";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const cliPath = process.env.PI_CHANGE_DIR_TEST_CLI ?? join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;

async function run(mode) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cd-terminal-")));
	const project = join(root, "project");
	for (const path of ["alpha/one", "alpha/two", "beta/leaf", "quiet", "space dir/nested folder"]) {
		mkdirSync(join(project, path), { recursive: true });
	}
	writeFileSync(join(project, "not-a-directory.txt"), "file");
	const snapshot = join(root, "state.json");
	const probe = join(root, "probe.mjs");
	writeFileSync(probe, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerShortcut("f12", { handler: ctx => {
    writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify({ cwd: ctx.cwd, text: ctx.ui.getEditorText() }));
  } });
  pi.registerCommand("test-reload", { handler: async (_, ctx) => { await ctx.reload(); } });
  pi.on("session_start", () => writeFileSync(${JSON.stringify(join(root, "ready"))}, ""));
  pi.registerProvider("completion-test", {
    baseUrl: "https://unused.invalid", apiKey: "fixture", api: "completion-test",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    streamSimple() { throw new Error("Directory completion must not call a model"); }
  });
}
`);
	const socket = `pi-cd-${randomUUID()}`;
	let started = false;
	function tmux(...args) {
		const result = spawnSync("tmux", ["-f", "/dev/null", "-L", socket, ...args], { encoding: "utf8", timeout: 5000 });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout;
	}
	const keys = (...args) => tmux("send-keys", "-t", "test", ...args);
	const screen = () => tmux("capture-pane", "-t", "test", "-p");
	async function state() {
		rmSync(snapshot, { force: true });
		await until(() => {
			if (existsSync(snapshot)) return true;
			keys("F12");
			return false;
		});
		return JSON.parse(readFileSync(snapshot, "utf8"));
	}
	async function input(text) {
		keys("End", "C-u");
		keys("-l", `\x1b[200~${text}\x1b[201~`);
		await until(async () => (await state()).text === text);
	}
	try {
		const command = ["env", `PI_CODING_AGENT_DIR=${join(root, "agent")}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
			process.execPath, cliPath, "--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-context-files",
			"--provider", "completion-test", "--model", "test", "--session-dir", join(root, "sessions"), "--tui-mode", mode,
			"-e", extensionPath, "-e", probe].map(quote).join(" ");
		tmux("new-session", "-d", "-s", "test", "-x", "110", "-y", "30", "-c", project, "sleep 600");
		started = true;
		tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
		tmux("respawn-pane", "-k", "-t", "test", "-c", project, `exec ${command}`);
		await until(() => existsSync(join(root, "ready")));
		keys("-l", "/cd ");
		await until(async () => (await state()).text === "/cd ");
		keys("Tab");
		await until(() => screen().includes("alpha/") && screen().includes("beta/"));
		assert(!screen().includes("not-a-directory.txt"));
		assert(screen().split("\n").filter(line => /alpha\/|beta\/|quiet\/|space dir\//.test(line)).every(line => !line.includes("directory")));
		keys("Down", "Down", "Up", "Tab");
		await until(async () => (await state()).text === "/cd beta/");
		assert.equal((await state()).cwd, project);
		keys("Tab");
		await until(async () => (await state()).text === "/cd beta/leaf/");

		const alpha = join(project, "alpha");
		await input(`/cd ${alpha}`);
		keys("Tab");
		await until(() => screen().includes("one/") && screen().includes("two/"));
		keys("Down", "Tab");
		await until(async () => (await state()).text === `/cd ${alpha}/two/`);
		keys("Enter");
		await until(async () => (await state()).cwd === join(alpha, "two"));
		await input("/cd ../");
		keys("Tab");
		await until(() => screen().includes("one/") && screen().includes("two/"));
		keys("Escape");
		await until(() => !screen().includes("→ one/") && !screen().includes("→ two/"));
		assert.equal((await state()).text, "/cd ../");

		await input(`/cd ${project}/space d`);
		keys("Tab");
		await until(async () => (await state()).text === `/cd "${project}/space dir/"`);
		keys("Tab");
		await until(async () => (await state()).text === `/cd "${project}/space dir/nested folder/"`);
		keys("Enter");
		await until(async () => (await state()).cwd === join(project, "space dir/nested folder"));
		await input("/test-reload");
		keys("Enter");
		await until(() => screen().includes("Reloaded"));
		await input(`/cd ${alpha}/`);
		keys("Tab");
		await until(() => screen().includes("one/") && screen().includes("two/"));
		keys("Tab");
		await until(async () => (await state()).text === `/cd ${alpha}/one/`);
		await input("/quit");
		keys("Enter");
		await until(() => tmux("display-message", "-p", "-t", "test", "#{pane_dead}").trim() === "1");
		console.log(`${mode}: directory menus, Up/Down, Tab, spaces, cwd changes, and reload passed.`);
	} catch (error) {
		if (started) console.error(screen());
		throw error;
	} finally {
		if (started) spawnSync("tmux", ["-L", socket, "kill-server"]);
		rmSync(root, { recursive: true, force: true });
	}
}

for (const mode of ["regular", "fullscreen"]) await run(mode);
