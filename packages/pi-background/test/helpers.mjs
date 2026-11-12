import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

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

export function assertKeyHints(line, keys) {
	assert(line, "The key hints were not rendered.");
	const text = stripTerminalSequences(line);
	assert.doesNotMatch(text, /\bto\b/);
	let bold = false;
	const styles = [];
	for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
		if (!part.startsWith("\x1b[")) {
			styles.push(...Array(part.length).fill(bold));
			continue;
		}
		const codes = part.slice(2, -1).split(";").map(Number);
		for (let index = 0; index < codes.length; index++) {
			const code = codes[index];
			if (code === 38 || code === 48 || code === 58) index += codes[index + 1] === 2 ? 4 : 2;
			else if (code === 0 || code === 22) bold = false;
			else if (code === 1) bold = true;
		}
	}
	for (const key of keys) {
		const index = text.indexOf(key);
		assert(index >= 0 && styles.slice(index, index + key.length).every(Boolean), `${key} must be bold.`);
		assert.equal(styles[index + key.length + 1], false, `The action after ${key} must use normal weight.`);
	}
}
