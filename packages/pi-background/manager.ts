import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, constants, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

const MAX_TAIL_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

export interface CommandOptions {
	command: string;
	cwd: string;
	label?: string;
	instruction?: string;
	timeoutSeconds?: number;
}

export interface WatchOptions extends CommandOptions {
	mode: "until_success" | "on_change";
	intervalSeconds: number;
}

interface OutputLog {
	path: string;
	bytes: number;
	truncated: boolean;
	tail: Buffer;
}

interface ProcessJob {
	id: string;
	options: CommandOptions;
	status: "running" | "completed" | "failed" | "stopped";
	exitCode: number | null;
	error: string | undefined;
	startedAt: string;
	finishedAt: string | undefined;
	log: OutputLog;
	controller: AbortController;
	done: Promise<void>;
	background: boolean;
	onData: ((data: Buffer) => void) | undefined;
	onBackground: (() => void) | undefined;
	executionError: unknown;
}

export interface ForegroundProcess {
	id: string;
	completed: Promise<{ exitCode: number | null }>;
	backgrounded: Promise<void>;
	cancel(): void;
}

interface Watcher {
	id: string;
	options: WatchOptions;
	operations: BashOperations;
	log: OutputLog;
	controller: AbortController | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	done: Promise<void>;
	lastCheck: string | undefined;
	lastExitCode: number | null;
	lastError: string | undefined;
	lastOutput: string;
	previous: string | undefined;
	previousError: string | undefined;
}

export interface BackgroundEvent {
	id: string;
	kind: "process" | "watcher";
	event: string;
	command: string;
	cwd: string;
	label: string | undefined;
	instruction: string | undefined;
	exit_code: number | null;
	error: string | undefined;
	output: string;
	log_path: string;
}

export interface NotificationTarget {
	isIdle(): boolean;
	send(events: BackgroundEvent[]): void;
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveDirectory(path: string | undefined, cwd: string): string {
	const target = realpathSync(resolve(cwd, expandHome(path ?? cwd)));
	if (!statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
	accessSync(target, constants.R_OK | constants.X_OK);
	return target;
}

function appendOutput(log: OutputLog, data: Buffer): void {
	const remaining = MAX_LOG_BYTES - log.bytes;
	if (remaining > 0) {
		const written = data.subarray(0, remaining);
		appendFileSync(log.path, written);
		log.bytes += written.length;
	}
	if (data.length > remaining) log.truncated = true;
	log.tail = Buffer.concat([log.tail, data]).subarray(-MAX_TAIL_BYTES);
}

function errorMessage(error: unknown, timeout?: number): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.startsWith("timeout:") ? `Timed out after ${timeout} seconds.` : message;
}

function processInfo(job: ProcessJob) {
	return {
		id: job.id, command: job.options.command, cwd: job.options.cwd, label: job.options.label,
		status: job.status, background: job.background, exit_code: job.exitCode, error: job.error,
		started_at: job.startedAt, finished_at: job.finishedAt, log_path: job.log.path, log_truncated: job.log.truncated,
	};
}

export class BackgroundManager {
	private processes = new Map<string, ProcessJob>();
	private watchers = new Map<string, Watcher>();
	private pending = new Map<string, BackgroundEvent>();
	private target: NotificationTarget | undefined;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	readonly logDirectory: string;

	constructor(logDirectory: string) {
		this.logDirectory = logDirectory;
	}

	attach(target: NotificationTarget): void {
		this.target = target;
		this.requestDelivery();
	}

	detach(): void {
		this.target = undefined;
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}

	requestDelivery(): void {
		if (this.disposed || !this.target || this.flushTimer || this.pending.size === 0) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			if (!this.target?.isIdle()) return;
			const events = [...this.pending.values()].slice(0, 8);
			this.target.send(events);
			for (const event of events) this.pending.delete(event.id);
			if (this.pending.size > 0) this.requestDelivery();
		}, 25);
		this.flushTimer.unref();
	}

	private queue(event: BackgroundEvent): void {
		if (this.disposed) return;
		this.pending.set(event.id, event);
		this.requestDelivery();
	}

	private createLog(id: string): OutputLog {
		if (this.disposed) throw new Error("This background session has ended.");
		mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 });
		const path = join(this.logDirectory, `${id}.log`);
		writeFileSync(path, "", { flag: "wx", mode: 0o600 });
		return { path, bytes: 0, truncated: false, tail: Buffer.alloc(0) };
	}

	start(options: CommandOptions, operations: BashOperations) {
		return processInfo(this.createProcess(options, operations));
	}

	startForeground(options: CommandOptions, operations: BashOperations, onData: (data: Buffer) => void): ForegroundProcess {
		let onBackground!: () => void;
		const backgrounded = new Promise<void>(resolve => { onBackground = resolve; });
		const job = this.createProcess(options, operations, { onData, onBackground });
		return {
			id: job.id,
			backgrounded,
			cancel: () => {
				// Ctrl+B takes effect before the caller's abort listener is removed.
				if (!job.background) this.cancelProcess(job);
			},
			completed: job.done.then(() => {
				if (job.executionError !== undefined) throw job.executionError;
				if (job.status === "stopped") throw new Error("aborted");
				return { exitCode: job.exitCode };
			}),
		};
	}

	backgroundLatest(): string | undefined {
		const job = [...this.processes.values()].reverse().find(job => job.status === "running" && !job.background);
		if (!job) return undefined;
		job.background = true;
		job.onData = undefined;
		job.onBackground?.();
		job.onBackground = undefined;
		return job.id;
	}

	forgetForeground(id: string): void {
		const job = this.processes.get(id);
		if (!job || job.background || job.status === "running") return;
		this.processes.delete(id);
		rmSync(job.log.path, { force: true });
	}

	private createProcess(options: CommandOptions, operations: BashOperations,
		foreground?: { onData: (data: Buffer) => void; onBackground: () => void }): ProcessJob {
		if (!options.command.trim()) throw new Error("Provide a non-empty command.");
		const id = `process-${randomUUID()}`;
		const job: ProcessJob = {
			id, options, status: "running", exitCode: null, error: undefined,
			startedAt: new Date().toISOString(), finishedAt: undefined, log: this.createLog(id),
			controller: new AbortController(), done: Promise.resolve(),
			background: foreground === undefined, onData: foreground?.onData,
			onBackground: foreground?.onBackground, executionError: undefined,
		};
		this.processes.set(id, job);
		job.done = this.runProcess(job, operations);
		return job;
	}

	private async runProcess(job: ProcessJob, operations: BashOperations): Promise<void> {
		try {
			const result = await operations.exec(job.options.command, job.options.cwd, {
				signal: job.controller.signal,
				...(job.options.timeoutSeconds === undefined ? {} : { timeout: job.options.timeoutSeconds }),
				onData: data => {
					try {
						appendOutput(job.log, data);
						job.onData?.(data);
					} catch (error) {
						job.error = `Cannot write the log: ${errorMessage(error)}`;
						job.controller.abort();
					}
				},
			});
			job.exitCode = result.exitCode;
			if (job.status !== "stopped") job.status = result.exitCode === 0 ? "completed" : "failed";
		} catch (error) {
			job.executionError = error;
			if (job.status !== "stopped") {
				job.status = "failed";
				job.error ??= errorMessage(error, job.options.timeoutSeconds);
			}
		} finally {
			job.finishedAt = new Date().toISOString();
			if (job.background && job.status !== "stopped") {
				this.queue({
					id: job.id, kind: "process", event: job.status, command: job.options.command, cwd: job.options.cwd,
					label: job.options.label, instruction: job.options.instruction, exit_code: job.exitCode,
					error: job.error, output: job.log.tail.toString("utf8").slice(-2000), log_path: job.log.path,
				});
			}
		}
	}

	listProcesses() {
		return [...this.processes.values()].filter(job => job.background).map(processInfo);
	}

	readProcess(id: string) {
		const job = this.processes.get(id);
		if (!job) throw new Error(`Unknown background process: ${id}`);
		return { ...processInfo(job), output: job.log.tail.toString("utf8") };
	}

	async stopProcess(id: string) {
		const job = this.processes.get(id);
		if (!job) throw new Error(`Unknown background process: ${id}`);
		this.cancelProcess(job);
		await job.done;
		this.pending.delete(id);
		return processInfo(job);
	}

	private cancelProcess(job: ProcessJob): void {
		if (job.status === "running") {
			job.status = "stopped";
			job.controller.abort();
		}
	}

	watch(options: WatchOptions, operations: BashOperations) {
		if (!options.command.trim()) throw new Error("Provide a non-empty check command.");
		const id = `watch-${randomUUID()}`;
		const watcher: Watcher = {
			id, options, operations, log: this.createLog(id), controller: undefined, timer: undefined,
			done: Promise.resolve(), lastCheck: undefined, lastExitCode: null, lastError: undefined,
			lastOutput: "", previous: undefined, previousError: undefined,
		};
		this.watchers.set(id, watcher);
		watcher.done = this.check(watcher);
		return { id, command: options.command, cwd: options.cwd, mode: options.mode, interval_seconds: options.intervalSeconds };
	}

	private async check(watcher: Watcher): Promise<void> {
		const controller = new AbortController();
		watcher.controller = controller;
		const hash = createHash("sha256");
		let output = Buffer.alloc(0);
		let failure: string | undefined;
		let exitCode: number | null = null;
		const timeout = watcher.options.timeoutSeconds ?? 10;
		try {
			appendOutput(watcher.log, Buffer.from(`\n[${new Date().toISOString()}] Checking\n`));
			const result = await watcher.operations.exec(watcher.options.command, watcher.options.cwd, {
				signal: controller.signal, timeout,
				onData: data => {
					hash.update(data);
					output = Buffer.concat([output, data]).subarray(-MAX_TAIL_BYTES);
					try {
						appendOutput(watcher.log, data);
					} catch (error) {
						failure = `Cannot write the log: ${errorMessage(error)}`;
						controller.abort();
					}
				},
			});
			exitCode = result.exitCode;
			if (exitCode === 126 || exitCode === 127) failure = `Check command could not run (exit ${exitCode}).`;
		} catch (error) {
			failure ??= errorMessage(error, timeout);
		}
		if (this.disposed || !this.watchers.has(watcher.id)) return;
		watcher.lastCheck = new Date().toISOString();
		watcher.lastExitCode = exitCode;
		watcher.lastError = failure;
		watcher.lastOutput = output.toString("utf8");
		watcher.controller = undefined;
		const signature = `${exitCode}:${failure ?? ""}:${hash.digest("hex")}`;
		let event: string | undefined;
		if (failure) {
			if (failure !== watcher.previousError) event = "check_failed";
		} else if (watcher.options.mode === "until_success") {
			if (exitCode === 0) {
				event = "matched";
				this.watchers.delete(watcher.id);
			}
		} else {
			if (watcher.previous !== undefined && watcher.previous !== signature) event = "changed";
		}
		watcher.previous = signature;
		watcher.previousError = failure;
		if (event) {
			this.queue({
				id: watcher.id, kind: "watcher", event, command: watcher.options.command, cwd: watcher.options.cwd,
				label: watcher.options.label, instruction: watcher.options.instruction, exit_code: exitCode,
				error: failure, output: watcher.lastOutput.slice(-2000), log_path: watcher.log.path,
			});
		}
		if (this.watchers.has(watcher.id)) {
			watcher.timer = setTimeout(() => { watcher.done = this.check(watcher); }, watcher.options.intervalSeconds * 1000);
			watcher.timer.unref();
		}
	}

	listWatchers() {
		return [...this.watchers.values()].map(watcher => ({
			id: watcher.id, command: watcher.options.command, cwd: watcher.options.cwd, label: watcher.options.label,
			mode: watcher.options.mode, interval_seconds: watcher.options.intervalSeconds,
			last_check: watcher.lastCheck, last_exit_code: watcher.lastExitCode, last_error: watcher.lastError,
			output: watcher.lastOutput.slice(-2000), log_path: watcher.log.path, log_truncated: watcher.log.truncated,
		}));
	}

	async deleteWatcher(id: string): Promise<void> {
		const watcher = this.watchers.get(id);
		if (!watcher) throw new Error(`Unknown watcher: ${id}`);
		this.watchers.delete(id);
		this.pending.delete(id);
		clearTimeout(watcher.timer);
		watcher.controller?.abort();
		await watcher.done;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.detach();
		this.pending.clear();
		await Promise.all([
			...[...this.processes.keys()].map(id => this.stopProcess(id)),
			...[...this.watchers.keys()].map(id => this.deleteWatcher(id)),
		]);
	}
}
