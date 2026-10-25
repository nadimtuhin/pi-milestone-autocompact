# pi-milestone-autocompact

Checkpoint-aware context compaction for [Pi](https://pi.dev). Uses Pi's native
compaction API with handoff instructions preserving objectives, constraints,
completed and remaining work, changed paths, test evidence, blockers, unresolved
decisions and next steps.

## Install

Once the repository is available:

```sh
pi install git:github.com/nadimtuhin/pi-milestone-autocompact
```

For this local checkout, try without changing Pi settings:

```sh
pi -e ./index.ts
```

Requires a Pi host exposing `findCutPoint`, `agent_settled`, `getSettings` and
`ctx.compact`. Development tests pin `@earendil-works/pi-coding-agent` 1.1.0;
other host versions are not verified. No runtime dependencies are bundled.

## Behavior

- Automatic attempts run at `agent_settled`, only while idle with no queued
  messages or compaction already in flight.
- Require known, finite, positive context usage and window size, at least
  32,000 tokens, at least 16,000 tokens of growth since the baseline, and at
  least 120 seconds since the previous attempt.
- Also require either a pending todo checkpoint or usage at least 70% of the
  model's context window. The first baseline is zero; after compaction, the
  next observed usage establishes a fresh baseline.
- Todo checkpoints are specific to successful `todo` tool results with
  `action: "update"`, `status: "completed"`, no error detail, and text matching
  `Updated #<digits> (pending → completed)` or
  `Updated #<digits> (in_progress → completed)`. Arbitrary task-completion prose
  and other todo formats do not match. Repeated tool-call IDs are deduplicated
  within a bounded 256-ID set.
- `/checkpoint` requests manual compaction. It bypasses size, growth, cooldown
  and checkpoint/pressure thresholds, but not valid usage, idle/queue,
  in-flight or compactable-history checks.
- Retention follows Pi's `compaction.modelOverrides["provider/model"].keepRecentTokens`,
  then `compaction.keepRecentTokens`, then 20,000 tokens. Only nonnegative safe
  integers are accepted. The extension adds no configuration knobs.
- History must contain something Pi can summarize outside the retained tail.
  A branch ending in compaction is refused. Any `context_edit` entry causes
  conservative refusal because native context-edit projection is unavailable
  through the exported API. Pi's native overflow compaction remains enabled
  and is the fallback; this extension does not disable or replace it.

## Validation and limits

```sh
npm ci
npm test
npm pack --dry-run
```

Unit tests load the TypeScript extension through package-resolved `jiti` and
mock the Pi event/context APIs. They check triggers, guards, retention and
callback handling, not a live model response. **Successful real automatic
summarization is unproven; validation covers unit tests and module loading
only.** No provider calls or live end-to-end compaction have been performed.
No performance improvement is claimed.

MIT © Nadim Tuhin.
