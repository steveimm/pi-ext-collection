import { createBashToolDefinition, createLocalBashOperations, type BashToolOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackgroundManager, ForegroundProcess } from "./manager.js";

class Backgrounded extends Error {
	readonly id: string;
	constructor(id: string) {
		super(`Command moved to the background: ${id}`);
		this.id = id;
	}
}

export function createManagedBash(
	getManager: () => BackgroundManager,
	getOptions: () => BashToolOptions,
): ReturnType<typeof createBashToolDefinition> {
	const original = createBashToolDefinition(".");
	return {
		...original,
		description: `${original.description} The user can press Ctrl+B to move a running command to the background. In that case the result has background: true, a process id, and no exit code yet. Do not wait or repeatedly poll that process. Completion will notify you automatically.`,
		outputSchema: Type.Union([
			original.outputSchema!,
			Type.Object({ background: Type.Literal(true), id: Type.String(), output: Type.String(),
				log_path: Type.String(), truncated: Type.Boolean(), exit_code: Type.Null() }),
		]),
		async execute(callId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Command aborted");
			const manager = getManager();
			const options = getOptions();
			const backend = createLocalBashOperations(options.shellPath ? { shellPath: options.shellPath } : undefined);
			let process: ForegroundProcess | undefined;
			const tool = createBashToolDefinition(ctx.cwd, {
				...options,
				operations: {
					async exec(command, cwd, execution) {
						process = manager.startForeground({
							command: params.command, cwd,
							instruction: "The user moved this command to the background. Inspect its result and continue the original task.",
							...(execution.timeout === undefined ? {} : { timeoutSeconds: execution.timeout }),
						}, {
							exec: (_command, directory, job) => backend.exec(command, directory, {
								...job, ...(execution.env === undefined ? {} : { env: execution.env }),
							}),
						}, execution.onData);
						const running = process;
						const abort = () => { void manager.stopProcess(running.id); };
						if (execution.signal?.aborted) abort();
						else execution.signal?.addEventListener("abort", abort, { once: true });
						try {
							return await Promise.race([
								running.completed,
								running.backgrounded.then(() => { throw new Backgrounded(running.id); }),
							]);
						} finally {
							execution.signal?.removeEventListener("abort", abort);
						}
					},
				},
			});
			try {
				return await tool.execute(callId, params, signal, onUpdate, ctx);
			} catch (error) {
				if (!(error instanceof Backgrounded)) throw error;
				const job = manager.readProcess(error.id);
				return {
					content: [{ type: "text", text: `Command is running in the background as ${job.id}. You can finish this turn. Completion will notify you automatically.\nLog: ${job.log_path}` }],
					details: undefined,
					structuredContent: { background: true, id: job.id, output: job.output, log_path: job.log_path,
						truncated: job.log_truncated, exit_code: null },
				};
			} finally {
				if (process) manager.forgetForeground(process.id);
			}
		},
	};
}
