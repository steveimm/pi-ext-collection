import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const OVERRIDES_FILE_PATH = join(getAgentDir(), "chat-template-kwargs.json");
const SELECTED_MARKER = "(selected)"
const CLEAR_OPTION = "off";
const NEW_OPTION = "create a new one";
const DELETE_OPTION = "delete an existing one";


function loadOverrides(): Record<string, unknown>[] {
	try {
		return JSON.parse(readFileSync(OVERRIDES_FILE_PATH, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

export default function (pi: ExtensionAPI) {
	let selectedKwargs: Record<string, unknown> | undefined;
	let overrides: Record<string, unknown>[] = [];
	let loadError: string | undefined;

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;

		try {
			overrides = loadOverrides();
			loadError = undefined;
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to load ${OVERRIDES_FILE_PATH}: ${loadError}`, "error");
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!selectedKwargs) return;
		if (ctx.model?.api !== "openai-completions") return;

		const payload = event.payload as Record<string, unknown>;
		const oldKwargs = payload.chat_template_kwargs as Record<string, unknown> | undefined;
		const next = { ...payload, chat_template_kwargs: { ...oldKwargs, ...selectedKwargs } };

		return next;
	});

	async function createOverride(ctx: ExtensionCommandContext): Promise<void> {
		let draft = "";
		let kwargs: Record<string, unknown>;

		while (true) {
			const raw = await ctx.ui.editor("Type the override value for \"chat_template_kwargs\" in valid JSON, e.g., {\"reasoning_strength\": \"low\"} ", draft);
			if (raw === undefined) return;
			draft = raw;
			try {
				const parsed = JSON.parse(raw); // check json valid
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("top level must be a JSON object");
				}
				kwargs = parsed;
				break;
			} catch (err) {
				ctx.ui.notify(`Invalid JSON: ${err instanceof Error ? err.message : err}`, "error");
			}
		}

		const kwargsJson = JSON.stringify(kwargs);
		if (overrides.some((o) => JSON.stringify(o) === kwargsJson)) {
			ctx.ui.notify("This override already exists", "warning");
			return;
		}
		if (!(await ctx.ui.confirm("Save this override?", kwargsJson))) return;

		writeFileSync(OVERRIDES_FILE_PATH, `${JSON.stringify([...overrides, kwargs], null, "\t")}\n`, "utf8");
		overrides = loadOverrides();
		ctx.ui.notify(`Saved chat_template_kwargs override ${kwargsJson} to ${OVERRIDES_FILE_PATH}`, "info");
	}

	async function deleteOverride(ctx: ExtensionCommandContext): Promise<void> {
		if (overrides.length === 0) {
			ctx.ui.notify("No overrides to delete", "warning");
			return;
		}

		const choice = await ctx.ui.select("Delete which override?", overrides.map((o) => JSON.stringify(o)));
		if (!choice) return;
		if (!(await ctx.ui.confirm("Delete this override?", choice))) return;

		const rest = overrides.filter((o) => JSON.stringify(o) !== choice);
		writeFileSync(OVERRIDES_FILE_PATH, `${JSON.stringify(rest, null, "\t")}\n`, "utf8");
		overrides = loadOverrides();

		if (selectedKwargs && JSON.stringify(selectedKwargs) === choice) {
			selectedKwargs = undefined;
			ctx.ui.setStatus("ctk", undefined);
		}
		ctx.ui.notify(`Deleted chat_template_kwargs override ${choice} from ${OVERRIDES_FILE_PATH}`, "info");
	}

	pi.registerCommand("ctk", {
		description: "Override chat_template_kwargs as you define",

		getArgumentCompletions: (prefix) => {
			const items = [...overrides.map((o) => JSON.stringify(o)), CLEAR_OPTION]
				.filter((value) => value.startsWith(prefix))
				.map((value) =>
					value === CLEAR_OPTION ? { value, label: value, description: "turn off override" } : { value, label: value },
				);
			return items.length > 0 ? items : null;
		},

		handler: async (args, ctx) => {
			if (loadError) {
				ctx.ui.notify(`Failed to load ${OVERRIDES_FILE_PATH}: ${loadError}`, "error");
				return;
			}

			let choice: string | undefined = args.trim() || undefined;
			while (true) {
				if (!choice) {
					const selectedJson = selectedKwargs && JSON.stringify(selectedKwargs);
					const options = [...overrides.map((o) => JSON.stringify(o)), CLEAR_OPTION, NEW_OPTION, DELETE_OPTION].map(
						(value) => (value === selectedJson ? `${value} ${SELECTED_MARKER}` : value),
					);
					choice = (await ctx.ui.select("Select chat_template_kwargs overrides", options))?.replace(` ${SELECTED_MARKER}`, "");
					if (!choice) return;
				}

				switch (choice) {
					case NEW_OPTION:
						await createOverride(ctx);
						choice = undefined;
						break;

					case DELETE_OPTION:
						await deleteOverride(ctx);
						choice = undefined;
						break;

					case CLEAR_OPTION:
						selectedKwargs = undefined
						ctx.ui.setStatus("ctk", undefined);
						ctx.ui.notify("chat_template_kwargs override is turned off", "info");
						return;

					default: {
						const match = overrides.find((o) => JSON.stringify(o) === choice);
						if (!match) {
							ctx.ui.notify(`Unknown override: ${choice}`, "error");
							return;
						}
						selectedKwargs = match;
						const kwargsJson = JSON.stringify(selectedKwargs);
						const kwargsLabel = kwargsJson.length > 30 ? `${kwargsJson.slice(0, 30)}...` : kwargsJson;
						ctx.ui.setStatus("ctk", ctx.ui.theme.fg("dim", `ctk: ${kwargsLabel}`));
						ctx.ui.notify(`chat_template_kwargs override is set to ${kwargsJson}`, "info");
						return;
					}
				}
			}
		},
	});
}
