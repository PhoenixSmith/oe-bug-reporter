import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const baseEnv = {
  LINEAR_API_KEY: 'linear-test-key',
  ADMIN_TOKEN: 'admin-test-key',
  LINEAR_TEAM_ID: 'team-test',
  LINEAR_BUG_LABEL_ID: 'label-test',
};

function request(path, init = {}) {
  return new Request(`https://test.invalid${path}`, init);
}

test('health is public and reports service identity', async () => {
  const response = await worker.fetch(request('/health'), baseEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'oe-bug-reporter' });
});

test('admin endpoints reject missing or invalid credentials', async () => {
  for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
    const response = await worker.fetch(request('/admin/health', { headers }), baseEnv);
    assert.equal(response.status, 401);
  }
});

test('admin health accepts the dedicated admin token', async () => {
  const response = await worker.fetch(request('/admin/health', { headers: { Authorization: 'Bearer admin-test-key' } }), baseEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'oe-bug-reporter',
    linearConfigured: true,
    githubConfigured: false,
  });
});

test('bug reports validate string fields before calling Linear', async () => {
  const form = new FormData();
  form.append('description', new Blob(['not text']), 'bad.txt');
  form.append('steps', 'step');
  const response = await worker.fetch(request('/', { method: 'POST', body: form }), baseEnv);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /required/);
});

test('admin issue list proxies the bug-labelled Linear query', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.query, /ListBugIssues/);
    assert.deepEqual(body.variables, { teamId: 'team-test', labelId: 'label-test', first: 10 });
    return new Response(JSON.stringify({ data: { issues: { nodes: [{ identifier: 'ORB-1' }] } } }), { status: 200 });
  };
  const response = await worker.fetch(request('/admin/issues?limit=10', { headers: { Authorization: 'Bearer admin-test-key' } }), baseEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { issues: [{ identifier: 'ORB-1' }] });
});

test('crash report POST attaches logs and is tagged Desktop Crash Reporter', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const logContent = '2026-09-01T00:00:00Z [main/warn] renderer crashed\n';
  const calls = { gistContent: null, createBody: null };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('api.github.com/gists')) {
      calls.gistContent = body.files['crash.log'].content;
      return new Response(JSON.stringify({ files: { 'crash.log': { raw_url: 'https://gist.example/raw/crash.log' } } }), { status: 200 });
    }
    if (String(url).includes('api.linear.app')) {
      if (body.query.includes('issueCreate')) {
        calls.createBody = body;
        return new Response(JSON.stringify({ data: { issueCreate: { issue: { id: 'iss-id', identifier: 'ORB-LOG', url: 'https://linear.example/ORB-LOG' } } } }), { status: 200 });
      }
      if (body.query.includes('attachmentCreate')) {
        return new Response(JSON.stringify({ data: { attachmentCreate: { attachment: { id: 'att-id', url: 'https://linear.example/att' } } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    throw new Error('unexpected fetch: ' + url);
  };

  const form = new FormData();
  form.append('description', 'renderer crashed during galaxy load');
  form.append('steps', '1. launch the game');
  form.append('severity', 'Crash');
  form.append('logs', new Blob([logContent]), 'crash.log');

  const env = { ...baseEnv, GITHUB_TOKEN: 'github-test-token' };
  const response = await worker.fetch(request('/', { method: 'POST', body: form }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    issue: { id: 'ORB-LOG', url: 'https://linear.example/ORB-LOG' },
    attachmentStatus: 'none',
  });

  const description = calls.createBody.variables.input.description;
  assert.match(description, /\*\*Logs:\*\* Attached/);
  assert.match(description, /\*\*Reported via:\*\* Desktop Crash Reporter/);
  assert.doesNotMatch(description, /\*\*Logs:\*\* Not attached/);
  // The crash log body is what actually hit the GitHub Gist upload.
  assert.equal(calls.gistContent, logContent);
});

test('in-game bug report without logs is tagged In-Game Bug Reporter', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let createBody = null;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('api.linear.app') && body.query.includes('issueCreate')) {
      createBody = body;
      return new Response(JSON.stringify({ data: { issueCreate: { issue: { id: 'iss-id', identifier: 'ORB-ING', url: 'https://linear.example/ORB-ING' } } } }), { status: 200 });
    }
    throw new Error('unexpected fetch: ' + url);
  };

  const form = new FormData();
  form.append('description', 'guild ledger shows odd totals');
  form.append('steps', 'open the ledger');
  const response = await worker.fetch(request('/', { method: 'POST', body: form }), baseEnv);
  assert.equal(response.status, 200);

  const description = createBody.variables.input.description;
  assert.match(description, /\*\*Logs:\*\* Not attached/);
  assert.match(description, /\*\*Reported via:\*\* In-Game Bug Reporter/);
});

test('admin issue update proxies only supported fields', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.variables, { id: 'ORB-1', input: { stateId: 'state-done', priority: 1 } });
    return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: { identifier: 'ORB-1', title: 'Fixed' } } } }), { status: 200 });
  };
  const response = await worker.fetch(request('/admin/issues/ORB-1', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer admin-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ stateId: 'state-done', priority: 1, malicious: 'ignored' }),
  }), baseEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { issue: { identifier: 'ORB-1', title: 'Fixed' } });
});
