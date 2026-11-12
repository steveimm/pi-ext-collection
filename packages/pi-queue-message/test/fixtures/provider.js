import { rmSync, writeFileSync } from "node:fs";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { messageText } from "../helpers.mjs";

export default function (pi) {
	let active;
	const original = InteractiveMode.prototype.updatePendingMessagesDisplay;
	function capture() { active = this; return original.call(this); }
	InteractiveMode.prototype.updatePendingMessagesDisplay = capture;
	pi.on("session_shutdown", () => {
		if (InteractiveMode.prototype.updatePendingMessagesDisplay === capture) InteractiveMode.prototype.updatePendingMessagesDisplay = original;
	});
	pi.on("session_start", () => writeFileSync("commands.json", JSON.stringify(pi.getCommands().map(command => command.name))));
	pi.on("agent_start", () => rmSync("settled", { force: true }));
	pi.on("agent_settled", () => writeFileSync("settled", ""));
	pi.registerShortcut("ctrl+y", { handler: ctx => {
		writeFileSync("snapshot.json", JSON.stringify({
			text: ctx.ui.getEditorText(), steering: active.session.getSteeringMessages(), followUp: active.session.getFollowUpMessages(),
			compaction: active.compactionQueuedMessages,
			customSteer: active.session.agent.steeringQueue.messages.filter(message => message.role === "custom").map(message => message.customType),
			customFollow: active.session.agent.followUpQueue.messages.filter(message => message.role === "custom").map(message => message.customType),
		}));
		ctx.ui.setEditorText("");
	} });
	pi.registerCommand("test-mixed", { handler: async () => {
		await active.session.constructor.prototype._queueSteer.call(active.session, "FORCED_STEER");
		await active.session.constructor.prototype._queueFollowUp.call(active.session, "FORCED_FOLLOW");
	} });
	pi.registerCommand("test-compaction", { handler: args => active.queueCompactionMessage(args, "steer") });
	pi.registerCommand("test-notifications", { handler: () => {
		pi.sendMessage({ customType: "background-steer", content: "BG_STEER", display: false }, { deliverAs: "steer", triggerTurn: true });
		pi.sendMessage({ customType: "background-follow", content: "BG_FOLLOW", display: false }, { deliverAs: "followUp", triggerTurn: true });
	} });
	pi.registerProvider("queue-test", {
		baseUrl: "https://unused.invalid", apiKey: "test-only", api: "queue-test",
		models: [{ id: "test", name: "Queue test", reasoning: false, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const results = context.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId);
			const final = context.messages.some(message => message.role === "assistant" && messageText(message) === "ORIGINAL_FINAL");
			const latestUser = context.messages.filter(message => message.role === "user").at(-1);
			let content;
			if (messageText(latestUser) === "BLOCK" && !results.includes("reset")) {
				content = [{ type: "toolCall", id: "reset", name: "bash", arguments: {
					command: "touch started-reset; while [ ! -f release-reset ]; do sleep .05; done; printf reset",
				} }];
			} else if (final) {
				content = [{ type: "text", text: `FOLLOWUP_DONE:${messageText(latestUser)}` }];
			} else if (!results.includes("first-a") || !results.includes("first-b")) {
				content = ["a", "b"].map(stage => ({ type: "toolCall", id: `first-${stage}`, name: "bash", arguments: {
					command: `touch started-${stage}; while [ ! -f release-${stage} ]; do sleep .05; done; printf done-${stage}`,
				} }));
			} else if (!results.includes("second")) {
				content = [{ type: "toolCall", id: "second", name: "bash", arguments: {
					command: "touch started-second; while [ ! -f release-second ]; do sleep .05; done; printf second",
				} }];
			} else content = [{ type: "text", text: "ORIGINAL_FINAL" }];
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
			};
			setTimeout(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			}, 10);
			return stream;
		},
	});
	pi.registerCommand("test-image", { handler: args => pi.sendUserMessage([
		{ type: "text", text: args },
		{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
	], { deliverAs: "steer" }) });
	pi.registerCommand("test-dialog", { handler: async (_args, ctx) => { await ctx.ui.select("Test dialog", ["One", "Two"]); } });
	pi.registerCommand("test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
}
