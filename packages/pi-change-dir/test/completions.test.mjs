import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { directorySuggestions, registerDirectoryCompletions } from "../completions.ts";

function setup(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cd-completion-")));
	for (const path of ["alpha/child", "alpine", "space dir/nested folder", ".hidden"]) mkdirSync(join(root, path), { recursive: true });
	writeFileSync(join(root, "file.txt"), "file");
	symlinkSync(join(root, "alpha"), join(root, "alias"), "dir");
	symlinkSync(join(root, "file.txt"), join(root, "file-link"));
	symlinkSync(join(root, "missing"), join(root, "broken"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function provider(cwd, current = {}) {
	let start;
	let factory;
	registerDirectoryCompletions({ on: (_event, handler) => { start = handler; } });
	start({}, { mode: "tui", cwd, ui: { addAutocompleteProvider: value => { factory = value; } } });
	return factory(current);
}

test("directory completion lists only directories and resolves relative, absolute, home, and partial paths", async t => {
	const root = setup(t);
	const items = await directorySuggestions("", root);
	assert.deepEqual(items.map(item => item.label), [".hidden/", "alias/", "alpha/", "alpine/", "space dir/"]);
	assert(items.every(item => Object.keys(item).sort().join(",") === "label,value"));
	assert.deepEqual(await directorySuggestions("al", root), [
		{ label: "alias/", value: "alias/" }, { label: "alpha/", value: "alpha/" }, { label: "alpine/", value: "alpine/" },
	]);
	for (const prefix of ["alpha", "alpha/", "./alpha/", join(root, "alpha"), `~/${relative(homedir(), join(root, "alpha"))}/`]) {
		const expected = `${prefix.endsWith("/") ? prefix : `${prefix}/`}child/`;
		assert.deepEqual(await directorySuggestions(prefix, root), [{ label: "child/", value: expected }]);
	}
	assert.deepEqual(await directorySuggestions("../alp", join(root, "alpha")), [
		{ label: "alpha/", value: "../alpha/" }, { label: "alpine/", value: "../alpine/" },
	]);
	assert.deepEqual(await directorySuggestions("alias/", root), [{ label: "child/", value: "alias/child/" }]);
	for (const prefix of ["missing/", "file.txt/", "broken/"]) assert.deepEqual(await directorySuggestions(prefix, root), []);
	const locked = join(root, "locked");
	mkdirSync(locked);
	chmodSync(locked, 0);
	try { assert.deepEqual(await directorySuggestions("locked/", root), []); }
	finally { chmodSync(locked, 0o700); }
});

test("Tab completion preserves quoted paths and continues inside directories containing spaces", async t => {
	const root = setup(t);
	const completion = provider(root);
	const options = { force: true, signal: new AbortController().signal };
	for (const quote of ["", '"', "'"]) {
		const input = `/cd ${quote}space d`;
		const suggestions = await completion.getSuggestions([input], 0, input.length, options);
		assert.equal(suggestions.items.length, 1);
		const first = completion.applyCompletion([input], 0, input.length, suggestions.items[0], suggestions.prefix);
		const delimiter = quote || '"';
		assert.equal(first.lines[0], `/cd ${delimiter}space dir/${delimiter}`);
		assert.equal(first.cursorCol, first.lines[0].length - 1);
		const children = await completion.getSuggestions(first.lines, 0, first.cursorCol, options);
		const second = completion.applyCompletion(first.lines, 0, first.cursorCol, children.items[0], children.prefix);
		assert.equal(second.lines[0], `/cd ${delimiter}space dir/nested folder/${delimiter}`);
	}
});

test("the provider handles explicit cd completion and leaves other completion providers in control elsewhere", async t => {
	const root = setup(t);
	const delegated = [];
	const current = {
		triggerCharacters: ["#"],
		getSuggestions: (...args) => { delegated.push(args); return null; },
		applyCompletion: () => "delegated",
		shouldTriggerFileCompletion: () => false,
	};
	const completion = provider(root, current);
	const options = { signal: new AbortController().signal };
	assert.deepEqual(completion.triggerCharacters, ["#"]);
	assert.equal(await completion.getSuggestions(["/cd "], 0, 4, options), null);
	assert((await completion.getSuggestions(["/cd "], 0, 4, { ...options, force: true })).items.length > 0);
	assert.equal(completion.shouldTriggerFileCompletion(["/cd "], 0, 4), true);
	for (const input of ["/cd", "/cd-other ", "@file", "#issue", "/model "]) {
		await completion.getSuggestions([input], 0, input.length, options);
		assert.equal(completion.applyCompletion([input], 0, input.length, {}, ""), "delegated");
		assert.equal(completion.shouldTriggerFileCompletion([input], 0, input.length), false);
	}
	assert.equal(delegated.length, 5);
	assert.equal(await completion.getSuggestions(["/cd "], 0, 4, { force: true, signal: AbortSignal.abort() }), null);
	const switched = provider(join(root, "alpha"));
	assert.deepEqual((await switched.getSuggestions(["/cd "], 0, 4, { ...options, force: true })).items,
		[{ label: "child/", value: "child/" }]);
});
