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
	mode: Type.Union([Type.Literal("until_success"), Type.Literal("on_change")]), interval_seconds: Type.Number(),
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
		}
		try {
			// Existing managers can come from the extension version loaded before /reload.
			const warning = BackgroundManager.prototype.relocateLogs.call(manager, logDirectory);
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
		description: "Start a background command and return immediately. You may finish your reply and continue chatting. Completion or failure automatically starts a follow-up turn with the result. Do not repeatedly poll while waiting. Use read for interim output, list for status, or stop to terminate a process and its children.",
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
		description: "Run a shell check on an interval without spending model turns on polling. until_success notifies once when the command exits 0 and removes itself. on_change uses the first result as a baseline and notifies when output or exit code changes. Notifications include the saved instruction and start a follow-up turn. Delete watchers when no longer needed.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("delete")]),
			id: Type.Optional(Type.String({ description: "Watcher ID returned by create." })),
			mode: Type.Optional(Type.Union([Type.Literal("until_success"), Type.Literal("on_change")])),
			interval_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400, description: "Delay between checks. Defaults to 30 seconds." })),
			...commandFields,
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
			return result(tasks.watch({
				...commandOptions(params, ctx.cwd),
				mode: params.mode ?? "until_success", intervalSeconds: params.interval_seconds ?? 30,
			}, shellOperations()));
		},
	});
}
