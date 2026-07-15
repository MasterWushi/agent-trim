// opencode adapter: compress tool output before the model sees it.
// Install: copy/symlink into ~/.config/opencode/plugins/
import type { Plugin } from "@opencode-ai/plugin"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { compress, maybeLog } = require("__TRIM_ROOT__/bin/trim-core.js")

export const Trim: Plugin = async () => ({
  "tool.execute.after": async (input, output) => {
    if (process.env.TRIM_OFF === "1") return
    if (JSON.stringify(input.args ?? "").includes("TRIM_OFF=1")) return
    if (typeof output.output !== "string" || !output.output) return
    try {
      const { out, stats } = compress(output.output)
      maybeLog("opencode", stats)
      // rewrite only when it actually saves space
      if (out && out.length < output.output.length - 32) output.output = out
    } catch {
      // never break the tool on adapter failure
    }
  },
})
