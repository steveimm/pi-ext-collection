import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createMessageQueue } from "../queue.ts";

async function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-queue-test-"));
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, disabledBuiltinExtensions: ["mcp"],
		noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
	});
	let session;
	let queue;
	const compaction = [];
	t.after(() => {
		queue?.dispose();
		session?.clearQueue();
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	await resourceLoader.reload();
	({ session } = await createAgentSession({
		cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [],
	}));
	const originalSteer = session._queueSteer;
	const originalFollowUp = session._queueFollowUp;
	queue = createMessageQueue(session, () => compaction);
	return { session, queue, compaction, originalSteer, originalFollowUp };
}

test("all user messages toggle together and later messages inherit the mode", async t => {
	const { session, queue } = await setup(t);
	await session.steer("first");
	await session.steer("second");
	const originals = [...session.agent.steeringQueue.messages];
	assert.equal(queue.mode, "steer");
	assert.equal(queue.toggle(), true);
	assert.deepEqual(session.getSteeringMessages(), []);
	assert.deepEqual(session.getFollowUpMessages(), ["first", "second"]);
	assert.equal(session.agent.followUpQueue.messages[0], originals[0]);
	assert.equal(session.agent.followUpQueue.messages[1], originals[1]);
	await session.steer("third");
	assert.deepEqual(session.getFollowUpMessages(), ["first", "second", "third"]);
	queue.toggle();
	assert.deepEqual(session.getSteeringMessages(), ["first", "second", "third"]);
	assert.deepEqual(session.getFollowUpMessages(), []);
	await session.steer("fourth");
	assert.deepEqual(session.getSteeringMessages(), ["first", "second", "third", "fourth"]);
});

test("duplicate text, image attachments, and background notifications retain their identities", async t => {
	const { session, queue } = await setup(t);
	const image = { type: "image", mimeType: "image/png", data: "test-image" };
	await session.steer("same");
	await session.steer("same", [image]);
	const users = [...session.agent.steeringQueue.messages];
	const steeringNotice = { role: "custom", customType: "notice-a", content: "a", display: false, timestamp: Date.now() };
	const followUpNotice = { role: "custom", customType: "notice-b", content: "b", display: false, timestamp: Date.now() };
	session.agent.steer(steeringNotice);
	session.agent.followUp(followUpNotice);
	queue.toggle();
	assert.deepEqual(session.agent.steeringQueue.messages, [steeringNotice]);
	assert(session.agent.followUpQueue.messages.includes(followUpNotice));
	const moved = session.agent.followUpQueue.messages.filter(message => message.role === "user");
	assert.equal(moved[0], users[0]);
	assert.equal(moved[1], users[1]);
	assert.equal(moved[1].content[1], image);
	assert(session._queuedMessagesWithImages.has(moved[1]));
	queue.toggle();
	assert.deepEqual(session.agent.followUpQueue.messages, [followUpNotice]);
	assert(session.agent.steeringQueue.messages.includes(steeringNotice));
});

test("already-consumed messages are not requeued when their display labels remain", async t => {
	const { session, queue } = await setup(t);
	await session.steer("same");
	await session.steer("same");
	const consumed = session.agent.steeringQueue.messages.shift();
	const waiting = session.agent.steeringQueue.messages[0];
	queue.toggle();
	assert.deepEqual(session.getSteeringMessages(), ["same"]);
	assert.deepEqual(session.getFollowUpMessages(), ["same"]);
	assert.deepEqual(session.agent.steeringQueue.messages, []);
	assert.equal(session.agent.followUpQueue.messages[0], waiting);
	assert(!session.agent.followUpQueue.messages.includes(consumed));
});

test("clearing the queues resets steering and disposal restores native enqueue methods", async t => {
	const { session, queue, originalSteer, originalFollowUp } = await setup(t);
	await session.steer("first");
	queue.toggle();
	assert.deepEqual(session.clearQueue(), { steering: [], followUp: ["first"] });
	assert.equal(queue.mode, "steer");
	assert.equal(queue.toggle(), false);
	await session.steer("after clear");
	assert.deepEqual(session.getSteeringMessages(), ["after clear"]);
	queue.toggle();
	queue.dispose();
	assert.equal(session._queueSteer, originalSteer);
	assert.equal(session._queueFollowUp, originalFollowUp);
	await session.steer("native");
	assert.deepEqual(session.getSteeringMessages(), ["native"]);
	assert.deepEqual(session.getFollowUpMessages(), ["after clear"]);
});

test("messages held during compaction inherit the mode and toggle with the session queue", async t => {
	const { session, queue, compaction } = await setup(t);
	await session.steer("before compaction");
	queue.toggle();
	compaction.push({ text: "during compaction", mode: queue.modeForNewMessage("steer") });
	assert.equal(compaction[0].mode, "followUp");
	queue.toggle();
	assert.deepEqual(session.getSteeringMessages(), ["before compaction"]);
	assert.equal(compaction[0].mode, "steer");
	session.clearQueue();
	assert.equal(queue.canToggle, true);
	queue.toggle();
	assert.equal(compaction[0].mode, "followUp");
	compaction.length = 0;
	assert.equal(queue.mode, "steer");
});

test("an unsupported queue or mismatched display fails before moving messages", async t => {
	const { session, queue, originalSteer } = await setup(t);
	await session.steer("first");
	const messages = session.agent.steeringQueue.messages;
	session._steeringMessages = [];
	assert.throws(() => queue.toggle(), /out of sync/);
	assert.equal(session.agent.steeringQueue.messages, messages);
	assert.deepEqual(session.agent.followUpQueue.messages, []);
	queue.dispose();
	const nativeQueue = session.agent.followUpQueue;
	try {
		session.agent.followUpQueue = undefined;
		assert.throws(() => createMessageQueue(session, () => []), /does not support/);
		assert.equal(session._queueSteer, originalSteer);
	} finally {
		session.agent.followUpQueue = nativeQueue;
	}
});
