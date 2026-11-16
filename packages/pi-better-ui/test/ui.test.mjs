import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { ScrollView, stripTerminalSequences, Text, TuiAltScreen, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { attachStickyPrompt, findPrompts, promptAbove } from "../sticky.ts";
import { completionText, formatDuration, registerTiming, timingMessageType } from "../timing.ts";

const { renderLayoutFrame } = await import(new URL("./layout.js", import.meta.resolve("@earendil-works/pi-tui")));
const begin = "\x1b]133;A\x07";
const end = "\x1b]133;B\x07\x1b]133;C\x07";

function viewport(t, source) {
	let renders = 0;
	const document = { render: width => {
		renders++;
		const lines = source(width);
		document.mouseLayout = { children: lines.map(line => ({ component: line.startsWith(begin) ? Object.create(UserMessageComponent.prototype) : {}, height: 1 })) };
		return lines;
	}, invalidate() {} };
	const originalRender = document.render;
	const scroll = new ScrollView(document, { primary: true, follow: "end" });
	const originalLayout = scroll.updateLayout;
	const base = new VStack([{ component: scroll, basis: 0, grow: 1 }, new Text("INPUT", 0, 0)]);
	const terminal = { columns: 40, rows: 10, write() {} };
	const tui = new TuiAltScreen(terminal);
	let dirty = false;
	tui.requestRender = () => { dirty = true; };
	tui.setLayoutRoot(base);
	const attached = attachStickyPrompt(tui, base, scroll, () => ({ bg: (_color, text) => text, fg: (_color, text) => text }));
	t.after(() => attached.dispose());
	return {
		document, scroll, terminal, attached, tui, base, originalRender, originalLayout,
		frame() {
			for (let attempt = 0; attempt < 5; attempt++) {
				dirty = false;
				const before = renders;
				const frame = renderLayoutFrame(tui.layoutRoot, terminal.columns, terminal.rows, () => { dirty = true; });
				assert.equal(renders - before, 1, "The transcript should render once per frame.");
				if (!dirty) return frame;
			}
			throw new Error("Sticky header layout did not settle.");
		},
	};
}

test("prompt selection follows the first visible answer and hides while its prompt is visible", () => {
	const user = () => Object.create(UserMessageComponent.prototype);
	const document = { mouseLayout: { children: [
		{ component: {}, height: 1 }, { component: user(), height: 3 }, { component: {}, height: 1 },
		{ component: user(), height: 1 }, { component: {}, height: 1 },
	] } };
	const prompts = findPrompts(document, ["header", begin + " ", "First\tquestion", " " + end, "answer", begin + "Second question" + end, begin + "assistant" + end]);
	assert.equal(prompts.length, 2);
	assert.equal(promptAbove(prompts, 0), undefined);
	assert.equal(promptAbove(prompts, 2), undefined);
	assert.equal(promptAbove(prompts, 4), "First question");
	assert.equal(promptAbove(prompts, 5), undefined);
	assert.equal(promptAbove(prompts, 6), "Second question");
});

test("the header stays hidden when reserving its row would move a new prompt to the top", t => {
	const lines = [begin + "First question" + end, ...Array.from({ length: 10 }, (_, i) => `First answer ${i}`),
		begin + "Second question" + end, ...Array.from({ length: 7 }, (_, i) => `Second answer ${i}`)];
	const v = viewport(t, () => [...lines]);
	const frame = v.frame();
	assert.equal(frame.lines[0], "First answer 9");
	assert(!frame.lines[0].includes("›"));
});

test("fullscreen layout reserves a header row without replacing or copying transcript content", t => {
	const lines = [begin + "First question" + end, ...Array.from({ length: 15 }, (_, i) => `First answer ${i}`),
		begin + "Second question" + end, ...Array.from({ length: 15 }, (_, i) => `Second answer ${i}`)];
	const v = viewport(t, () => [...lines]);
	assert.match(v.frame().lines[0], /› Second question/);
	v.scroll.scrollTo(5);
	let frame = v.frame();
	assert.match(frame.lines[0], /› First question/);
	assert.equal(frame.lines[1], "First answer 4");
	assert.equal(frame.primaryScrollView, v.scroll);
	assert.deepEqual(v.document.render(40), lines);
	v.scroll.scrollTo(16);
	frame = v.frame();
	assert.equal(stripTerminalSequences(frame.lines[0]), "Second question");
	v.scroll.scrollToStart();
	assert.equal(stripTerminalSequences(v.frame().lines[0]), "First question");
	v.attached.dispose();
	assert.equal(v.tui.layoutRoot, v.base);
	assert.equal(v.document.render, v.originalRender);
	assert.equal(v.scroll.updateLayout, v.originalLayout);
});

test("sticky prompts handle live growth, narrow windows, long Unicode input, and cleared history", t => {
	let lines = [begin + "Long question 한글😀 ".repeat(1000) + end, "short answer"];
	const v = viewport(t, () => [...lines]);
	assert(!v.frame().lines[0].includes("›"));
	lines.push(...Array.from({ length: 50 }, (_, i) => `answer ${i}`));
	assert.match(v.frame().lines[0], /› Long question/);
	v.terminal.columns = 24;
	const narrow = v.frame().lines[0];
	assert(visibleWidth(narrow) <= 24);
	assert.match(stripTerminalSequences(narrow), /…$/u);
	v.terminal.columns = 12;
	assert(!v.frame().lines[0].includes("›"));
	v.terminal.columns = 40;
	lines = ["New session"];
	assert.equal(v.frame().lines[0], "New session");
});

test("duration and completion labels use the requested units and local clock", () => {
	for (const [ms, text] of [[100, "0s"], [15_999, "15s"], [60_000, "1m 0s"], [125_000, "2m 5s"], [3_605_000, "1h 0m 5s"]]) {
		assert.equal(formatDuration(ms), text);
	}
	assert.equal(completionText(15_000, new Date(2026, 10, 16, 21, 15)), "Worked for 15s • 9:15 PM");
});

test("working duration spans repeated agent starts and records one display-only completion", t => {
	let now = 0;
	let update;
	const intervals = [];
	const cleared = [];
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setInterval", callback => { update = callback; const timer = { unref() {} }; intervals.push(timer); return timer; });
	t.mock.method(globalThis, "clearInterval", timer => cleared.push(timer));
	const events = new Map();
	const sent = [];
	const working = [];
	registerTiming({
		on: (type, handler) => events.set(type, handler), registerMessageRenderer() {}, sendMessage: (...args) => sent.push(args),
	});
	const ctx = { mode: "tui", ui: { setWorkingMessage: value => working.push(value) } };
	events.get("agent_start")({}, ctx);
	assert.equal(working[0], "Working • 0s");
	now = 1500;
	update();
	assert.equal(working.at(-1), "Working • 1s");
	events.get("agent_start")({}, ctx);
	now = 3200;
	events.get("agent_settled")({ aborted: false }, ctx);
	events.get("agent_settled")({ aborted: false }, ctx);
	assert.equal(intervals.length, 1);
	assert.equal(sent.length, 1);
	assert.match(sent[0][0].content, /^Worked for 3s • /);
	assert.equal(sent[0][0].details.durationMs, 3200);
	assert.equal(sent[0][0].display, true);
	assert.equal(sent[0][1].triggerTurn, false);
	assert.equal(working.at(-1), undefined);
	assert.deepEqual(cleared, intervals);
	const user = { role: "user", content: "hello" };
	const notice = { role: "custom", customType: "other", content: "keep" };
	assert.deepEqual(events.get("context")({ messages: [user, { role: "custom", customType: timingMessageType }, notice] }).messages, [user, notice]);

	events.get("agent_start")({}, ctx);
	events.get("session_shutdown")({}, ctx);
	update();
	assert.equal(sent.length, 1);
	assert.equal(cleared.length, 2);
	events.get("agent_start")({}, { ...ctx, mode: "rpc" });
	assert.equal(intervals.length, 2);
});
