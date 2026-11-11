import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function resolveDirectory(input: string, cwd: string): string {
	let path = input.trim();
	if (path.startsWith('"') || path.startsWith("'")) {
		if (path.length < 2 || path.at(-1) !== path[0]) {
			throw new Error("Close the quote around the directory path.");
		}
		path = path.slice(1, -1);
	}
	if (!path) throw new Error("Specify a directory after /cd.");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || path.startsWith("~\\")) path = join(homedir(), path.slice(2));

	const directory = realpathSync(resolve(cwd, path));
	if (!statSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
	accessSync(directory, constants.R_OK | constants.X_OK);
	return directory;
}

function describeError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") return "The directory or session file does not exist.";
	if (code === "ENOTDIR") return "Part of the path is not a directory.";
	if (code === "EACCES" || code === "EPERM") return "Permission denied while accessing the directory or session file.";
	if (code === "EEXIST") return "A session file already exists at the destination. It was not overwritten.";
	return error instanceof Error ? error.message : String(error);
}

function prepareSession(ctx: ExtensionCommandContext, directory: string): { path: string; source: string; content?: Buffer } {
	const source = ctx.sessionManager.getSessionFile();
	const header = ctx.sessionManager.getHeader();
	if (!source || !header) throw new Error("/cd requires a persistent session. Restart Pi without --no-session.");

	const sessionDir = SessionManager.create(directory).getSessionDir();
	const path = join(sessionDir, basename(source));
	const content = existsSync(source) ? readFileSync(source) : undefined;
	const entries = ctx.sessionManager.getEntries();
	const leafId = ctx.sessionManager.getLeafId();
	const serialized = [{ ...header, cwd: directory }, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
	const fd = openSync(path, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, `${serialized}\n`);
		} finally {
			closeSync(fd);
		}
		const moved = SessionManager.open(path);
		if (leafId === null) moved.resetLeaf();
		else moved.branch(leafId);
		// Persist the active branch, which can differ from the last entry in the transcript.
		moved.appendCustomEntry("pi-change-dir", { from: ctx.cwd, to: directory });
	} catch (error) {
		unlinkSync(path);
		throw error;
	}
	return content === undefined ? { path, source } : { path, source, content };
}

export default function (pi: ExtensionAPI) {
	let changingDirectory = false;

	pi.registerCommand("cd", {
		description: "Change directory and continue this session. Use /cd <path>, or /cd to show the current directory.",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify(`Current directory: ${ctx.cwd}`, "info");
				return;
			}
			if (changingDirectory || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current operation and queued messages to finish before using /cd.", "warning");
				return;
			}

			let directory: string;
			let move: ReturnType<typeof prepareSession>;
			try {
				directory = resolveDirectory(args, ctx.cwd);
				let current = ctx.cwd;
				try {
					current = realpathSync(current);
				} catch {
					// Allow leaving a directory that was deleted.
				}
				if (directory === current) {
					ctx.ui.notify(`Already in ${directory}`, "info");
					return;
				}
				move = prepareSession(ctx, directory);
			} catch (error) {
				ctx.ui.notify(`Cannot change directory: ${describeError(error)}`, "error");
				return;
			}

			changingDirectory = true;
			try {
				const result = await ctx.switchSession(move.path, {
					withSession: async (next) => {
						try {
							if (existsSync(move.source)) {
								if (!move.content || !readFileSync(move.source).equals(move.content)) {
									next.ui.notify(`The old transcript changed during the switch and was kept at ${move.source}.`, "warning");
								} else {
									unlinkSync(move.source);
								}
							}
						} catch (error) {
							next.ui.notify(`Directory changed, but the old transcript was kept at ${move.source}: ${describeError(error)}`, "warning");
						}
						next.ui.notify(`Changed directory to ${next.cwd}`, "info");
					},
				});
				if (result.cancelled) {
					unlinkSync(move.path);
					ctx.ui.notify("Directory change cancelled.", "info");
				}
			} catch (error) {
				// Pi may stop the old runtime before the switch fails. Keep both files for recovery.
				throw new Error(`Cannot finish changing directory: ${describeError(error)} Original session: ${move.source}. Destination: ${move.path}.`);
			} finally {
				changingDirectory = false;
			}
		},
	});
}
