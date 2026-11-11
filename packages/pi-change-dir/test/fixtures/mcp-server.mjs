import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [name, log] = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify({ name, event: "start", cwd: process.cwd() })}\n`);

function stop() {
	appendFileSync(log, `${JSON.stringify({ name, event: "stop" })}\n`);
	process.exit(0);
}

process.on("SIGTERM", stop);
process.stdin.on("end", stop);
createInterface({ input: process.stdin }).on("line", line => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result = {};
	if (request.method === "initialize") {
		result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } };
	} else if (request.method === "tools/list") {
		result = { tools: [{ name: "probe", description: "Identify this test server", inputSchema: { type: "object", properties: {} } }] };
	} else if (request.method === "tools/call") {
		result = { content: [{ type: "text", text: name }] };
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
