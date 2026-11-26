import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const sha = /^[a-f0-9]{40}$/;
const repoName = /^[\w.-]+\/[\w.-]+$/;
const profileID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const captureWorkflow = '.github/workflows/ci.yml';
const captureJob = 'runtime-build';
const checkName = 'garnet/runtime-diff';
const actionsAppId = 15368;
const endpoint = 'https://api.garnet.ai/api/v2/mcp';
const exec = promisify(execFile);

export async function mcp(name, args, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Garnet MCP HTTP ${response.status}`);
  const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
      return data.length ? [JSON.parse(data.join('\n'))] : [];
    }).find(event => event.id === 1)
    : JSON.parse(body);
  if (message?.id !== 1 || message.error || message.result?.isError || !message.result?.structuredContent) {
    throw new Error('Garnet MCP did not return structured evidence');
  }
  return message.result.structuredContent;
}

function github(repo, token) {
  if (typeof repo !== 'string' || !repoName.test(repo)) throw new Error('Invalid repository');
  return async (path, body, method = 'POST') => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { method, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return response.json();
  };
}

export function decide(review, head, base) {
  const marker = review?.envelope;
  if (!sha.test(head) || !sha.test(base) ||
      review?.bound_to_head !== true ||
      review.head_sha !== head || review.marker_commit !== head || marker?.commit !== head ||
      review.status !== 'finalized' || marker.status !== 'finalized' ||
      !['complete', 'best-effort'].includes(review.capture_quality) ||
      marker.capture_quality !== review.capture_quality || marker.incomplete !== 0 ||
      marker.jobs !== 1 || !['pr-base', 'base-ancestor'].includes(review.scope) || marker.scope !== review.scope ||
      marker.previous !== base || marker.outcome !== review.result) return 'unknown';
  if (review.result === 'changed' && marker.changed === 1) return 'changed';
  if (review.result === 'unchanged' && marker.changed === 0 && marker.added === 0) {
    if (marker.removed === 0) return 'nothing-new';
    if (Number.isSafeInteger(marker.removed) && marker.removed > 0) return 'removals-only';
  }
  return 'unknown';
}

export function matchesRun(run, { repo, pr, head, attempt }) {
  return run?.path === captureWorkflow && run.event === 'pull_request' &&
    run.head_sha === head && run.run_attempt === attempt &&
    run.head_repository?.full_name === repo && run.pull_requests?.length === 1 &&
    run.pull_requests[0]?.number === pr;
}

export async function profileFor({ repo, head, run, attempt }, id, call = mcp) {
  if (typeof id !== 'string' || !profileID.test(id)) return null;
  const [githubOrg, name] = repo.split('/');
  const seen = new Set();
  let after;
  let match = null;
  do {
    const page = await call('profiles', {
      githubOrg, repo: name, runID: String(run), runAttempt: attempt, job: captureJob,
      pageArgs: { first: 10, ...(after === undefined ? {} : { after }) }
    });
    if (!Array.isArray(page.items) || typeof page.pageInfo?.hasNextPage !== 'boolean') return null;
    for (const item of page.items) {
      if (item?.id !== id) continue;
      const metadata = item.data?.scenarios?.github;
      if (match || item.githubOrg !== githubOrg || item.repo !== name ||
          String(item.runID) !== String(run) || item.runAttempt !== attempt || item.job !== captureJob ||
          (metadata?.head_sha && metadata.head_sha !== head) ||
          !Array.isArray(item.data?.network?.egress?.peers)) return null;
      // The App-provided profile ID ties the record to the head even if the
      // profile only carries a GitHub test-merge SHA.
      match = item;
    }
    if (!page.pageInfo.hasNextPage) return match;
    after = page.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || seen.has(after) || seen.size >= 9) return null;
    seen.add(after);
  } while (true);
}

export function isGarnetComment(comment, head, url) {
  if (comment?.html_url !== url || comment.user?.id !== 210813234 ||
      comment.performed_via_github_app?.id !== 1249875 || typeof comment.body !== 'string') return false;
  const lines = comment.body.split(/\r?\n/);
  return lines.includes('<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->') &&
    lines.includes(`<!-- garnet:commit ${head} -->`);
}

export async function evidence(gh, context, base, call = mcp) {
  const { repo, pr, head, run } = context;
  const [githubOrg, name] = repo.split('/');
  const review = await call('pr_review', { githubOrg, repo: name, pullNumber: pr });
  const verdict = decide(review, head, base);
  if (verdict === 'unknown' || !Array.isArray(review.profile_ids) || review.profile_ids.length !== 1) return null;
  const url = `https://github.com/${repo}/pull/${pr}#issuecomment-`;
  const commentId = review.comment_url?.startsWith(url) && review.comment_url.slice(url.length);
  if (!/^[1-9]\d*$/.test(commentId || '')) return null;
  const comment = await gh(`issues/comments/${commentId}`);
  if (!isGarnetComment(comment, head, review.comment_url) ||
      !comment.body.includes(`https://github.com/${repo}/actions/runs/${run}/job/`)) return null;
  const markers = comment.body.split(/\r?\n/).flatMap(line => {
    const match = /^<!-- garnet:summary (\{.*\}) -->$/.exec(line);
    return match ? [JSON.parse(match[1])] : [];
  });
  const fields = [
    'commit', 'previous', 'outcome', 'scope', 'status', 'capture_quality', 'recorded',
    'incomplete', 'jobs', 'changed', 'added', 'removed'
  ];
  if (markers.length !== 1 || fields.some(key => markers[0][key] !== review.envelope[key])) return null;
  const profile = await profileFor(context, review.profile_ids[0], call);
  return profile ? { verdict, profile, url: review.comment_url } : null;
}

function selectors(repo, pr, head, run, attempt) {
  if (!repoName.test(repo) || !sha.test(head) ||
      ![pr, run, attempt].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid selectors');
  return { repo, pr, head, run, attempt };
}

function current(pull, context) {
  return pull?.state === 'open' && pull.head?.sha === context.head &&
    pull.head.repo?.full_name === context.repo && pull.base?.ref === 'main' &&
    sha.test(pull.base.sha);
}

function checkBase(pr, base) {
  return `${pr}:${base.ref}:${base.sha}`;
}

function invalidateCheck(gh, id) {
  return gh(`check-runs/${id}`, {
    status: 'completed',
    conclusion: 'action_required',
    output: {
      title: 'No usable runtime comparison',
      summary: 'The PR base advanced. A fresh capture and comparison are required.'
    }
  }, 'PATCH');
}

export async function invalidateAdvancedBaseChecks(event, repo, gh) {
  if (event?.ref !== 'refs/heads/main' || event.deleted || !sha.test(event.after) || event.before === event.after) return;
  let invalidated = 0;
  for (let page = 1; ; page++) {
    const pulls = await gh(`pulls?state=open&base=main&sort=created&direction=asc&per_page=100&page=${page}`);
    if (!Array.isArray(pulls)) throw new Error('GitHub did not return pull requests');
    for (const pull of pulls) {
      const pr = pull?.number;
      const head = pull?.head?.sha;
      if (!Number.isSafeInteger(pr) || pr <= 0 || !sha.test(head) || !current(pull, { repo, head })) continue;
      const commentPrefix = `[Garnet Runtime Review](https://github.com/${repo}/pull/${pr}#issuecomment-`;
      for (let index = 1; ; index++) {
        const result = await gh(`commits/${head}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100&page=${index}`);
        if (!Array.isArray(result?.check_runs)) throw new Error('GitHub did not return check runs');
        for (const check of result.check_runs) {
          if (check.name !== checkName || check.app?.id !== actionsAppId || check.conclusion !== 'success' ||
              !check.output?.summary?.startsWith(commentPrefix) || !Number.isSafeInteger(check.id) || check.id <= 0) continue;
          const latest = await gh(`pulls/${pr}`);
          if (!current(latest, { repo, head }) || check.external_id === checkBase(pr, latest.base)) continue;
          await invalidateCheck(gh, check.id);
          invalidated++;
        }
        if (result.check_runs.length < 100) break;
      }
    }
    if (pulls.length < 100) return invalidated;
  }
}

export async function publish(run, repo, gh, readEvidence = evidence) {
  if (run?.pull_requests?.length !== 1) throw new Error('Missing trusted run context');
  const context = selectors(repo, run.pull_requests[0].number, run.head_sha, run.id, run.run_attempt);
  const { pr, head } = context;
  if (!matchesRun(run, context)) throw new Error('Not a same-repository exhibit run');
  const getPR = () => gh(`pulls/${pr}`);
  const initial = await getPR();
  if (!current(initial, context)) return;
  const base = initial.base.sha;
  const check = await gh('check-runs', {
    name: checkName, head_sha: head, status: 'in_progress', external_id: checkBase(pr, initial.base),
    details_url: `https://github.com/${repo}/actions/runs/${run.id}`,
    output: { title: 'Waiting for Garnet evidence', summary: 'Only the current PR head is evaluated.' }
  });
  let result = null;
  if (run.conclusion === 'success') {
    const deadline = Date.now() + 480_000;
    for (let tries = 0; tries < 24 && !result && Date.now() < deadline; tries++) {
      if (tries > 0) await wait(15_000);
      const pull = await getPR();
      if (!current(pull, context) || pull.base.sha !== base) break;
      try {
        result = await readEvidence(gh, context, base);
      } catch {
        console.log('Garnet evidence not readable yet.');
      }
    }
  }
  const latest = await getPR();
  const githubRun = await gh(`actions/runs/${run.id}`);
  const active = current(latest, context) && latest.base.sha === base && matchesRun(githubRun, context);
  const verdict = active ? (result?.verdict ?? 'unknown') : 'superseded';
  const args = [repo, pr, head, run.id, run.run_attempt].join(' ');
  const conclusion = verdict === 'nothing-new' ? 'success' : verdict === 'changed' ? 'failure' : 'action_required';
  const titles = {
    'nothing-new': 'No new runtime behavior recorded',
    changed: 'Runtime behavior changed',
    'removals-only': 'Runtime destinations no longer seen'
  };
  const output = Object.hasOwn(titles, verdict)
    ? {
      title: titles[verdict],
      summary: [
        `[Garnet Runtime Review](${result.url}) · compared with \`${base}\` · capture is best-effort.`,
        `Head \`${head}\` · Linux run \`${run.id}\` attempt \`${run.run_attempt}\` · MCP profile \`${result.profile.id}\`.`,
        ...(verdict === 'changed' ? [`Garnet receipt lookup selectors: \`${args}\`.`] : []),
        ...(verdict === 'removals-only' ? ['The exhibit holds removal-only comparisons for human review.'] : [])
      ].join('\n\n')
    }
    : { title: 'No usable runtime comparison', summary: 'No passing gate was issued. Do not attempt a code fix from this check.' };
  await gh(`check-runs/${check.id}`, { status: 'completed', conclusion, output }, 'PATCH');
  if (conclusion === 'success') {
    const published = await getPR();
    if (!current(published, context) || published.base.sha !== base) {
      await invalidateCheck(gh, check.id);
      return `${checkName}: superseded on ${head}`;
    }
  }
  return `${checkName}: ${verdict} on ${head}`;
}

function stepName(proc) {
  if (typeof proc?.github_step !== 'string') return '';
  return proc.github_step.replace(/^\d+\.\s+/, '').replace(/\(\s*\$\{\{[^}]*\}\}\s*\)|\$\{\{[^}]*\}\}/g, '').trim();
}

function isInfrastructureStep(step) {
  return /^(?:Set up job|Complete job|Post Run(?: .*)?)$/i.test(step);
}

function hasRecordedStep(step) {
  return !!step && !/^(?:<unknown>|Runner Processes)$/i.test(step);
}

function processPath(proc) {
  const path = Array.isArray(proc?.ancestry) ? proc.ancestry.filter(Boolean) : [];
  if (proc?.process && path.at(-1) !== proc.process) path.push(proc.process);
  return path;
}

function isWorkloadChain(proc, stepAnchors) {
  const step = stepName(proc);
  if (isInfrastructureStep(step)) return false;
  if (hasRecordedStep(step)) return true;
  const path = processPath(proc);
  if (path.at(-1) === 'Runner.Worker' || path.at(-1) === 'Runner.Listener') return false;
  return path.slice(0, -1).includes('Runner.Worker') || stepAnchors.has(path[1]);
}

export function workloadEgress(profile) {
  const peers = profile.data.network.egress.peers;
  const stepAnchors = new Set();
  for (const peer of peers) {
    if (!Array.isArray(peer?.proc_trees)) continue;
    for (const proc of peer.proc_trees) {
      const step = stepName(proc);
      if (!hasRecordedStep(step) || isInfrastructureStep(step)) continue;
      const path = processPath(proc);
      if (path[1] && !path.includes('Runner.Worker')) stepAnchors.add(path[1]);
    }
  }
  const names = new Set();
  for (const peer of peers) {
    if (!Array.isArray(peer?.proc_trees) || !peer.proc_trees.some(proc => isWorkloadChain(proc, stepAnchors))) continue;
    const destinations = Array.isArray(peer.remote_names) && peer.remote_names.length
      ? peer.remote_names : [peer.remote_address];
    for (const name of destinations) {
      if (typeof name === 'string' && /^[a-zA-Z0-9.:[\]_-]{1,253}$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

async function receipt(args) {
  const [repo, pr, head, run, attempt] = args;
  const context = selectors(repo, Number(pr), head, Number(run), Number(attempt));
  const gh = async path => {
    const { stdout } = await exec('gh', ['api', `repos/${repo}/${path}`], { timeout: 15_000 });
    return JSON.parse(stdout);
  };
  const pull = await gh(`pulls/${context.pr}`);
  const githubRun = await gh(`actions/runs/${context.run}`);
  if (!current(pull, context) || !matchesRun(githubRun, context)) throw new Error('Selectors do not match the current PR head and capture run');
  const result = await evidence(gh, context, pull.base.sha);
  const latest = await gh(`pulls/${context.pr}`);
  if (result?.verdict !== 'changed' || !current(latest, context) || latest.base.sha !== pull.base.sha) {
    throw new Error('No current changed receipt is available');
  }
  console.log(JSON.stringify({
    MCP: endpoint, tool: 'profiles', id: result.profile.id, ...context,
    job: captureJob, appComment: result.url, observedWorkloadDestinations: workloadEgress(result.profile)
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (['publish', 'invalidate-base'].includes(process.argv[2]) && process.argv.length === 3) {
      const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, GITHUB_EVENT_PATH: event } = process.env;
      if (!token || !event) throw new Error('Missing trusted workflow context');
      const payload = JSON.parse(await readFile(event, 'utf8'));
      const gh = github(repo, token);
      if (process.argv[2] === 'publish') {
        const status = await publish(payload.workflow_run, repo, gh);
        if (status) console.log(status);
      } else {
        const count = await invalidateAdvancedBaseChecks(payload, repo, gh);
        if (count !== undefined) console.log(`Invalidated ${count} passing comparison(s) for superseded base commits.`);
      }
    } else if (process.argv[2] === 'receipt' && process.argv.length === 8) await receipt(process.argv.slice(3));
    else throw new Error('Use publish, invalidate-base, or receipt <owner/repo> <pr> <head> <run> <attempt>');
  } catch {
    console.error('Runtime Review stopped: selectors, evidence, or required GitHub access were not available.');
    process.exitCode = 1;
  }
}
