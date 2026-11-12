#!/usr/bin/env node
/* Go Voltic site scan, as a GitHub Action.
 *
 * Dependency-free: everything here is a Node builtin (fs, global fetch). No
 * package.json, no node_modules, nothing to audit or to go stale.
 *
 * WHAT IT SENDS: the url input, and nothing else. No secret is read and none
 * is needed, because https://go-voltic.com/mcp takes no key, no token and no
 * sign-in.
 *
 * TWO CALLS, IN ORDER, matching what a conforming MCP client does: initialize
 * first, then tools/call for scan_site. This endpoint does not actually
 * enforce that order, but a tool that skips initialize is not a fair test of
 * what a real client will hit in production.
 *
 * NEVER PRINT A SCORE WITHOUT ONE. A rate limit (429) or a network failure
 * (fetch throws, or the body is not the JSON-RPC shape expected) fails the
 * step with the reason and leaves the score and report-url outputs unset.
 * fail-under only ever fails a run that DID produce a score; it is a
 * judgement about that score, not a stand-in for "something went wrong".
 */
const ENDPOINT = 'https://go-voltic.com/mcp';

async function postRpc(fetchImpl, body) {
  return fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
}

/* categories: [{ label, score }], score null when nothing was measurable.
   NEVER "not measured" rendered as 0 -- the whole reason this table exists
   separately from a bare percentage. */
function categoriesTable(categories) {
  const rows = (categories || []).map(
    (c) => '| ' + c.label + ' | ' + (c.score == null ? 'not measured' : c.score + '/100') + ' |'
  );
  return ['| Category | Score |', '| --- | --- |'].concat(rows).join('\n');
}

function summaryMarkdown(url, result) {
  const lines = [
    '## Go Voltic site scan',
    '',
    '**' + url + ': ' + result.score + '/100.**',
    '',
    categoriesTable(result.categories),
    ''
  ];
  if (result.agent) {
    lines.push('Agent readiness: ' + result.agent.met + ' of ' + result.agent.of + ' published AI-agent standards met.', '');
  } else if (result.agentFailed) {
    lines.push('Agent readiness: not measured this run (' + result.agentFailed + ').', '');
  }
  const findings = (result.findings || []).slice(0, 3);
  if (findings.length) {
    lines.push('### First findings', '');
    for (const f of findings) lines.push('- **' + f.title + '** (' + f.sev + '). ' + (f.fix || ''));
    lines.push('');
  }
  return lines.join('\n');
}

/* The only honest "view this on the site" link a free, unauthenticated call
   can offer: there is no account, so no persistent report exists to link to.
   This re-runs the same free check in a browser. */
function reportUrlFor(url) {
  return 'https://go-voltic.com/scan?url=' + encodeURIComponent(url);
}

/* The one function with judgement calls in it, isolated so a test can drive
   every branch without a real network. Returns a plain result object;
   nothing here touches process.exit, files or env -- that is runMain's job. */
async function runScan({ url, fetchImpl }) {
  let initRes, callRes;
  try {
    initRes = await postRpc(fetchImpl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  } catch (e) {
    return { ok: false, reason: 'Could not reach ' + ENDPOINT + ': ' + describeError(e) };
  }
  if (initRes.status === 429) {
    return { ok: false, reason: 'Rate limited by ' + ENDPOINT + ' (429)' + retryAfterNote(initRes) };
  }
  if (!initRes.ok) {
    return { ok: false, reason: ENDPOINT + ' answered ' + initRes.status + ' to initialize' };
  }

  try {
    callRes = await postRpc(fetchImpl, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'scan_site', arguments: { url } }
    });
  } catch (e) {
    return { ok: false, reason: 'Could not reach ' + ENDPOINT + ': ' + describeError(e) };
  }
  if (callRes.status === 429) {
    return { ok: false, reason: 'Rate limited by ' + ENDPOINT + ' (429)' + retryAfterNote(callRes) };
  }
  if (!callRes.ok) {
    return { ok: false, reason: ENDPOINT + ' answered ' + callRes.status + ' to tools/call' };
  }

  let msg;
  try {
    msg = await callRes.json();
  } catch (e) {
    return { ok: false, reason: ENDPOINT + ' did not answer with valid JSON: ' + describeError(e) };
  }
  if (msg && msg.error) {
    return { ok: false, reason: 'scan_site refused the call: ' + msg.error.message };
  }
  const result = msg && msg.result;
  if (!result || result.isError) {
    const text = result && Array.isArray(result.content) && result.content[0] && result.content[0].text;
    return { ok: false, reason: text || 'The scan did not produce a result.' };
  }
  const scored = result.structuredContent;
  if (!scored || typeof scored.score !== 'number') {
    return { ok: false, reason: 'The scan answered without a score.' };
  }
  return { ok: true, score: scored.score, reportUrl: reportUrlFor(url), summary: summaryMarkdown(url, scored) };
}

function retryAfterNote(res) {
  const ra = res.headers && typeof res.headers.get === 'function' && res.headers.get('retry-after');
  return ra ? ', retry after ' + ra + 's' : '';
}

function describeError(e) {
  return String((e && e.message) || e).slice(0, 200);
}

function parseFailUnder(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function runMain() {
  const fs = require('node:fs');
  const url = (process.env.INPUT_URL || '').trim();
  const failUnder = parseFailUnder(process.env['INPUT_FAIL-UNDER']);

  if (!url) {
    console.log('::error::The url input is required.');
    process.exitCode = 1;
    return;
  }

  const outcome = await runScan({ url, fetchImpl: fetch });

  if (!outcome.ok) {
    console.log('::error::' + outcome.reason);
    process.exitCode = 1;
    return;
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'score=' + outcome.score + '\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'report-url=' + outcome.reportUrl + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, outcome.summary + '\n');
  }
  console.log('Go Voltic score for ' + url + ': ' + outcome.score + '/100');

  if (failUnder !== null && outcome.score < failUnder) {
    console.log('::error::Score ' + outcome.score + ' is below fail-under (' + failUnder + ').');
    process.exitCode = 1;
  }
}

module.exports = { runScan, summaryMarkdown, categoriesTable, reportUrlFor, parseFailUnder };

const isMain = require.main === module;
if (isMain) {
  runMain();
}
