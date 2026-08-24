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
