import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createJiti } = require('jiti');
const { default: extension } = await createJiti(import.meta.url).import(process.env.AUTOCOMPACT_SOURCE || '../index.ts');

function makeMsg(id, role, text) {
  return {
    id,
    type: 'message',
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: role === 'assistant' ? [{ type: 'text', text }] : text,
    },
  };
}

function makeCompaction(id, firstKeptEntryId, summary = 'summary', tokensBefore = 40000) {
  return {
    id,
    type: 'compaction',
    timestamp: new Date().toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore,
  };
}

function defaultBranchFixture() {
  const big = 'x'.repeat(40000); // ~10,000 tokens
  return [
    makeMsg('m1', 'user', big),
    makeMsg('m2', 'assistant', big),
    makeMsg('m3', 'user', big),
    makeMsg('m4', 'assistant', big),
  ];
}

function smallBranchFixture() {
  return [
    makeMsg('s1', 'user', 'hello'),
    makeMsg('s2', 'assistant', 'hi there'),
  ];
}

function withFakeClock(fn) {
  return async (...args) => {
    let now = 1_000_000;
    const origDateNow = Date.now;
    Date.now = () => now;
    const clock = {
      now: () => now,
      advance: (ms) => { now += ms; },
    };
    try {
      await fn(clock, ...args);
    } finally {
      Date.now = origDateNow;
    }
  };
}

function harness(options = {}) {
  const handlers = new Map(), commands = new Map(), attempts = [], notices = [];
  let settings = options.settings ?? {};
  let model = options.model ?? { provider: 'openai', id: 'gpt-4o' };
  extension({
    on(n, f) { handlers.set(n, f); },
    registerCommand(n, v) { commands.set(n, v); },
    getSettings() { return settings; },
  });
  let branch = options.branch ? [...options.branch] : defaultBranchFixture();
  let usage = options.usage ?? { tokens: 40000, contextWindow: 200000 };
  let idle = true, queued = false;
  const sessionManager = {
    getBranch: () => branch,
  };
  const ctx = {
    hasUI: true,
    ui: { notify: (...x) => notices.push(x) },
    getContextUsage: () => usage,
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    compact: (o) => attempts.push(o),
    waitForIdle: async () => {},
    sessionManager,
    model,
  };
  return {
    ctx,
    attempts,
    notices,
    setUsage: (v) => (usage = v),
    setBranch: (b) => (branch = b),
    setSettings: (s) => (settings = s),
    setModel: (m) => (model = ctx.model = m),
    busy: (v) => (idle = !v),
    queued: (v) => (queued = v),
    emit: (n, e = {}) => handlers.get(n)?.(e, ctx),
    command: () => commands.get('checkpoint').handler('', ctx),
  };
}

const completion = (id = 'a', extra = {}) => ({
  toolName: 'todo',
  toolCallId: id,
  input: { action: 'update', status: 'completed', id: 1 },
  isError: false,
  details: {},
  content: [{ type: 'text', text: 'Updated #1 (in_progress → completed)' }],
  ...extra,
});

test('checkpoint waits for settlement and coalesces; duplicate calls do not retrigger', async () => {
  const h = harness(); await h.emit('tool_result', completion()); assert.equal(h.attempts.length, 0);
  await h.emit('agent_settled'); assert.equal(h.attempts.length, 1);
  await h.emit('agent_settled'); assert.equal(h.attempts.length, 1);
  assert.match(h.attempts[0].customInstructions, /blockers/i);
  h.attempts[0].onComplete({}); await h.emit('tool_result', completion()); await h.emit('agent_settled'); assert.equal(h.attempts.length, 1);
});

test('rejects failed, no-op, unrelated and missing-evidence completions', async () => {
  for (const event of [completion('a', { isError: true }), completion('b', { details: { error: 'no' } }), completion('c', { content: [{type:'text',text:'No change'}] }), completion('d', { toolName: 'other' }), completion('e', { content: [] })]) {
    const h = harness(); await h.emit('tool_result', event); await h.emit('agent_settled'); assert.equal(h.attempts.length, 0);
  }
});

test('pressure scales with model window, no fixed 250k threshold', async () => {
  const h = harness(); h.setUsage({ tokens: 70000, contextWindow: 100000 }); await h.emit('agent_settled'); assert.equal(h.attempts.length, 1);
  const low = harness(); low.setUsage({ tokens: 69999, contextWindow: 100000 }); await low.emit('agent_settled'); assert.equal(low.attempts.length, 0);
});

test('unsafe, small and unknown usage cannot compact', async () => {
  for (const usage of [undefined, { tokens: null, contextWindow: 100000 }, { tokens: 31999, contextWindow: 100000 }, { tokens: NaN, contextWindow: 100000 }, { tokens: 40000, contextWindow: 0 }]) {
    const h = harness(); h.setUsage(usage); await h.emit('tool_result', completion()); await h.emit('agent_settled'); assert.equal(h.attempts.length, 0);
  }
  for (const guard of ['busy', 'queued']) { const h = harness(); h[guard](true); await h.emit('tool_result', completion()); await h.emit('agent_settled'); assert.equal(h.attempts.length, 0); h[guard](false); await h.emit('agent_settled'); assert.equal(h.attempts.length, 1); }
});

test('manual checkpoint bypasses size but not safety and in-flight guards', async () => {
  const h = harness(); h.setUsage({ tokens: 1000, contextWindow: 100000 }); await h.command(); assert.equal(h.attempts.length, 1); await h.command(); assert.equal(h.attempts.length, 1);
  const busy = harness(); busy.queued(true); await busy.command(); assert.equal(busy.attempts.length, 0);
});

test('failure clears lock, reports once and does not spin', async () => {
  const h = harness(); h.setUsage({ tokens: 80000, contextWindow: 100000 }); await h.emit('agent_settled'); h.attempts[0].onError(new Error('failed'));
  for (let i=0;i<5;i++) await h.emit('agent_settled'); assert.equal(h.attempts.length, 1);
  await h.command(); assert.equal(h.attempts.length, 2);
});

test('synchronous failure handled without leaving lock', async () => {
  const h = harness(); h.ctx.compact = () => { throw new Error('sync'); }; await h.command(); assert.equal(h.notices.length, 1);
  h.ctx.compact = o => h.attempts.push(o); await h.command(); assert.equal(h.attempts.length, 1);
});

test('session lifecycle resets checkpoint and stale callback cannot unlock new attempt', async () => {
  for (const lifecycle of ['session_start','session_tree']) {
    const h = harness(); await h.command(); const old = h.attempts[0]; await h.emit(lifecycle); await h.command(); old.onComplete({}); await h.command(); assert.equal(h.attempts.length, 2);
  }
});

test('native compaction resets pending checkpoint and establishes fresh baseline', async () => {
  const h = harness(); await h.emit('tool_result', completion()); await h.emit('session_compact'); await h.emit('agent_settled'); assert.equal(h.attempts.length, 0);
  await h.emit('tool_result', completion('b')); await h.emit('agent_settled'); assert.equal(h.attempts.length, 0);
});

// ============================================================================
// Regression & New Requirement Tests
// ============================================================================

test('negative control: task completion does not compact when conversation history too small', async () => {
  const h = harness({ branch: smallBranchFixture(), usage: { tokens: 40000, contextWindow: 200000 } });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);
});

test('pending checkpoint is preserved when history too small and triggers once history grows', async () => {
  const h = harness({ branch: smallBranchFixture(), usage: { tokens: 40000, contextWindow: 200000 } });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);

  h.setBranch(defaultBranchFixture());
  h.setUsage({ tokens: 60000, contextWindow: 200000 });
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
});

test('respects custom keepRecentTokens setting from pi.getSettings()', async () => {
  const h = harness({
    settings: { compaction: { keepRecentTokens: 50000 } },
    usage: { tokens: 60000, contextWindow: 200000 },
  });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);

  h.setSettings({ compaction: { keepRecentTokens: 15000 } });
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
});

test('respects model-specific keepRecentTokens override from pi.getSettings()', async () => {
  const settings = {
    compaction: {
      keepRecentTokens: 20000,
      modelOverrides: {
        'anthropic/claude-3-5': { keepRecentTokens: 50000 },
      },
    },
  };
  const h = harness({
    settings,
    model: { provider: 'anthropic', id: 'claude-3-5' },
    usage: { tokens: 60000, contextWindow: 200000 },
  });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);

  h.setModel({ provider: 'openai', id: 'gpt-4o' });
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
});

test('previous compaction: refuses when post-compaction history too small, compacts when grown', async () => {
  const big = 'x'.repeat(40000);
  const prevCompactedBranchSmall = [
    makeMsg('m1', 'user', big),
    makeMsg('m2', 'assistant', big),
    makeMsg('m3', 'user', big),
    makeMsg('m4', 'assistant', big),
    makeCompaction('c1', 'm3', 'previous summary', 40000),
    makeMsg('s1', 'user', 'small task done'),
    makeMsg('s2', 'assistant', 'ok'),
  ];

  const h = harness({
    branch: prevCompactedBranchSmall,
    usage: { tokens: 40000, contextWindow: 200000 },
  });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);

  const prevCompactedBranchGrown = [
    ...prevCompactedBranchSmall,
    makeMsg('m5', 'user', big),
    makeMsg('m6', 'assistant', big),
  ];
  h.setBranch(prevCompactedBranchGrown);
  h.setUsage({ tokens: 60000, contextWindow: 200000 });
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
});

test('branch ending in compaction is not re-compacted', async () => {
  const branchEndingInCompaction = [
    ...defaultBranchFixture(),
    makeCompaction('c1', 'm3', 'summary', 40000),
  ];
  const h = harness({
    branch: branchEndingInCompaction,
    usage: { tokens: 40000, contextWindow: 200000 },
  });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);
});

test('large raw history with context_edit conservatively refuses compaction', async () => {
  const branchWithEdit = [
    ...defaultBranchFixture(),
    { id: 'ce1', type: 'context_edit', timestamp: new Date().toISOString() },
  ];
  const h = harness({
    branch: branchWithEdit,
    usage: { tokens: 40000, contextWindow: 200000 },
  });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);
});

test('async onError avoids duplicate UI notification while clearing in-flight lock', async () => {
  const h = harness({ usage: { tokens: 80000, contextWindow: 100000 } });
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
  h.attempts[0].onError(new Error('Nothing to compact (session too small)'));
  assert.equal(h.notices.length, 0);
  await h.command();
  assert.equal(h.attempts.length, 2);
});

test('retry at same usage after failure and 120s cooldown without fresh milestone', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 200000 } });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);

  h.attempts[0].onError(new Error('transient failure'));

  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);

  clock.advance(120_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 2);
}));

test('no retry before cooldown expires after failure', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 200000 } });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);

  h.attempts[0].onError(new Error('transient failure'));

  clock.advance(60_000);
  for (let i = 0; i < 3; i++) {
    await h.emit('agent_settled');
  }
  assert.equal(h.attempts.length, 1);

  clock.advance(60_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 2);
}));

test('synchronous fail preserves checkpoint and baseline, retrying after cooldown', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 200000 } });
  await h.emit('tool_result', completion());

  let failSync = true;
  h.ctx.compact = (o) => {
    if (failSync) {
      throw new Error('sync compact failure');
    }
    h.attempts.push(o);
  };

  await h.emit('agent_settled');
  assert.equal(h.notices.length, 1);
  assert.equal(h.attempts.length, 0);

  failSync = false;
  clock.advance(60_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 0);

  clock.advance(60_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
}));

test('failed manual request remains automatic pending without spin', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 200000 } });
  await h.command();
  assert.equal(h.attempts.length, 1);

  h.attempts[0].onError(new Error('manual attempt failed'));

  for (let i = 0; i < 5; i++) {
    await h.emit('agent_settled');
  }
  assert.equal(h.attempts.length, 1);

  clock.advance(120_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 2);
}));

test('milestone arriving during in-flight attempt is preserved after success', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 100000 } });
  await h.emit('tool_result', completion('m1'));
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);

  await h.emit('tool_result', completion('m2'));

  h.attempts[0].onComplete({});

  h.setUsage({ tokens: 40000, contextWindow: 100000 });
  await h.emit('agent_settled');

  h.setUsage({ tokens: 56000, contextWindow: 100000 });
  clock.advance(120_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 2);
}));

test('stale epoch callback after session reset does not unlock or mutate state', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 200000 } });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);

  const staleAttempt = h.attempts[0];
  await h.emit('session_start');

  staleAttempt.onError(new Error('stale error'));
  assert.equal(h.notices.length, 0);

  clock.advance(120_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
}));

test('successful compaction consumes triggering milestone and does not re-compact at same usage', withFakeClock(async (clock) => {
  const h = harness({ usage: { tokens: 40000, contextWindow: 100000 } });
  await h.emit('tool_result', completion());
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);

  h.attempts[0].onComplete({});
  h.setUsage({ tokens: 10000, contextWindow: 100000 });
  await h.emit('agent_settled');

  clock.advance(120_000);
  await h.emit('agent_settled');
  assert.equal(h.attempts.length, 1);
}));
