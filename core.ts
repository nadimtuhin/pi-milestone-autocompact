import { findCutPoint } from "@earendil-works/pi-coding-agent";

export function shouldCompact(
  tokens: number | null | undefined,
  window: number | undefined,
  baseline: number,
  lastAttempt: number | undefined,
  now: number,
  checkpoint: boolean,
  manual: boolean
): boolean {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || tokens! <= 0 || window! <= 0) return false;
  if (manual) return true;
  return (
    tokens! >= 32_000 &&
    tokens! - baseline >= 16_000 &&
    (lastAttempt === undefined || now - lastAttempt >= 120_000) &&
    (checkpoint || tokens! >= window! * 0.7)
  );
}

export function getKeepRecentTokens(
  settings?: any,
  model?: { provider?: string; id?: string } | null
): number {
  const compaction = settings?.compaction;
  const modelKey = model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
  const override = modelKey ? compaction?.modelOverrides?.[modelKey]?.keepRecentTokens : undefined;
  if (typeof override === "number" && Number.isSafeInteger(override) && override >= 0) {
    return override;
  }
  const ordinary = compaction?.keepRecentTokens;
  if (typeof ordinary === "number" && Number.isSafeInteger(ordinary) && ordinary >= 0) {
    return ordinary;
  }
  return 20_000;
}

// ponytail: branch slice with findCutPoint checks compactable history; ceiling is conservative refusal for context-edited branches without native projection, upgrade path is prepareCompaction when Pi exports it.
export function isConversationCompactable(
  branch: any[] | undefined,
  keepRecentTokens: number
): boolean {
  if (!Array.isArray(branch) || branch.length === 0) return false;
  if (branch[branch.length - 1]?.type === "compaction") return false;
  if (branch.some((e) => e?.type === "context_edit")) return false;

  try {
    const prevCompactionIdx = branch.findLastIndex((e) => e.type === "compaction");
    let candidateEntries: any[];

    if (prevCompactionIdx >= 0) {
      const prevCompaction = branch[prevCompactionIdx];
      const firstKeptId = prevCompaction?.firstKeptEntryId;
      const keptTail: any[] = [];
      if (firstKeptId && firstKeptId !== prevCompaction.id) {
        let found = false;
        for (let i = 0; i < prevCompactionIdx; i++) {
          if (branch[i].id === firstKeptId) found = true;
          if (
            found &&
            branch[i].type !== "compaction" &&
            !(branch[i].type === "message" && branch[i].message?.role === "system")
          ) {
            keptTail.push(branch[i]);
          }
        }
      }
      candidateEntries = [...keptTail, ...branch.slice(prevCompactionIdx + 1)];
    } else {
      candidateEntries = branch;
    }

    if (candidateEntries.length === 0) return false;

    const cut = findCutPoint(candidateEntries, 0, candidateEntries.length, keepRecentTokens);
    const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
    const toSummarize = candidateEntries.slice(0, historyEnd);

    const isModelMessage = (entry: any) => {
      if (!entry) return false;
      if (entry.type === "compaction") return false;
      if (entry.type === "message") return entry.message?.role !== "system";
      return entry.type === "custom_message" || entry.type === "branch_summary";
    };

    if (toSummarize.some(isModelMessage)) return true;
    if (cut.isSplitTurn) {
      const turnPrefix = candidateEntries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex);
      if (turnPrefix.some(isModelMessage)) return true;
    }

    return false;
  } catch {
    return false;
  }
}
