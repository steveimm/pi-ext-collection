import type { AgentSession } from "@earendil-works/pi-coding-agent";

type QueuedMessage = Parameters<AgentSession["agent"]["followUp"]>[0];

interface QueueState {
	agent: {
		steeringQueue: { messages: QueuedMessage[] };
		followUpQueue: { messages: QueuedMessage[] };
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
		|| !Array.isArray(state.agent.followUpQueue?.messages)
		|| typeof state.agent.followUp !== "function"
		|| !Array.isArray(state._steeringMessages)
		|| !Array.isArray(state._followUpMessages)
		|| typeof state._emitQueueUpdate !== "function") {
		throw new Error("pi-queue-message does not support this Pi queue implementation.");
	}
	return state;
}

export function hasPending(session: AgentSession): boolean {
	return queueState(session)._steeringMessages.length > 0;
}

export function hasQueued(session: AgentSession): boolean {
	return queueState(session)._followUpMessages.length > 0;
}

function findNewestUser(messages: QueuedMessage[], text: string): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		const content = typeof message.content === "string" ? message.content
			: message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (content === text) return index;
	}
	return -1;
}

export function moveNewestPending(session: AgentSession): boolean {
	const state = queueState(session);
	const text = state._steeringMessages.at(-1);
	if (text === undefined) return false;
	const messages = state.agent.steeringQueue.messages;
	const index = findNewestUser(messages, text);
	if (index === -1) return false;
	state.agent.followUp(messages[index]!);
	messages.splice(index, 1);
	state._steeringMessages.pop();
	state._followUpMessages.push(text);
	state._emitQueueUpdate();
	return true;
}

export function unqueueNewest(session: AgentSession): string | undefined {
	const state = queueState(session);
	const text = state._followUpMessages.at(-1);
	if (text === undefined) return;
	const messages = state.agent.followUpQueue.messages;
	const index = findNewestUser(messages, text);
	if (index === -1) return;
	const message = messages[index]!;
	if (message.role === "user" && typeof message.content !== "string" && message.content.some(part => part.type === "image")) {
		throw new Error("This command cannot restore image attachments to the input. The message is still queued.");
	}
	messages.splice(index, 1);
	state._followUpMessages.pop();
	state._emitQueueUpdate();
	return text;
}
