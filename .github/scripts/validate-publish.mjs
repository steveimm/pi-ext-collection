import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function selectPackage(directory, ref, bump = "none") {
	if (ref !== "refs/heads/main") throw new Error("Run the publish workflow from main.");
	if (!["none", "patch", "minor", "major"].includes(bump)) {
		throw new Error("Version bump must be none, patch, minor, or major.");
	}
	if (typeof directory !== "string" || directory.trim() !== directory || !/^pi-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory)) {
		throw new Error("Enter a package directory name, such as pi-change-dir.");
	}
	const workspace = `packages/${directory}`;
	if (!lstatSync(workspace).isDirectory()) throw new Error(`${workspace} must be a directory, not a symlink or file.`);
	const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
	if (manifest.private || manifest.name !== `@steveimm/${directory}`) {
		throw new Error(`Expected a public package named @steveimm/${directory}.`);
	}
	if (typeof manifest.version !== "string" || manifest.version.trim() !== manifest.version
		|| !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
		throw new Error("Set a stable version in package.json before publishing, such as 0.1.1.");
	}
	if (manifest.publishConfig?.registry && manifest.publishConfig.registry.replace(/\/$/, "") !== "https://registry.npmjs.org") {
		throw new Error("This workflow publishes only to registry.npmjs.org.");
	}
	return { workspace, name: manifest.name, version: manifest.version, bump };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const selected = selectPackage(process.env.PACKAGE, process.env.GITHUB_REF, process.env.VERSION_BUMP ?? "none");
	console.log(`Selected ${selected.name}@${selected.version} from ${selected.workspace}`);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `workspace=${selected.workspace}\n`);
}
