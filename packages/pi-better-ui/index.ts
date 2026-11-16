import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTiming } from "./timing.js";
import { registerStickyPrompt } from "./sticky.js";

export default function (pi: ExtensionAPI) {
	registerTiming(pi);
	registerStickyPrompt(pi);
}
