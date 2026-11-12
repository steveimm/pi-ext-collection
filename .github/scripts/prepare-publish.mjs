import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { selectPackage } from "./validate-publish.mjs";

const selected = selectPackage(process.env.PACKAGE, process.env.GITHUB_REF, process.env.VERSION_BUMP ?? "none");
if (selected.bump !== "none") {
	execFileSync("npm", [
		"version", selected.bump, `--workspace=${selected.workspace}`, "--no-git-tag-version", "--ignore-scripts", "--no-audit", "--no-fund",
	], { stdio: "pipe" });
}

const { version } = JSON.parse(readFileSync(join(selected.workspace, "package.json"), "utf8"));
const bumped = version !== selected.version;
console.log(`Prepared ${selected.name}: ${selected.version} -> ${version} (${selected.bump})`);
if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `name=${selected.name}\nversion=${version}\nbumped=${bumped}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY,
		`Package: \`${selected.name}\`\n\nVersion: \`${selected.version}\` → \`${version}\` (\`${selected.bump}\`)\n`);
}
