import assert from 'node:assert/strict';
import test from 'node:test';
import pr6 from './pr-review-pr6.json' with { type: 'json' };
import { decide, evidence, invalidateAdvancedBaseChecks, isGarnetComment, matchesRun, mcp, profileFor, publish, summarizeEgress } from '../scripts/runtime-review.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const prBase = { ref: 'main', sha: base };
const id = '73562dce-ddbc-464b-aea0-beb467d8d615';
const repo = 'garnet-labs/devin-receipt-demo';
const url = `https://github.com/${repo}/pull/1#issuecomment-42`;
const context = { repo, pr: 1, head, run: 2, attempt: 1 };

function marker(overrides = {}) {
  return {
    commit: head, previous: base, status: 'finalized', capture_quality: 'best-effort',
    incomplete: 0, jobs: 1, scope: 'base-ancestor', outcome: 'unchanged',
    changed: 0, added: 0, removed: 0, ...overrides
  };
}

test('only a finalized, scoped, exact-base no-change record passes', () => {
  assert.equal(decide(marker(), head, base), 'nothing-new');
  assert.equal(decide(marker({ scope: 'pr-base' }), head, base), 'nothing-new');
  assert.equal(decide(marker({ scope: 'not-scoped' }), head, base), 'unknown');
  assert.equal(decide(marker(), head, 'c'.repeat(40)), 'unknown');
  assert.equal(decide(marker({ commit: base }), head, base), 'unknown');
  assert.equal(decide(marker({ status: 'pending' }), head, base), 'unknown');
  assert.equal(decide(marker({ capture_quality: 'partial' }), head, base), 'unknown');
  assert.equal(decide(marker({ incomplete: 1 }), head, base), 'unknown');
  assert.equal(decide(marker({ jobs: 0 }), head, base), 'unknown');
  assert.equal(decide(marker({ removed: 1 }), head, base), 'removals-only');
  assert.equal(decide(marker({ outcome: 'first' }), head, base), 'unknown');
  assert.equal(decide(null, head, base), 'unknown');
});

test('a positive change is distinct from absent evidence', () => {
  const changed = marker({ outcome: 'changed', changed: 1, added: 1 });
  assert.equal(decide(changed, head, base), 'changed');
  assert.equal(decide(marker({ outcome: 'changed' }), head, base), 'unknown');
});

test('the recorded PR #6 App marker passes only when finalized and bound to the requested head', () => {
  const { head_sha: recordedHead, envelope } = pr6;
  const recordedBase = envelope.previous;
  assert.equal(decide(envelope, recordedHead, recordedBase), 'nothing-new');
  for (const status of ['missing', 'recording', 'stale', 'malformed', 'incomplete', 'unsupported']) {
    assert.equal(decide({ ...envelope, status }, recordedHead, recordedBase), 'unknown', status);
  }
  assert.equal(decide(envelope, head, recordedBase), 'unknown');
  assert.equal(decide({ ...envelope, outcome: undefined }, recordedHead, recordedBase), 'unknown');
  assert.equal(decide({ ...envelope, outcome: 'changed', changed: undefined }, recordedHead, recordedBase), 'unknown');
});

function appEvidence(comment, context, jobId, jobAttempt = { run_attempt: context.attempt }) {
  return async path => {
    if (path === `issues/${context.pr}/comments?per_page=100&page=1`) return [comment];
    assert.equal(path, `actions/runs/${context.run}/attempts/${context.attempt}/jobs?per_page=100`);
    return { total_count: 1, jobs: [{ id: jobId, name: 'runtime-build', conclusion: 'success', ...jobAttempt }] };
  };
}

test('PR #6 publishes success only after binding its App comment and capture profile', async () => {
  const recordedRepo = 'garnet-labs/claude-ship-garnet';
  const recordedHead = pr6.head_sha;
  const recordedBase = pr6.envelope.previous;
  const run = {
    id: 45724477522, path: '.github/workflows/ci.yml', event: 'pull_request',
    head_sha: recordedHead, run_attempt: 1, conclusion: 'success',
    head_repository: { full_name: recordedRepo }, pull_requests: [{ number: 6 }]
  };
  const recordedContext = { repo: recordedRepo, pr: 6, head: recordedHead, run: run.id, attempt: 1 };
  const comment = {
    id: 7177218621, html_url: pr6.comment_url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: [
      '<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->',
      `<!-- garnet:commit ${recordedHead} -->`,
      `<!-- garnet:summary ${JSON.stringify(pr6.envelope)} -->`,
      '<a href="https://github.com/garnet-labs/claude-ship-garnet/actions/runs/45724477522/job/139590716442">Job log</a>',
      `<a href="https://app.garnet.ai/public/runs/45724477522?profile=${pr6.profile_ids[0]}&amp;utm_medium=pr_comment">Full record</a>`
    ].join('\n')
  };
  const recordedProfile = {
    id: '01a2151f-bd4d-7ffb-baac-fa2a1093c0ae',
    githubOrg: 'garnet-labs', repo: 'claude-ship-garnet', runID: '45724477522',
    runAttempt: 1, job: 'runtime-build',
    data: { scenarios: { github: { head_sha: recordedHead } }, network: { egress: { peers: [] } } }
  };
  const readMcp = (observedProfile) => async (name, args) => {
    assert.equal(name, 'profiles');
    assert.deepEqual(args, {
      githubOrg: 'garnet-labs', repo: 'claude-ship-garnet', runID: '45724477522',
      runAttempt: 1, job: 'runtime-build', pageArgs: { first: 10 }
    });
    return { items: [observedProfile], pageInfo: { hasNextPage: false } };
  };
  const getPull = {
    state: 'open', head: { sha: recordedHead, repo: { full_name: recordedRepo } },
    base: { ref: 'main', sha: recordedBase }
  };
  const staleBase = { ...getPull.base, sha: base };
  const getComment = appEvidence(comment, recordedContext, 139590716442);
  const writes = [];
  const gh = async (path, body, method) => {
    if (path === 'pulls/6') return { ...getPull, base: staleBase };
    if (path === 'git/ref/heads/main') return { object: { sha: recordedBase } };
    if (path === 'actions/runs/45724477522') return run;
    if (body === undefined) return getComment(path);
    writes.push({ path, body, method });
    return { id: 1 };
  };
  assert.equal(await publish(run, recordedRepo, gh, (read, request, baseline) =>
    evidence(read, request, baseline, readMcp(recordedProfile))), `garnet/runtime-diff: nothing-new on ${recordedHead}`);
  assert.deepEqual(writes.map(({ path, body, method }) => [path, body.status, method]), [
    ['check-runs', 'in_progress', undefined], ['check-runs/1', 'completed', 'PATCH']
  ]);
  assert.equal(writes[0].body.head_sha, recordedHead);
  assert.equal(writes[1].body.conclusion, 'success');
  assert.equal(writes[1].body.external_id, `6:main:${recordedBase}`);
  assert.ok(writes[1].body.output.summary.includes(`compared with \`${recordedBase}\``));
  assert.equal(writes[1].body.output.title, 'No new runtime behavior recorded');

  assert.equal(await evidence(appEvidence({
    ...comment, body: comment.body.replace('/runs/45724477522/', '/runs/1/')
  }, recordedContext, 139590716442), recordedContext, getPull.base, readMcp(recordedProfile)), null);
  assert.equal(await evidence(appEvidence({
    ...comment, performed_via_github_app: { id: 1 }
  }, recordedContext, 139590716442), recordedContext, getPull.base, readMcp(recordedProfile)), null);
  assert.equal(await evidence(getComment, recordedContext, getPull.base,
    readMcp({ ...recordedProfile, runAttempt: 2 })), null);
  assert.equal(await evidence(getComment, recordedContext, getPull.base,
    readMcp({ ...recordedProfile, id })), null);
  assert.equal(await evidence(async path => path === 'git/ref/heads/main' ? { object: { sha: head } } : getComment(path),
    recordedContext, staleBase, readMcp(recordedProfile)), null);
});

test('GitHub App identity and exact run attempt cannot be substituted', () => {
  const comment = {
    id: 42, html_url: url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: `<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->\n<!-- garnet:commit ${head} -->`
  };
  assert.equal(isGarnetComment(comment, context), true);
  assert.equal(isGarnetComment({ ...comment, user: { id: 1 } }, context), false);
  assert.equal(isGarnetComment(comment, { ...context, pr: 2 }), false);
  const run = {
    path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
    run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }]
  };
  assert.equal(matchesRun(run, context), true);
  assert.equal(matchesRun({ ...run, run_attempt: 2 }, context), false);
  assert.equal(matchesRun({ ...run, pull_requests: [{ number: 1 }, { number: 2 }] }, context), false);
  assert.equal(matchesRun({ ...run, head_repository: { full_name: 'other/fork' } }, context), false);
});

function profile() {
  return {
    id, githubOrg: 'garnet-labs', repo: 'devin-receipt-demo',
    runID: '2', runAttempt: 1, job: 'runtime-build',
    data: { scenarios: { github: { head_sha: head } }, network: { egress: { peers: [
      { remote_names: ['example.com', 'not a host'], proc_trees: [{ github_step: '5. Build', arguments: 'not for output' }] },
      { remote_names: ['runner.example'], proc_trees: [{ github_step: 'Post Run' }] }
    ] } } }
  };
}

test('MCP profiles use exact selectors and paginate', async () => {
  const result = await profileFor(context, id, async (name, args) => {
    assert.equal(name, 'profiles');
    assert.equal(args.githubOrg, 'garnet-labs');
    assert.equal(args.repo, 'devin-receipt-demo');
    assert.equal(args.runID, '2');
    assert.equal(args.runAttempt, 1);
    assert.equal(args.job, 'runtime-build');
    if (args.pageArgs.after === 'page2') return { items: [profile()], pageInfo: { hasNextPage: false } };
    assert.equal(args.pageArgs.after, undefined);
    return { items: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } };
  });
  assert.equal(result.id, id);
  assert.deepEqual(summarizeEgress(result).observedWorkloadDestinations, ['example.com']);
});

test('receipt includes workload egress from install, smoke, and build, not runner-only peers', () => {
  const item = profile();
  item.data.network.egress.peers.push(
    { remote_names: ['install.example', 'example.com'], proc_trees: [{ github_step: '0. Install dependencies' }] },
    { remote_address: '10.0.0.1', proc_trees: [{ github_step: 'Smoke test' }, { github_step: '99. Runner Processes' }] },
    { remote_address: '169.254.169.254', proc_trees: [{ github_step: 'Test' }] },
    { remote_names: ['unattributed.example'], proc_trees: [{ github_step: '<unknown>' }, {}] },
    { remote_names: ['setup.example'], proc_trees: [{ github_step: '1. Set up job' }] },
    { remote_names: ['post.example'], proc_trees: [{ github_step: '8. Post Run checkout' }] }
  );
  assert.deepEqual(summarizeEgress(item).observedWorkloadDestinations, ['10.0.0.1', '169.254.169.254', 'example.com', 'install.example']);
});

test('receipt uses recorded ancestry when workload and runner chains share the sentinel step', () => {
  const worker = ['systemd', 'Runner.Listener', 'Runner.Worker'];
  const sentinel = '99. Runner Processes';
  const item = profile();
  item.data.network.egress.peers = [
    { remote_names: ['dependency.example'], proc_trees: [
      { github_step: sentinel, ancestry: [...worker, 'bash', 'npm'] }
    ] },
    { remote_names: ['named-step.example'], proc_trees: [
      { github_step: '3. Install dependencies', ancestry: ['systemd', 'job-shell', 'npm'] }
    ] },
    { remote_address: '10.0.0.2', proc_trees: [
      { github_step: sentinel, ancestry: ['systemd', 'job-shell', 'node'] }
    ] },
    { remote_names: ['runner.example'], proc_trees: [
      { github_step: sentinel, ancestry: ['systemd', 'Runner.Listener'] }
    ] }
  ];
  assert.deepEqual(summarizeEgress(item).observedWorkloadDestinations, ['10.0.0.2', 'dependency.example', 'named-step.example']);
});

test('runner control traffic and cleanup do not become workload just because they use the worker', () => {
  const workerPath = ['systemd', 'Runner.Listener', 'Runner.Worker'];
  const item = profile();
  item.data.network.egress.peers = [
    { remote_names: ['worker.example'], proc_trees: [
      { github_step: '99. Runner Processes', ancestry: workerPath, process: 'Runner.Worker' },
      { github_step: '99. Runner Processes', process: 'Runner.Worker' }
    ] },
    { remote_names: ['cleanup.example'], proc_trees: [
      { github_step: '8. Post Run checkout', ancestry: [...workerPath, 'node'] },
      { github_step: '9. Complete job', ancestry: [...workerPath, 'bash'] }
    ] },
    { remote_names: ['setup.example'], proc_trees: [
      { github_step: '1. Set up job', ancestry: [...workerPath, 'node'] }
    ] }
  ];
  assert.deepEqual(summarizeEgress(item).observedWorkloadDestinations, []);
});

test('missing process trees are reported separately from workload and no egress', () => {
  const item = profile();
  item.data.network.egress.peers = [];
  assert.deepEqual(summarizeEgress(item), {
    observedWorkloadDestinations: [], unattributed: 0, unattributedDestinations: []
  });
  item.data.network.egress.peers.push(
    { remote_names: ['unattributed.example'], proc_trees: [] },
    { remote_address: '10.0.0.3' }
  );
  assert.deepEqual(summarizeEgress(item), {
    observedWorkloadDestinations: [], workloadAttribution: 'undeterminable',
    unattributed: 2, unattributedDestinations: ['10.0.0.3', 'unattributed.example']
  });
  item.data.network.egress.peers.push({
    remote_names: ['workload.example'], proc_trees: [{ github_step: '3. Install dependencies' }]
  });
  assert.deepEqual(summarizeEgress(item), {
    observedWorkloadDestinations: ['workload.example'], workloadAttribution: 'partial',
    unattributed: 2, unattributedDestinations: ['10.0.0.3', 'unattributed.example']
  });
});

test('stale, missing, duplicate and unreadable observations do not pass', async () => {
  const stale = profile();
  stale.data.scenarios.github.head_sha = base;
  for (const items of [[stale], [], [profile(), profile()]]) {
    assert.equal(await profileFor(context, id, async () => ({ items, pageInfo: { hasNextPage: false } })), null);
  }
  assert.equal(await profileFor(context, id, async () => ({
    items: [profile()], pageInfo: { hasNextPage: true, endCursor: 'repeated' }
  })), null);
  await assert.rejects(profileFor(context, id, async () => { throw new Error('unreadable'); }), /unreadable/);
});

test('the hosted comparison must match the linked App comment and capture run', async () => {
  const read = async (name, args) => {
    assert.equal(name, 'profiles');
    assert.equal(args.runID, '2');
    return { items: [profile()], pageInfo: { hasNextPage: false } };
  };
  const comment = {
    id: 42, html_url: url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: [
      '<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->',
      `<!-- garnet:commit ${head} -->`,
      `<!-- garnet:summary ${JSON.stringify(marker())} -->`,
      `<a href="https://github.com/${repo}/actions/runs/2/job/123">Job log</a>`,
      `<a href="https://app.garnet.ai/public/runs/2?profile=${id}">Full record</a>`
    ].join('\n')
  };
  const matched = await evidence(appEvidence(comment, context, 123), context, prBase, read);
  assert.equal(matched.verdict, 'nothing-new');
  assert.equal(matched.profile.id, id);
  assert.deepEqual(await evidence(appEvidence(comment, context, 123, {}), context, prBase, read), matched);
  assert.equal(await evidence(appEvidence(comment, context, 123, { run_attempt: 2 }), context, prBase, read), null);
  for (const body of [
    comment.body.replace('/runs/2/', '/runs/3/'),
    comment.body.replace('/job/123', '/job/124'),
    comment.body.replace('/public/runs/2?', '/public/runs/3?'),
    comment.body.replace('"incomplete":0', '"incomplete":1'),
    comment.body.replace(`<!-- garnet:commit ${head} -->`, `<!-- garnet:commit ${base} -->`),
    comment.body.replace(JSON.stringify(marker()), '{malformed}')
  ]) {
    assert.equal(await evidence(appEvidence({ ...comment, body }, context, 123), context, prBase, read), null);
  }
  assert.equal(await evidence(appEvidence(comment, { ...context, attempt: 2 }, 124),
    { ...context, attempt: 2 }, prBase, read), null);
});

test('a finalized App change with background additions but no workload delta stays scoped', () => {
  const background = marker({ outcome: 'changed', unattributed: 0, backgroundAdded: 8, backgroundRemoved: 2 });
  assert.equal(decide(background, head, base), 'background-only');
  for (const overrides of [{ unattributed: 1 }, { added: 1 }, { removed: 1 },
    { backgroundAdded: 0 }, { status: 'recording' }, { capture_quality: 'partial' }]) {
    assert.equal(decide({ ...background, ...overrides }, head, base), 'unknown');
  }
  assert.equal(decide({ ...background, changed: 1, added: 1 }, head, base), 'changed');
});

test('publishes head-bound checks; only observed changes hand work to Steward', async () => {
  for (const state of ['nothing-new', 'background-only', 'changed', 'removals-only', 'ci-failed', 'superseded']) {
    const run = {
      id: 2, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
      run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }],
      conclusion: state === 'ci-failed' ? 'failure' : 'success'
    };
    let reads = 0;
    let conclusion;
    const gh = async (path, payload, method) => {
      if (path === 'pulls/1') {
        return {
          state: 'open', base: { sha: base, ref: 'main' },
          head: { sha: ++reads >= 3 && state === 'superseded' ? base : head, repo: { full_name: repo } }
        };
      }
      if (path === 'check-runs') {
        assert.equal(payload.name, 'garnet/runtime-diff');
        assert.equal(payload.head_sha, head);
        assert.equal(payload.status, 'in_progress');
        assert.equal(payload.external_id, `1:main:${base}`);
        return { id: 57 };
      }
      if (path === 'actions/runs/2') return run;
      assert.equal(path, 'check-runs/57');
      assert.equal(method, 'PATCH');
      assert.equal(payload.status, 'completed');
      conclusion = payload.conclusion;
      assert.equal(payload.output.summary.includes('Garnet receipt lookup selectors'), state === 'changed');
      if (state === 'removals-only') assert.equal(payload.output.title, 'Runtime destinations no longer seen');
      if (state === 'background-only') assert.equal(payload.output.title, 'No new workload connections recorded');
    };
    await publish(run, repo, gh, async (_gh, observed, baseline) => {
      assert.notEqual(state, 'ci-failed');
      assert.deepEqual(observed, context);
      assert.deepEqual(baseline, prBase);
      return { verdict: state === 'superseded' ? 'nothing-new' : state, url, profile: profile(), comparisonBase: base };
    });
    assert.equal(conclusion, {
      'nothing-new': 'success', 'background-only': 'success', changed: 'failure'
    }[state] ?? 'action_required');
  }
});

test('main advancing invalidates old successes but keeps comparisons for the current base', async () => {
  const oldBase = 'c'.repeat(40);
  const event = { ref: 'refs/heads/main', before: oldBase, after: base };
  const pull = {
    number: 1, state: 'open', base: { ref: 'main', sha: oldBase },
    head: { sha: head, repo: { full_name: repo } }
  };
  const outdated = {
    id: 11, name: 'garnet/runtime-diff', app: { id: 15368 }, conclusion: 'success',
    external_id: `1:main:${oldBase}`,
    output: { summary: `[Garnet Runtime Review](${url}) · compared with \`${oldBase}\`.` }
  };
  const writes = [];
  const gh = async (path, body, method) => {
    if (path === 'git/ref/heads/main') return { object: { sha: base } };
    if (path === 'pulls?state=open&base=main&sort=created&direction=asc&per_page=100&page=1') return [
      pull, { ...pull, number: 2, head: { ...pull.head, repo: { full_name: 'other/fork' } } }
    ];
    if (path === 'pulls/1') return pull;
    if (path === `commits/${head}/check-runs?check_name=garnet%2Fruntime-diff&filter=all&per_page=100&page=1`) return {
      check_runs: [
        outdated, { ...outdated, id: 12, external_id: `1:main:${base}` },
        { ...outdated, id: 13, external_id: '' },
        { ...outdated, id: 14, app: { id: 99 } },
        { ...outdated, id: 15, output: { summary: outdated.output.summary.replace('/pull/1', '/pull/2') } },
        { ...outdated, id: 16, conclusion: 'failure' }
      ]
    };
    writes.push([path, body.status, body.conclusion, method]);
  };
  assert.equal(await invalidateAdvancedBaseChecks(event, repo, gh), 2);
  assert.deepEqual(writes, [
    ['check-runs/11', 'completed', 'action_required', 'PATCH'],
    ['check-runs/13', 'completed', 'action_required', 'PATCH']
  ]);
  assert.equal(await invalidateAdvancedBaseChecks({ ...event, ref: 'refs/heads/feature' }, repo,
    async () => assert.fail('unrelated push')), undefined);
});

test('a publisher cannot leave a passing check if main advanced during publication', async () => {
  const run = {
    id: 2, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
    run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }], conclusion: 'success'
  };
  const conclusions = [];
  const gh = async (path, body) => {
    if (path === 'pulls/1') return {
      state: 'open', base: { ref: 'main', sha: conclusions.length ? 'c'.repeat(40) : base },
      head: { sha: head, repo: { full_name: repo } }
    };
    if (path === 'actions/runs/2') return run;
    if (path === 'check-runs') return { id: 1 };
    assert.equal(path, 'check-runs/1');
    conclusions.push(body.conclusion);
  };
  assert.equal(await publish(run, repo, gh, async () => ({
    verdict: 'nothing-new', url, profile: profile(), comparisonBase: base
  })), `garnet/runtime-diff: superseded on ${head}`);
  assert.deepEqual(conclusions, ['success', 'action_required']);
});

test('MCP transport handles JSON and SSE, but never parses tool text as evidence', async () => {
  const value = { one: 1 };
  const result = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: value } });
  assert.deepEqual(await mcp('pr_review', {}, async () => new Response(result)), value);
  assert.deepEqual(await mcp('pr_review', {}, async () => new Response(`data: ${result}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' }
  })), value);
  await assert.rejects(mcp('pr_review', {}, async () => Response.json({
    id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] }
  })), /did not return structured evidence/);
});
