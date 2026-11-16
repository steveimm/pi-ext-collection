import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type DeliveryMode = "steer" | "followUp";
export type CompactionMessage = { text: string; mode: DeliveryMode };
type QueuedMessage = Parameters<AgentSession["agent"]["followUp"]>[0];
type Images = Parameters<AgentSession["steer"]>[1];
type Enqueue = (text: string, images?: Images) => Promise<void>;
type PreparedPrompt = { messageType: "user"; prompt: string; images?: Images };

interface QueueState {
	agent: {
		steeringQueue: { messages: QueuedMessage[] };
		followUpQueue: { messages: QueuedMessage[] };
	};
	_steeringMessages: string[];
	_followUpMessages: string[];
	_queueSteer: Enqueue;
	_queueFollowUp: Enqueue;
	_emitQueueUpdate(): void;
	_queuedMessagesWithImages: WeakSet<QueuedMessage>;
	_preparePrompt(text: string, options: { source: "interactive" }): Promise<PreparedPrompt | undefined>;
	_startRun(prompt: PreparedPrompt, onStarted: () => void): Promise<void>;
}

// Pi has no public API for changing delivery mode on already-queued messages.
function queueState(session: AgentSession): QueueState {
	const state = session as unknown as QueueState;
	if (!Array.isArray(state.agent?.steeringQueue?.messages)
		|| !Array.isArray(state.agent.followUpQueue?.messages)
		|| !Array.isArray(state._steeringMessages)
		|| !Array.isArray(state._followUpMessages)
		|| typeof state._queueSteer !== "function"
		|| typeof state._queueFollowUp !== "function"
		|| typeof state._emitQueueUpdate !== "function"
		|| typeof state._preparePrompt !== "function"
		|| typeof state._startRun !== "function"
		|| typeof state._queuedMessagesWithImages?.add !== "function") {
		throw new Error("pi-queue-message does not support this Pi queue implementation.");
	}
	return state;
}

function messageText(message: QueuedMessage): string {
	if (message.role !== "user") throw new Error("Expected a queued user message.");
	return typeof message.content === "string" ? message.content
		: message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function inFlightLabels(labels: string[], messages: QueuedMessage[]): string[] {
	const remaining = [...labels];
	for (let index = messages.length - 1; index >= 0; index--) {
		const label = remaining.lastIndexOf(messageText(messages[index]!));
		if (label === -1) throw new Error("Pi's pending-message display is out of sync. No messages were moved.");
		remaining.splice(label, 1);
	}
	return remaining;
}

export function createMessageQueue(session: AgentSession, compactionMessages: () => CompactionMessage[]) {
	const state = queueState(session);
	const originalSteer = state._queueSteer;
	const originalFollowUp = state._queueFollowUp;
	let disposed = false;
	let force: { cancel(): void } | undefined;
	let delivery: DeliveryMode = state._steeringMessages.length ? "steer"
		: state._followUpMessages.length ? "followUp" : compactionMessages()[0]?.mode ?? "steer";

	function count(): number {
		return state._steeringMessages.length + state._followUpMessages.length + compactionMessages().length;
	}

	function modeForNewMessage(requested: DeliveryMode): DeliveryMode {
		if (disposed) return requested;
		if (count() === 0) delivery = requested;
		return delivery;
	}

	function enqueue(requested: DeliveryMode, text: string, images?: Images): Promise<void> {
		const original = modeForNewMessage(requested) === "steer" ? originalSteer : originalFollowUp;
		return original.call(session, text, images);
	}

	const steer: Enqueue = (text, images) => enqueue("steer", text, images);
	const followUp: Enqueue = (text, images) => enqueue("followUp", text, images);
	state._queueSteer = steer;
	state._queueFollowUp = followUp;

	return {
		get isForcing(): boolean { return force !== undefined; },
		get mode(): DeliveryMode {
			if (count() === 0) delivery = "steer";
			return delivery;
		},
		get canToggle(): boolean {
			return state.agent.steeringQueue.messages.some(message => message.role === "user")
				|| state.agent.followUpQueue.messages.some(message => message.role === "user")
				|| compactionMessages().length > 0;
		},
		modeForNewMessage,
		cancelForce() { force?.cancel(); },
		async forceSend(): Promise<boolean> {
			if (disposed || force || !this.canToggle) return false;
			const held = [
				...state.agent.steeringQueue.messages.filter(message => message.role === "user").map(message => ({ message, mode: "steer" as const })),
				...state.agent.followUpQueue.messages.filter(message => message.role === "user").map(message => ({ message, mode: "followUp" as const })),
			].sort((a, b) => a.message.timestamp - b.message.timestamp);
			const steering = inFlightLabels(state._steeringMessages, held.filter(item => item.mode === "steer").map(item => item.message));
			const followUp = inFlightLabels(state._followUpMessages, held.filter(item => item.mode === "followUp").map(item => item.message));
			const compacted = compactionMessages().splice(0);
			let cancelled = false;
			let restored = false;
			let started = false;
			const sessionId = session.sessionManager.getSessionId();
			function restore() {
				if (restored || started || session.sessionManager.getSessionId() !== sessionId) return;
				restored = true;
				for (const mode of ["steer", "followUp"] as const) {
					const messages = held.filter(item => item.mode === mode).map(item => item.message);
					const target = mode === "steer" ? state.agent.steeringQueue : state.agent.followUpQueue;
					target.messages = [...messages, ...target.messages].sort((a, b) => a.timestamp - b.timestamp);
					const labels = mode === "steer" ? "_steeringMessages" : "_followUpMessages";
					state[labels].unshift(...messages.map(messageText));
				}
				compactionMessages().unshift(...compacted);
				state._emitQueueUpdate();
			}
			const operation = { cancel() { cancelled = true; restore(); } };
			force = operation;
			state.agent.steeringQueue.messages = state.agent.steeringQueue.messages.filter(message => message.role !== "user");
			state.agent.followUpQueue.messages = state.agent.followUpQueue.messages.filter(message => message.role !== "user");
			state._steeringMessages = steering;
			state._followUpMessages = followUp;
			state._emitQueueUpdate();
			try {
				await session.abort();
				if (disposed || cancelled) return false;
				for (const raw of [...compacted]) {
					if (!session.isIdle) throw new Error("Pi started another operation. Queued messages were restored.");
					const prepared = await state._preparePrompt(raw.text, { source: "interactive" });
					if (disposed || cancelled) return false;
					compacted.shift();
					if (prepared) {
						const message: QueuedMessage = {
							role: "user", content: [{ type: "text", text: prepared.prompt }, ...(prepared.images ?? [])], timestamp: Date.now(),
						};
						if (prepared.images?.length) state._queuedMessagesWithImages.add(message);
						held.push({ message, mode: raw.mode });
					}
				}
				if (!held.length) return false;
				if (!session.isIdle) throw new Error("Pi started another operation. Queued messages were restored.");
				if (!session.model) throw new Error("Select a model before sending queued messages.");
				const images = held.flatMap(({ message }) => typeof message.content === "string" ? []
					: message.content.filter(part => part.type === "image"));
				// Queued messages already passed input hooks and template expansion.
				await state._startRun({ messageType: "user", prompt: held.map(item => messageText(item.message)).join("\n\n"), images }, () => {
					started = true;
					if (force === operation) force = undefined;
				});
				return true;
			} catch (error) {
				if (!disposed) restore();
				throw error;
			} finally {
				if (force === operation) force = undefined;
			}
		},
		toggle(): boolean {
			if (disposed || !this.canToggle) return false;
			const target = this.mode === "steer" ? "followUp" : "steer";
			const sourceQueue = target === "followUp" ? state.agent.steeringQueue : state.agent.followUpQueue;
			const targetQueue = target === "followUp" ? state.agent.followUpQueue : state.agent.steeringQueue;
			const sourceKey = target === "followUp" ? "_steeringMessages" : "_followUpMessages";
			const targetKey = target === "followUp" ? "_followUpMessages" : "_steeringMessages";
			const moving = sourceQueue.messages.filter(message => message.role === "user");
			const existing = targetQueue.messages.filter(message => message.role === "user");
			const sourceInFlight = inFlightLabels(state[sourceKey], moving);
			const targetInFlight = inFlightLabels(state[targetKey], existing);
			const combined = [...targetQueue.messages, ...moving].sort((a, b) => a.timestamp - b.timestamp);
			sourceQueue.messages = sourceQueue.messages.filter(message => message.role !== "user");
			targetQueue.messages = combined;
			state[sourceKey] = sourceInFlight;
			state[targetKey] = [...targetInFlight, ...combined.filter(message => message.role === "user").map(messageText)];
			for (const message of compactionMessages()) message.mode = target;
			delivery = target;
			state._emitQueueUpdate();
			return true;
		},
		dispose() {
			force?.cancel();
			disposed = true;
			if (state._queueSteer === steer) state._queueSteer = originalSteer;
			if (state._queueFollowUp === followUp) state._queueFollowUp = originalFollowUp;
		},
	};
}
