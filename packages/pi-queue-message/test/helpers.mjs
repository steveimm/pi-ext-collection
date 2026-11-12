export function messageText(message) {
	return typeof message.content === "string" ? message.content
		: (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
}
