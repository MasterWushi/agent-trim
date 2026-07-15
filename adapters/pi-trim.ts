// pi.dev adapter: compress bash tool output before the model sees it.
// Install: copy/symlink into ~/.pi/agent/extensions/
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { compress, maybeLog } = require("__TRIM_ROOT__/bin/trim-core.js");

export default async function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (process.env.TRIM_OFF === "1") return;
    if (event.toolName !== "bash" || event.isError) return;
    if (JSON.stringify(event.input ?? "").includes("TRIM_OFF=1")) return;
    let changed = false;
    const content = event.content.map((c: any) => {
      if (c.type !== "text" || typeof c.text !== "string") return c;
      try {
        const { out, stats } = compress(c.text);
        maybeLog("pi", stats);
        if (out && out.length < c.text.length - 32) {
          changed = true;
          return { ...c, text: out };
        }
      } catch {}
      return c;
    });
    if (changed) return { content };
  });
}
