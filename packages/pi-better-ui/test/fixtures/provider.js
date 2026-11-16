import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
	let active;
	const original = InteractiveMode.prototype.addMessageToChat;
	function capture(...args) { active = this; return original.apply(this, args); }
	InteractiveMode.prototype.addMessageToChat = capture;
	pi.on("session_shutdown", () => {
		if (InteractiveMode.prototype.addMessageToChat === capture) InteractiveMode.prototype.addMessageToChat = original;
	});
	pi.on("agent_start", () => rmSync("settled", { force: true }));
	pi.on("agent_settled", () => writeFileSync("settled", ""));
	pi.registerCommand("test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
	pi.registerCommand("test-mode", { handler: args => active.switchTuiMode(args) });
	pi.registerCommand("test-legacy-timing", { handler: async () => {
		pi.sendMessage({ customType: "pi-better-ui/worked", content: "Worked for 999s • 9:15 PM", display: true });
	} });
	pi.registerCommand("test-branch-summary", { handler: async (_args, ctx) => {
		const target = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
		await ctx.navigateTree(target.id, { summarize: true });
		writeFileSync("branch-summarized", "");
	} });
	pi.registerShortcut("ctrl+y", { handler: ctx => {
		writeFileSync("ui-state.json", JSON.stringify({ mode: active.ui.mode, text: ctx.ui.getEditorText(), scrollTop: active.transcriptScrollView.scrollTop }));
	} });
	pi.registerProvider("better-ui-test", {
		baseUrl: "https://unused.invalid", apiKey: "fixture", api: "better-ui-test",
		models: [{ id: "test", name: "UI test", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			appendFileSync("requests.jsonl", `${JSON.stringify(context.messages)}\n`);
			const latest = context.messages.filter(message => message.role === "user").at(-1);
			const text = typeof latest.content === "string" ? latest.content : latest.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			const summarizing = context.messages.some(item => item.role === "system"
				&& typeof item.content === "string" && item.content.startsWith("You are a context summarization assistant."));
			const name = summarizing ? "SUMMARY" : text.split(" ")[0];
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "" }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const toolDone = context.messages.some(item => item.role === "toolResult" && item.toolCallId === "timed-tool");
			let interval;
			function finish(aborted = false) {
				clearInterval(interval);
				options.signal.removeEventListener("abort", abort);
				if (aborted) {
					message.stopReason = "aborted";
					message.errorMessage = "Request aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
				} else {
					if (name === "TOOLS" && !toolDone) {
						message.content = [{ type: "toolCall", id: "timed-tool", name: "bash", arguments: { command: "sleep 1; printf tool-done" } }];
						message.stopReason = "toolUse";
					} else {
						message.content = [{ type: "text", text: summarizing ? "Fixture summary." : Array.from({ length: 100 }, (_, i) => `${name}_ANSWER_${i + 1}`).join("\n\n") }];
						stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
					}
					stream.push({ type: "done", reason: message.stopReason, message });
				}
				stream.end();
			}
			const abort = () => finish(true);
			setTimeout(() => {
				stream.push({ type: "start", partial: message });
				writeFileSync(`started-${name}`, "");
				if (options.signal.aborted) return abort();
				options.signal.addEventListener("abort", abort, { once: true });
				if (summarizing) return finish();
				interval = setInterval(() => { if (existsSync(`release-${name}`)) finish(); }, 20);
			}, 10);
			return stream;
		},
	});
}
