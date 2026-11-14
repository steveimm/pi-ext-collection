import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const prepareScript = fileURLToPath(new URL("../prepare-publish.mjs", import.meta.url));
const workflow = parse(readFileSync(new URL("../../workflows/publish.yml", import.meta.url), "utf8"));
const commitStep = workflow.jobs.publish.steps.find(step => step.name === "Commit and push version bump");

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-publish-test-"));
	const cwd = join(root, "repo");
	const remote = join(root, "origin.git");
	mkdirSync(cwd);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = {
		...process.env, npm_config_cache: join(root, "npm-cache"), npm_config_offline: "true",
		npm_config_audit: "false", npm_config_fund: "false", PACKAGE: "pi-first", GITHUB_REF: "refs/heads/main",
		GITHUB_OUTPUT: join(root, "outputs"), GITHUB_STEP_SUMMARY: join(root, "summary"),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
	};
	writeFileSync(env.GIT_CONFIG_GLOBAL, "");
	function run(command, args, options = {}) {
		return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe", ...options }).trim();
	}
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", private: true, version: "9.0.0", workspaces: ["packages/*"] }));
	writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
	for (const [directory, version] of [["pi-first", "1.2.3"], ["pi-second", "4.5.6"]]) {
		mkdirSync(join(cwd, "packages", directory), { recursive: true });
		writeFileSync(join(cwd, "packages", directory, "package.json"), JSON.stringify({
			name: `@steveimm/${directory}`, version, publishConfig: { access: "public" },
			scripts: { version: "node -e \"require('node:fs').writeFileSync('hook-ran','yes')\"" },
		}));
	}
	run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline"]);
	run("git", ["init", "--bare", remote]);
	run("git", ["init", "-b", "main"]);
	run("git", ["config", "user.name", "Release test"]);
	run("git", ["config", "user.email", "test@example.invalid"]);
	run("git", ["add", "."]);
	run("git", ["commit", "-m", "initial"]);
	run("git", ["remote", "add", "origin", remote]);
	run("git", ["push", "-u", "origin", "main"]);
	const originalHead = run("git", ["rev-parse", "HEAD"]);
	const initialLock = readFileSync(join(cwd, "package-lock.json"), "utf8");
	return {
		root, cwd, remote, env, run, originalHead, initialLock,
		prepare(bump = "none", overrides = {}) {
			return spawnSync(process.execPath, [prepareScript], {
				cwd, env: { ...env, VERSION_BUMP: bump, ...overrides }, encoding: "utf8",
			});
		},
		outputs() {
			return Object.fromEntries(readFileSync(env.GITHUB_OUTPUT, "utf8").trim().split("\n").map(line => line.split("=")));
		},
	};
}

for (const [bump, version] of [["none", "1.2.3"], ["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"]]) {
	test(`${bump} prepares only the selected workspace without committing or pushing`, t => {
		const f = fixture(t);
		const result = f.prepare(bump);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(f.outputs(), { name: "@steveimm/pi-first", version, bumped: String(bump !== "none") });
		const selected = JSON.parse(readFileSync(join(f.cwd, "packages/pi-first/package.json"), "utf8"));
		const lock = JSON.parse(readFileSync(join(f.cwd, "package-lock.json"), "utf8"));
		assert.equal(selected.version, version);
		assert.equal(lock.packages["packages/pi-first"].version, version);
		assert.equal(lock.packages["packages/pi-second"].version, "4.5.6");
		assert.equal(JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8")).version, "9.0.0");
		assert.equal(f.run("git", ["rev-parse", "HEAD"]), f.originalHead);
		assert(f.run("git", ["ls-remote", "origin", "refs/heads/main"]).startsWith(f.originalHead));
		assert.equal(f.run("git", ["tag", "--list"]), "");
		const changed = f.run("git", ["diff", "--name-only"]).split("\n").filter(Boolean).sort();
		assert.deepEqual(changed, bump === "none" ? [] : ["package-lock.json", "packages/pi-first/package.json"]);
		assert(!f.run("git", ["status", "--porcelain"]).includes("hook-ran"));
		if (bump === "none") assert.equal(readFileSync(join(f.cwd, "package-lock.json"), "utf8"), f.initialLock);
		assert(readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8").includes(version));
	});
}

test("invalid bump, branch, and package inputs fail before changing files", t => {
	const f = fixture(t);
	for (const [bump, overrides] of [
		["prerelease", {}], ["patch", { GITHUB_REF: "refs/heads/other" }],
		["patch", { PACKAGE: "../pi-first" }], ["patch", { PACKAGE: "pi-first\n" }],
	]) {
		const result = f.prepare(bump, overrides);
		assert.notEqual(result.status, 0);
		assert.equal(f.run("git", ["status", "--porcelain"]), "");
	}
	symlinkSync(join(f.cwd, "packages/pi-first"), join(f.cwd, "packages/pi-link"));
	const result = f.prepare("patch", { PACKAGE: "pi-link" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlink or file/);
	assert.equal(f.run("git", ["diff", "--name-only"]), "");
});

test("publish checks only the selected package, skips absent tests, and propagates failures", t => {
	const f = fixture(t);
	const rootManifest = join(f.cwd, "package.json");
	const root = JSON.parse(readFileSync(rootManifest, "utf8"));
	root.scripts = { check: "npm run check --workspaces", test: "npm run test --workspaces --if-present" };
	writeFileSync(rootManifest, JSON.stringify(root));
	for (const name of ["pi-first", "pi-second"]) {
		const path = join(f.cwd, "packages", name, "package.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		const script = name === "pi-first"
			? "node -e \"require('node:fs').writeFileSync(process.env.npm_lifecycle_event + '-ran', 'yes')\""
			: "node -e \"process.exit(9)\"";
		manifest.scripts = { check: script, test: script };
		writeFileSync(path, JSON.stringify(manifest));
	}
	function runStep(name) {
		const step = workflow.jobs.publish.steps.find(step => step.name === name);
		assert.equal(step.env.WORKSPACE, "${{ steps.package.outputs.workspace }}");
		return spawnSync("bash", ["-e", "-c", step.run], {
			cwd: f.cwd, encoding: "utf8", env: { ...f.env, WORKSPACE: "packages/pi-first" },
		});
	}
	for (const [step, marker] of [["Check selected package", "check-ran"], ["Test selected package", "test-ran"]]) {
		const result = runStep(step);
		assert.equal(result.status, 0, result.stderr);
		assert(existsSync(join(f.cwd, "packages/pi-first", marker)));
	}
	const selectedPath = join(f.cwd, "packages/pi-first/package.json");
	const selected = JSON.parse(readFileSync(selectedPath, "utf8"));
	delete selected.scripts.test;
	writeFileSync(selectedPath, JSON.stringify(selected));
	assert.equal(runStep("Test selected package").status, 0);
	selected.scripts.test = "node -e \"process.exit(7)\"";
	selected.scripts.check = "node -e \"process.exit(8)\"";
	writeFileSync(selectedPath, JSON.stringify(selected));
	assert.notEqual(runStep("Test selected package").status, 0);
	assert.notEqual(runStep("Check selected package").status, 0);
});

test("the workflow commit step pushes the manifest and lockfile bump together", t => {
	const f = fixture(t);
	assert.equal(f.prepare("patch").status, 0);
	writeFileSync(join(f.cwd, "unrelated.txt"), "must not be committed");
	const result = spawnSync("bash", ["-e", "-c", commitStep.run], {
		cwd: f.cwd, encoding: "utf8", env: {
			...f.env, WORKSPACE: "packages/pi-first", PACKAGE_NAME: "@steveimm/pi-first", PACKAGE_VERSION: "1.2.4",
		},
	});
	assert.equal(result.status, 0, result.stderr);
	const head = f.run("git", ["rev-parse", "HEAD"]);
	assert.notEqual(head, f.originalHead);
	assert(f.run("git", ["ls-remote", "origin", "refs/heads/main"]).startsWith(head));
	assert.deepEqual(f.run("git", ["diff", "HEAD^", "HEAD", "--name-only"]).split("\n").sort(),
		["package-lock.json", "packages/pi-first/package.json"]);
});

test("the workflow stops on a rejected push without overwriting a newer main", t => {
	const f = fixture(t);
	const other = join(f.root, "other");
	f.run("git", ["clone", "--branch", "main", f.remote, other]);
	f.run("git", ["config", "user.name", "Other commit"], { cwd: other });
	f.run("git", ["config", "user.email", "other@example.invalid"], { cwd: other });
	f.run("git", ["commit", "--allow-empty", "-m", "advance main"], { cwd: other });
	f.run("git", ["push", "origin", "main"], { cwd: other });
	const newerHead = f.run("git", ["rev-parse", "HEAD"], { cwd: other });
	assert.equal(f.prepare("minor").status, 0);
	const result = spawnSync("bash", ["-e", "-c", commitStep.run], {
		cwd: f.cwd, encoding: "utf8", env: {
			...f.env, WORKSPACE: "packages/pi-first", PACKAGE_NAME: "@steveimm/pi-first", PACKAGE_VERSION: "1.3.0",
		},
	});
	assert.notEqual(result.status, 0);
	assert(f.run("git", ["ls-remote", "origin", "refs/heads/main"]).startsWith(newerHead));
});
