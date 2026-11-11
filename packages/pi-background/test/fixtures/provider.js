import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
	pi.registerProvider("background-test", {
		baseUrl: "https://unused.invalid", apiKey: "test-only", api: "background-test",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1);
			const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map(part => part.text ?? "").join("");
			const call = last?.role === "user" && text.startsWith("CALL ") ? JSON.parse(text.slice(5)) : undefined;
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: call ? [{ type: "toolCall", id: call.id ?? randomUUID(), name: call.name, arguments: call.arguments }]
					: [{ type: "text", text: text.includes("Background updates.") ? "BACKGROUND_HANDLED" : "REPLY_DONE" }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
			};
			setTimeout(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			}, text === "BUSY" ? 1000 : 10);
			return stream;
		},
	});
	pi.registerCommand("test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
}
