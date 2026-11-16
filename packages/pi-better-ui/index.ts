import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTiming } from "./timing.js";

export default function (pi: ExtensionAPI) {
	registerTiming(pi);
}
