import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import { moveNewestPending } from "./queue.js";

export default function (pi: ExtensionAPI) {
	let cleanup: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let session: AgentSession | undefined;
		let tui: TUI | undefined;
		let unsubscribe: (() => void) | undefined;
		let stopped = false;
		let disabled = false;
		const original = AgentSession.prototype.getSteeringMessages;

		function update() {
			if (!disabled && session?.getSteeringMessages().length) {
				ctx.ui.setWidget("pi-queue-message", (ui, theme) => {
					tui = ui;
					return new Text(theme.style("tab", { fg: "text", bold: true }) + theme.fg("dim", " queue newest message"), 0, 0);
				});
			} else {
				tui = undefined;
				ctx.ui.setWidget("pi-queue-message", undefined);
			}
		}

		function restore() {
			if (AgentSession.prototype.getSteeringMessages === capture) AgentSession.prototype.getSteeringMessages = original;
		}

		// The native pending-message display supplies the active session on its first read.
		function capture(this: AgentSession): readonly string[] {
			const messages = original.call(this);
			if (!stopped && !session && this.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()) {
				session = this;
				restore();
				unsubscribe = session.subscribe(event => { if (event.type === "queue_update") update(); });
				update();
			}
			return messages;
		}
		AgentSession.prototype.getSteeringMessages = capture;

		const removeInput = ctx.ui.onTerminalInput(data => {
			if (!matchesKey(data, "tab") || disabled || !session || !tui) return;
			if (!("getFocusedComponent" in tui) || typeof tui.getFocusedComponent !== "function") return;
			const focused = tui.getFocusedComponent();
			if (!focused || typeof focused.getText !== "function" || focused.getText() !== "" || focused.capturesViewportInput) return;
			try {
				if (moveNewestPending(session)) return { consume: true };
			} catch (error) {
				disabled = true;
				update();
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		});
		cleanup = () => {
			stopped = true;
			restore();
			unsubscribe?.();
			removeInput();
			ctx.ui.setWidget("pi-queue-message", undefined);
		};
	});

	pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; });
}
