import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const timingMessageType = "pi-better-ui/worked";

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

	pi.registerMessageRenderer(timingMessageType, (message, options, theme) =>
		new Text(theme.fg("dim", typeof message.content === "string" ? message.content : ""), options.outputPad ?? 1, 0));
	pi.on("context", event => ({ messages: event.messages.filter(message => message.role !== "custom" || message.customType !== timingMessageType) }));
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
		pi.sendMessage({
			customType: timingMessageType,
			content: completionText(durationMs, completedAt),
			details: { durationMs, completedAt: completedAt.toISOString() },
			display: true,
		}, { triggerTurn: false });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
	});
}
