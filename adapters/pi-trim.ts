// pi.dev extension. Keep host API wiring here; behavior is plain JS and unit tested.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtime = require("__TRIM_ROOT__/adapters/lib/pi-runtime.js");

export default async function (pi: ExtensionAPI) {
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const load = (ctx: ExtensionContext) => runtime.readState(sessionId(ctx));
  const save = (ctx: ExtensionContext, state: unknown) => runtime.writeState(sessionId(ctx), state);

  pi.on("tool_result", async (event, ctx) => {
    try {
      const usage = ctx.getContextUsage();
      const contextBytes = usage && typeof (usage as any).tokens === "number" ? (usage as any).tokens * 4 : undefined;
      const result = runtime.handleToolResult(event, load(ctx), {
        ...process.env,
        sessionId: sessionId(ctx),
        contextBytes,
      });
      save(ctx, result.stateDelta);
      runtime.logMetrics(result.metrics);
      if (result.patch) return result.patch;
    } catch {}
  });

  pi.on("session_before_compact", async (event) => {
    try {
      event.customInstructions = [event.customInstructions, runtime.PRESERVATION_INSTRUCTIONS].filter(Boolean).join("\n");
    } catch {}
  });
  pi.on("session_compact", async (_event, ctx) => save(ctx, runtime.resetForCompaction(load(ctx))));
  for (const name of ["session_before_switch", "session_before_fork"] as const) {
    pi.on(name, async (_event: any, ctx: ExtensionContext) => save(ctx, runtime.resetVolatile(load(ctx), sessionId(ctx))));
  }
  pi.on("message_end", async (event, ctx) => {
    try {
      const state = load(ctx);
      const text = runtime.textFromMessage(event.message);
      const step = runtime.stepNarration(state, text, state.profile, state.turnCounter);
      save(ctx, step.state); // measurement-only: Pi has no zero-turn-cost mid-turn instruction channel
      runtime.logNarration(step, state.profile);
    } catch {}
  });

  const notify = (ctx: any, message: string) => ctx.ui.notify(message, "info");
  pi.registerCommand("trim-stats", {
    description: "Show trim session counters",
    handler: async (_args, ctx) => {
      const s = load(ctx);
      notify(ctx, `trim: ${Object.keys(s.handled).length} results, ${s.observedBytes} bytes, pressure ${s.pressureBand}, epoch ${s.compactionEpoch}`);
    },
  });
  pi.registerCommand("trim-profile", {
    description: "Set the session trim profile",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name && !runtime.PROFILES.has(name)) return notify(ctx, `unknown profile: ${name}`);
      const s = load(ctx);
      s.profile = name || null;
      save(ctx, s);
      notify(ctx, `trim profile: ${s.profile || "default"}`);
    },
  });
  pi.registerCommand("trim-debug", { description: "Show trim state path", handler: async (_a, ctx) => notify(ctx, runtime.statePath(sessionId(ctx))) });
  pi.registerCommand("trim-context", { description: "Show trim context pressure", handler: async (_a, ctx) => { const s = load(ctx); notify(ctx, `trim: ${s.pressureBand}, ${s.observedBytes} observed bytes`); } });
  pi.registerCommand("trim-order", { description: "Check extension ordering signals", handler: async (_a, ctx) => { const s = load(ctx); notify(ctx, s.orderMarkers ? "trim saw prior trim markers; place semantic formatters before agent-trim and display-only extensions after it" : "trim saw no prior markers; recommended order: semantic formatters → agent-trim → metrics → display-only"); } });
}
