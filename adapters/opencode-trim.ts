// opencode adapter: compress tool output before the model sees it.
// Install: install.sh renders this into ~/.config/opencode/plugins/trim.ts.
//
// Deliberately a THIN SHIM. The rendered copy is a snapshot that `git pull`
// cannot update, so behaviour lives in adapters/lib/opencode-runtime.js and is
// required from the repo by absolute path at runtime — a pull updates opencode
// without re-running the installer. Only change this file to alter the host API
// wiring itself; anything else belongs in the runtime. Same shape as pi-trim.ts,
// which is why pi survived the 0.4.0 release without a reinstall.
import type { Plugin } from "@opencode-ai/plugin"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const runtime = require("__TRIM_ROOT__/adapters/lib/opencode-runtime.js")

export const Trim: Plugin = runtime.Trim
