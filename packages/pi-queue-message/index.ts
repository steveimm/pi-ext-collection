import { InteractiveMode, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { createMessageQueue, type CompactionMessage, type DeliveryMode } from "./queue.js";

interface PendingDisplay {
	session: AgentSession;
	ui: TUI;
	editor: EditorComponent;
	compactionQueuedMessages: CompactionMessage[];
	getAllQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] };
	queueCompactionMessage(text: string, mode: DeliveryMode): void;
	restoreQueuedMessagesToEditor(options?: { abort?: boolean }): number;
	updatePendingMessagesDisplay(): void;
}

export default function (pi: ExtensionAPI) {
	let cleanup: (() => void) | undefined;
	let forceSend: (() => Promise<void>) | undefined;
	pi.registerShortcut("alt+s", {
		description: "Interrupt and send all queued messages",
		handler: async () => { await forceSend?.(); },
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const prototype = InteractiveMode.prototype as unknown as Pick<PendingDisplay, "updatePendingMessagesDisplay">;
		const original = prototype.updatePendingMessagesDisplay;
		if (typeof original !== "function") {
			ctx.ui.notify("pi-queue-message does not support this Pi pending-message display.", "error");
			return;
		}
		let view: PendingDisplay | undefined;
		let queue: ReturnType<typeof createMessageQueue> | undefined;
		let restoreCompaction: (() => void) | undefined;
		let stopped = false;
		let disabled = false;

		function editorFocused(display: PendingDisplay): boolean {
			const ui = display.ui;
			if (!("getFocusedComponent" in ui) || typeof ui.getFocusedComponent !== "function") return false;
			return ui.getFocusedComponent() === display.editor && !display.editor.capturesViewportInput;
		}

		function disable(error: unknown) {
			disabled = true;
			queue?.dispose();
			restoreCompaction?.();
			ctx.ui.setWidget("pi-queue-message", undefined);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}

		function attach(display: PendingDisplay) {
			if (view) return;
			if (!Array.isArray(display.compactionQueuedMessages)
				|| typeof display.getAllQueuedMessages !== "function"
				|| typeof display.queueCompactionMessage !== "function"
				|| typeof display.restoreQueuedMessagesToEditor !== "function") {
				throw new Error("pi-queue-message does not support this Pi pending-message display.");
			}
			const controller = createMessageQueue(display.session, () => display.compactionQueuedMessages);
			const enqueue = display.queueCompactionMessage;
			const enqueueCompaction = (text: string, mode: DeliveryMode) => enqueue.call(display, text, controller.modeForNewMessage(mode));
			display.queueCompactionMessage = enqueueCompaction;
			restoreCompaction = () => { if (display.queueCompactionMessage === enqueueCompaction) display.queueCompactionMessage = enqueue; };
			queue = controller;
			view = display;
		}

		function updatePending(this: PendingDisplay) {
			const active = !stopped && !disabled && this.session.sessionManager.getSessionId() === ctx.sessionManager.getSessionId();
			if (active) {
				try { attach(this); } catch (error) { disable(error); }
			}
			original.call(this);
			if (!active || disabled || !queue) return;
			const pending = this.getAllQueuedMessages();
			if (pending.steering.length + pending.followUp.length === 0) {
				ctx.ui.setWidget("pi-queue-message", undefined);
				return;
			}
			const display = this;
			ctx.ui.setWidget("pi-queue-message", (_ui, theme) => {
				const toggle = theme.style("tab", { fg: "text", bold: true }) + theme.fg("dim", " toggle steering or follow up");
				const sendKey = process.platform === "darwin" ? "option+s" : "alt+s";
				const send = theme.style(sendKey, { fg: "text", bold: true }) + theme.fg("dim", " force send");
				const hint = new Text("", 0, 0);
				return {
					render(width: number) {
						if (stopped || disabled || !queue?.canToggle || queue.isForcing || !editorFocused(display)) return [];
						hint.setText(display.editor.getText() === "" ? `${toggle}  ${send}` : send);
						return hint.render(width);
					},
					invalidate() { hint.invalidate(); },
				};
			}, { placement: "aboveEditor" });
		}
		prototype.updatePendingMessagesDisplay = updatePending;
		forceSend = async () => {
			if (stopped || disabled || !view || !queue || !editorFocused(view)) return;
			try { await queue.forceSend(); }
			catch (error) {
				if (!stopped) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		};

		const removeInput = ctx.ui.onTerminalInput(data => {
			if (stopped || disabled || !view || !queue || !editorFocused(view)) return;
			if (matchesKey(data, "escape") && queue.isForcing) {
				queue.cancelForce();
				view.restoreQueuedMessagesToEditor({ abort: !view.session.isIdle });
				return { consume: true };
			}
			if (!matchesKey(data, "tab") || view.editor.getText() !== "") return;
			try {
				if (queue.toggle()) return { consume: true };
			} catch (error) {
				disable(error);
				view.updatePendingMessagesDisplay();
				view.ui.requestRender();
				return { consume: true };
			}
		});
		cleanup = () => {
			stopped = true;
			forceSend = undefined;
			removeInput();
			queue?.dispose();
			restoreCompaction?.();
			ctx.ui.setWidget("pi-queue-message", undefined);
			if (prototype.updatePendingMessagesDisplay === updatePending) prototype.updatePendingMessagesDisplay = original;
			if (view) { view.updatePendingMessagesDisplay(); view.ui.requestRender(); }
		};
	});

	pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; });
}
