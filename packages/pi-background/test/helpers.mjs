export { until, assertKeyHints } from "../../../test/helpers.mjs";

export function backgroundUpdates(events) {
	return events.filter(event => event.type === "message_end" && event.message?.customType === "pi-background")
		.flatMap(event => event.message.details.events);
}
