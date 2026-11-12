import type { AgentSession } from "@earendil-works/pi-coding-agent";

type QueuedMessage = Parameters<AgentSession["agent"]["followUp"]>[0];

interface QueueState {
	agent: {
		steeringQueue: { messages: QueuedMessage[] };
		followUp(message: QueuedMessage): void;
	};
	_steeringMessages: string[];
	_followUpMessages: string[];
	_emitQueueUpdate(): void;
}

// Pi does not expose an API for moving an existing queued message.
function queueState(session: AgentSession): QueueState {
	const state = session as unknown as QueueState;
	if (!Array.isArray(state.agent?.steeringQueue?.messages)
		|| typeof state.agent.followUp !== "function"
		|| !Array.isArray(state._steeringMessages)
		|| !Array.isArray(state._followUpMessages)
		|| typeof state._emitQueueUpdate !== "function") {
		throw new Error("pi-queue-message does not support this Pi queue implementation.");
	}
	return state;
}

export function moveNewestPending(session: AgentSession): boolean {
	const state = queueState(session);
	const text = state._steeringMessages.at(-1);
	if (text === undefined) return false;
	const messages = state.agent.steeringQueue.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		const content = typeof message.content === "string" ? message.content
			: message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (content !== text) continue;
		state.agent.followUp(message);
		messages.splice(index, 1);
		state._steeringMessages.pop();
		state._followUpMessages.push(text);
		state._emitQueueUpdate();
		return true;
	}
	return false;
}
