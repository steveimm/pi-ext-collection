import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

export async function until(predicate, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		assert(Date.now() < deadline, "Timed out waiting for the background result.");
		await sleep(25);
	}
}

export function backgroundUpdates(events) {
	return events.filter(event => event.type === "message_end" && event.message?.customType === "pi-background")
		.flatMap(event => event.message.details.events);
}
