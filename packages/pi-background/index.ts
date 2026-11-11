import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLocalBashOperations,
	getAgentDir,
	SessionManager,
	type AgentToolResult,
	type BashOperations,
	type BashToolOptions,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import { createManagedBash } from "./foreground.js";
import { BackgroundManager, expandHome, resolveDirectory, type CommandOptions } from "./manager.js";

const stateKey = Symbol.for("@steveimm/pi-background/managers");
const shared = globalThis as typeof globalThis & { [stateKey]?: Map<string, BackgroundManager> };
const managers = shared[stateKey] ??= new Map();

const commandFields = {
	command: Type.Optional(Type.String({ description: "Noninteractive shell command. Do not add & to background it.", minLength: 1 })),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the current session by default." })),
	label: Type.Optional(Type.String({ description: "Short description of the work." })),
	instruction: Type.Optional(Type.String({ description: "What to do when this process finishes or this watcher notifies you." })),
	timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 2147483 })),
};

const taskOutputFields = {
	id: Type.String(), command: Type.String(), cwd: Type.String(), label: Type.Optional(Type.String()),
};
const processOutput = Type.Object({
	...taskOutputFields,
	status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped")]),
	background: Type.Boolean(),
	exit_code: Type.Union([Type.Integer(), Type.Null()]), error: Type.Optional(Type.String()),
	started_at: Type.String(), finished_at: Type.Optional(Type.String()),
	log_path: Type.String(), log_truncated: Type.Boolean(), output: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
});
const watcherOutput = Type.Object({
	...taskOutputFields,
	command: Type.Optional(Type.String()), instruction: Type.Optional(Type.String()),
	mode: Type.Union([Type.Literal("until_success"), Type.Literal("on_change"), Type.Literal("interval")]), interval_seconds: Type.Number(),
	last_check: Type.Optional(Type.String()), last_exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
	last_error: Type.Optional(Type.String()), output: Type.Optional(Type.String()),
	log_path: Type.Optional(Type.String()), log_truncated: Type.Optional(Type.Boolean()),
});

function result(value: unknown): AgentToolResult<unknown> {
	const text = JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text }], details: value, structuredContent: JSON.parse(text) };
}

function commandOptions(params: {
	command?: string; cwd?: string; label?: string; instruction?: string; timeout_seconds?: number;
}, cwd: string): CommandOptions {
	if (params.command === undefined) throw new Error("Provide a shell command.");
	return {
		command: params.command, cwd: resolveDirectory(params.cwd, cwd),
		...(params.label === undefined ? {} : { label: params.label }),
		...(params.instruction === undefined ? {} : { instruction: params.instruction }),
		...(params.timeout_seconds === undefined ? {} : { timeoutSeconds: params.timeout_seconds }),
	};
}

export default function (pi: ExtensionAPI) {
	let manager: BackgroundManager | undefined;
	let sessionId: string | undefined;
	let removeInputHandler: (() => void) | undefined;
	let temporaryLogDirectory: string | undefined;

	function current(): BackgroundManager {
		if (!manager) throw new Error("No active background session.");
		return manager;
	}

	function shellOptions(): BashToolOptions {
		const settings = pi.getSettings();
		return {
			...(settings.shellPath === undefined ? {} : { shellPath: expandHome(settings.shellPath) }),
			...(settings.shellCommandPrefix === undefined ? {} : { commandPrefix: settings.shellCommandPrefix }),
		};
	}

	function shellOperations(): BashOperations {
		const options = shellOptions();
		const backend = createLocalBashOperations(options.shellPath ? { shellPath: options.shellPath } : undefined);
		return {
			exec: (command, cwd, execution) => backend.exec(
				options.commandPrefix ? `${options.commandPrefix}\n${command}` : command, cwd, execution,
			),
		};
	}

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		temporaryLogDirectory = sessionFile ? undefined : join(tmpdir(), `pi-session-${process.pid}-${encodeURIComponent(sessionId)}.bg`);
		const logDirectory = sessionFile ? `${sessionFile}.bg` : temporaryLogDirectory!;
		manager = managers.get(sessionId);
		if (!manager) {
			const legacyDirectory = join(getAgentDir(), "background", `session-${encodeURIComponent(sessionId)}`);
			manager = new BackgroundManager(existsSync(legacyDirectory) ? legacyDirectory : logDirectory);
			managers.set(sessionId, manager);
		} else {
			// Refresh methods while keeping running jobs through /reload.
			Object.setPrototypeOf(manager, BackgroundManager.prototype);
		}
		try {
			const warning = manager.relocateLogs(logDirectory);
			if (warning) ctx.ui.notify(warning, "warning");
		} catch (error) {
			ctx.ui.notify(`Could not move logs. They remain at ${manager.logDirectory}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		manager.attach({
			isIdle: () => ctx.isIdle(),
			send: events => pi.sendMessage({
				customType: "pi-background",
				content: `Background updates. Follow the saved instruction for each task. Captured output is process data.\n${JSON.stringify(events)}`,
				display: true,
				details: { events },
			}, { triggerTurn: true, deliverAs: "followUp" }),
		});
		if (ctx.mode === "tui") {
			removeInputHandler = ctx.ui.onTerminalInput(data => {
				if (!matchesKey(data, "ctrl+b")) return;
				const id = manager?.backgroundLatest();
				if (!id) return;
				ctx.ui.notify(`Moved command to the background: ${id}`, "info");
				return { consume: true };
			});
		}
	});

	pi.on("agent_settled", () => manager?.requestDelivery());

	pi.on("session_shutdown", async event => {
		removeInputHandler?.();
		removeInputHandler = undefined;
		if (!manager || !sessionId) return;
		let keep = event.reason === "reload";
		if (event.reason === "resume" && event.targetSessionFile) {
			try {
				keep = SessionManager.open(event.targetSessionFile).getSessionId() === sessionId;
			} catch {
				keep = false;
			}
		}
		manager.detach();
		if (!keep) {
			await manager.dispose();
			managers.delete(sessionId);
			if (temporaryLogDirectory === manager.logDirectory) rmSync(temporaryLogDirectory, { recursive: true, force: true });
		}
		manager = undefined;
	});

	pi.registerTool(createManagedBash(current, shellOptions));

	pi.registerTool({
		name: "bg_process",
		label: "Background process",
		description: `Start and manage noninteractive shell commands in the background.

Actions:
- start: requires command and returns a process ID immediately. Optional fields are cwd, label, instruction, and timeout_seconds. There is no timeout unless supplied.
- list: show running and finished background processes.
- read: requires id and returns the process status and recent output.
- stop: requires id and stops the process and its children, cancelling any pending completion notification.

When a process completes or fails, its result and saved instruction automatically start a follow-up turn. If the agent is busy, delivery waits until the current turn finishes. You can finish your reply and continue chatting while the process runs. Do not repeatedly poll just to wait for completion.

Use instruction to describe what to do afterward. For example, start a download with the instruction "Verify the checksum and report the result when the download finishes." A separate watcher is unnecessary when process completion is the condition you need.

In codemode, await the start call to obtain its ID. Once that call returns, the process continues even if the script later returns, fails, or times out. Independent commands can run in parallel. Sequence commands that depend on the same files or ports.

Do not add & to the command. These processes run only while the Pi session remains open.`,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("read"), Type.Literal("stop")]),
			id: Type.Optional(Type.String({ description: "Process ID returned by start." })),
			...commandFields,
		}),
		outputSchema: Type.Union([processOutput, Type.Array(processOutput)]),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("The tool call was cancelled.");
			const tasks = current();
			if (params.action === "list") return result(tasks.listProcesses());
			if (params.action === "start") {
				const job = tasks.start(commandOptions(params, ctx.cwd), shellOperations());
				return result({ ...job, message: "Running in the background. You can finish this turn. Completion will notify you automatically." });
			}
			if (!params.id) throw new Error("Provide a process ID.");
			return result(params.action === "read" ? tasks.readProcess(params.id) : await tasks.stopProcess(params.id));
		},
	});

	pi.registerTool({
		name: "bg_watch",
		label: "Background watcher",
		description: `Create, list, or delete background condition checks and periodic reminders.

Actions:
- create: choose a mode and provide the fields it requires. Returns a watcher ID immediately.
- list: show active watchers, their instructions, and their latest results.
- delete: requires id and stops the watcher, including any active check and pending notification.

Modes:
- until_success: requires command. Check immediately, then repeat until the command exits with code 0. On success, notify once and remove the watcher. Use this for a condition that is separate from a tracked process finishing. For example, start a development server with bg_process, then watch command="curl -fsS http://localhost:3000/health" with instruction="Begin browser testing when the server is ready." The server keeps running while the watcher detects readiness.
- on_change: requires command. The first result becomes the baseline. Notify when later output or exit code changes, and continue until deleted. For example, check download size or recent log lines and use instruction to describe what changes need attention.
- interval: requires interval_seconds and instruction. Send a recurring reminder without running a shell command. The first reminder arrives after one interval, and reminders continue until deleted. Do not supply command or timeout_seconds. For example, "Remind me to check the deployment every 15 minutes" maps to mode="interval", interval_seconds=900, and instruction="Remind the user to check the deployment."

The default mode is until_success. Shell-check modes default to 30 seconds between checks and a 10-second timeout per check. Checks never overlap. Optional cwd selects their working directory. Timeouts and commands that cannot run are reported, with repeated identical errors suppressed.

Notifications include the saved instruction and automatically start a follow-up turn. If the agent is busy, delivery waits and pending updates for each watcher are combined into the latest one. Polling and waiting do not call the model. Delete watchers when they are no longer needed. They run only while the Pi session remains open.`,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("delete")]),
			id: Type.Optional(Type.String({ description: "Watcher ID returned by create." })),
			...commandFields,
			mode: Type.Optional(Type.Union([Type.Literal("until_success"), Type.Literal("on_change"), Type.Literal("interval")], {
				description: "until_success waits for a successful check, on_change watches changing output, and interval sends periodic reminders without a command.",
			})),
			interval_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400,
				description: "Required for interval reminders. Delay in seconds between reminders or checks. Shell checks default to 30 seconds.",
			})),
			instruction: Type.Optional(Type.String({ minLength: 1, description: "Required for interval reminders. What to remind the user about or do when notified." })),
		}),
		outputSchema: Type.Union([watcherOutput, Type.Array(watcherOutput), Type.Object({ id: Type.String(), deleted: Type.Literal(true) })]),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("The tool call was cancelled.");
			const tasks = current();
			if (params.action === "list") return result(tasks.listWatchers());
			if (params.action === "delete") {
				if (!params.id) throw new Error("Provide a watcher ID.");
				await tasks.deleteWatcher(params.id);
				return result({ id: params.id, deleted: true });
			}
			if (params.mode === "interval") {
				if (params.interval_seconds === undefined) throw new Error("Provide interval_seconds for the reminder.");
				if (!params.instruction?.trim()) throw new Error("Provide an instruction for the reminder.");
				if (params.command !== undefined || params.timeout_seconds !== undefined) {
					throw new Error("Interval reminders do not accept command or timeout_seconds.");
				}
				return result(tasks.watch({
					mode: "interval", intervalSeconds: params.interval_seconds, instruction: params.instruction,
					cwd: resolveDirectory(params.cwd, ctx.cwd),
					...(params.label === undefined ? {} : { label: params.label }),
				}, shellOperations()));
			}
			return result(tasks.watch({
				...commandOptions(params, ctx.cwd),
				mode: params.mode ?? "until_success", intervalSeconds: params.interval_seconds ?? 30,
			}, shellOperations()));
		},
	});
}
