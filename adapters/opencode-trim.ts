// opencode adapter: compress tool output before the model sees it.
// Install: copy/symlink into ~/.config/opencode/plugins/
import type { Plugin } from "@opencode-ai/plugin"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { compress, maybeLog, netWin } = require("__TRIM_ROOT__/bin/trim-core.js")

export const Trim: Plugin = async () => ({
  // NOTE: a throw from tool.execute.after is FAIL-CLOSED in opencode (the
  // tool call errors), so the entire handler body stays inside try/catch.
  "tool.execute.after": async (input, output) => {
    try {
      if (process.env.TRIM_OFF === "1") return
      if (JSON.stringify(input.args ?? "").includes("TRIM_OFF=1")) {
        maybeLog("opencode", null, null, { bypass: true })
        return
      }
      const command = typeof (input.args as any)?.command === "string" ? (input.args as any).command : undefined
      if (typeof output.output === "string" && output.output) {
        const { out, stats, meta } = compress(output.output, { command, hostMayTruncate: true })
        maybeLog("opencode", stats, meta, { command })
        // rewrite only when it actually saves space
        if (netWin(output.output, out)) output.output = out
        return
      }
      // MCP tool results arrive as a raw content array instead of a string
      // (mutate in place, same as output.output). Text items only; anything
      // else passes untouched.
      const content = (output as any)?.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || c.type !== "text" || typeof c.text !== "string" || !c.text) continue
          const { out, stats, meta } = compress(c.text, { command, hostMayTruncate: true })
          maybeLog("opencode-mcp", stats, meta, { command })
          if (netWin(c.text, out)) c.text = out
        }
      }
    } catch {
      // never break the tool on adapter failure
    }
  },
})
