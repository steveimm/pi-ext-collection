import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const timingEntryType = "pi-better-ui/worked";
type TimingEntry = { text: string; durationMs: number; completedAt: string };

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds / 60) % 60;
	return hours ? `${hours}h ${minutes}m ${seconds % 60}s`
		: minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function completionText(durationMs: number, completedAt: Date): string {
	const time = completedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
	return `Worked for ${formatDuration(durationMs)} • ${time}`;
}

export function registerTiming(pi: ExtensionAPI): void {
	let started: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
		started = undefined;
	}

	pi.registerEntryRenderer<TimingEntry>(timingEntryType, (entry, _options, theme) => entry.data
		? new Text(theme.fg("dim", entry.data.text), pi.getSettings().outputPad ?? 1, 0) : undefined);

	// Earlier builds stored timing lines as conversation messages.
	const keepMessage = (message: { role: string; customType?: string }) => message.role !== "custom" || message.customType !== timingEntryType;
	pi.registerMessageRenderer(timingEntryType, (message, options, theme) =>
		new Text(theme.fg("dim", typeof message.content === "string" ? message.content : ""), options.outputPad ?? 1, 0));
	pi.on("context", event => ({ messages: event.messages.filter(keepMessage) }));
	pi.on("session_before_compact", ({ preparation }) => {
		preparation.messagesToSummarize = preparation.messagesToSummarize.filter(keepMessage);
		preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter(keepMessage);
	});
	pi.on("session_before_tree", ({ preparation }) => {
		const entries = preparation.entriesToSummarize;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type === "custom_message" && entry.customType === timingEntryType) entries.splice(i, 1);
		}
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || started !== undefined) return;
		started = performance.now();
		const update = () => {
			if (started !== undefined) ctx.ui.setWorkingMessage(`Working • ${formatDuration(performance.now() - started)}`);
		};
		update();
		timer = setInterval(update, 1000);
		timer.unref();
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (started === undefined) return;
		const durationMs = performance.now() - started;
		const completedAt = new Date();
		stop();
		ctx.ui.setWorkingMessage();
		pi.appendEntry<TimingEntry>(timingEntryType, {
			text: completionText(durationMs, completedAt),
			durationMs,
			completedAt: completedAt.toISOString(),
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
	});
}
