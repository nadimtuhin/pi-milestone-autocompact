import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeepRecentTokens, isConversationCompactable, shouldCompact } from "./core.ts";

const INSTRUCTIONS =
  "Preserve objective, constraints, completed and remaining tasks, changed file paths, test evidence, blockers, unresolved decisions and exact next steps. Distinguish implementation from review approval and live verification. Do not invent completion.";

export default function (pi: ExtensionAPI): void {
  let epoch = 0;
  let pending = false;
  let manual = false;
  let compacting = false;
  let baseline = 0;
  let resetBaseline = false;
  let lastAttempt: number | undefined;
  const seen = new Set<string>();

  const reset = () => {
    epoch++;
    pending = manual = compacting = resetBaseline = false;
    baseline = 0;
    lastAttempt = undefined;
    seen.clear();
  };
  const notify = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(text, "error");
      } catch {}
    }
  };
  const attempt = (ctx: ExtensionContext) => {
    if (compacting || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const usage = ctx.getContextUsage();
    if (resetBaseline && Number.isFinite(usage?.tokens) && usage?.tokens != null) {
      baseline = usage.tokens;
      resetBaseline = false;
    }
    if (!shouldCompact(usage?.tokens, usage?.contextWindow, baseline, lastAttempt, Date.now(), pending, manual)) return;

    const branch = ctx.sessionManager?.getBranch?.();
    const keepRecentTokens = getKeepRecentTokens(pi.getSettings?.(), ctx.model);
    if (!isConversationCompactable(branch, keepRecentTokens)) return;

    const attemptedCheckpoint = pending;
    compacting = true;
    pending = manual = false;
    lastAttempt = Date.now();
    const startedEpoch = epoch;
    const fail = (error: Error, notifyUser = true) => {
      if (startedEpoch !== epoch) return;
      compacting = false;
      if (attemptedCheckpoint) pending = true;
      if (notifyUser) {
        notify(ctx, `Checkpoint compaction failed: ${error.message}`);
      }
    };
    try {
      ctx.compact({
        customInstructions: INSTRUCTIONS,
        onComplete: () => {
          if (startedEpoch !== epoch) return;
          compacting = false;
          resetBaseline = true;
          lastAttempt = Date.now();
        },
        onError: (err) => fail(err, false),
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)), true);
    }
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", () => {
    pending = manual = false;
    resetBaseline = true;
    lastAttempt = Date.now();
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError || event.input.action !== "update" || event.input.status !== "completed") return;
    if ((event.details as { error?: unknown } | undefined)?.error || seen.has(event.toolCallId)) return;
    const text = event.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (!/Updated #\d+ \((?:pending|in_progress) → completed\)/.test(text)) return;
    seen.add(event.toolCallId);
    if (seen.size > 256) seen.delete(seen.values().next().value!);
    pending = true;
  });
  pi.on("agent_settled", (_event, ctx) => attempt(ctx));
  pi.registerCommand("checkpoint", {
    description: "Compact at safe idle boundary, preserving task handoff",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      pending = manual = true;
      attempt(ctx);
    },
  });
}
