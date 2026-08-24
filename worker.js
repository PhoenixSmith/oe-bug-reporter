// Cloudflare Worker — Orbit Economica Bug Reporter API
// Receives bug reports from OE Electron app, creates Linear issues + attachments.
// POST-only. No web form.
//
// Attachment flow: file → GitHub Gist → attachmentCreate with raw URL

const GIST_API = 'https://api.github.com/gists';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'oe-bug-reporter' });
    }

    if (url.pathname === '/admin/health' && request.method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true, service: 'oe-bug-reporter', linearConfigured: Boolean(env.LINEAR_API_KEY), githubConfigured: Boolean(env.GITHUB_TOKEN) });
    }

    if (url.pathname === '/admin/issues' && request.method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return listIssues(env, url);
    }

    const issueMatch = url.pathname.match(/^\/admin\/issues\/([^/]+)$/);
    if (issueMatch && request.method === 'PATCH') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return updateIssue(request, env, decodeURIComponent(issueMatch[1]));
    }

    if (request.method === 'GET') {
      return json({ message: 'OE Bug Reporter API. POST bug reports here.', usage: 'POST with FormData: description, steps, severity, version, platform, screenshot?, saveGame?' }, 200);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const apiKey = env.LINEAR_API_KEY;
    const teamId = env.LINEAR_TEAM_ID || '296eb9e7-4dab-4744-9e05-b56a5888a20b';
    const bugLabelId = env.LINEAR_BUG_LABEL_ID || 'cd717ce7-fe84-4eea-9385-1acd11d9e224';

    if (!apiKey) {
      return json({ error: 'Bug reporter not configured' }, 500);
    }

    try {
      const formData = await request.formData();
      const description = textField(formData.get('description'))?.trim();
      const steps = textField(formData.get('steps'))?.trim();
      const platform = formData.get('platform') || 'Unknown';
      const severity = formData.get('severity') || 'Moderate';
      const version = formData.get('version') || 'Unknown';
      const screenshot = formData.get('screenshot');
      const saveGame = formData.get('saveGame');

      if (!description || !steps) {
        return json({ error: 'Description and steps to reproduce are required.' }, 400);
      }
      if (description.length > 10_000 || steps.length > 10_000) {
        return json({ error: 'Description and steps must be 10,000 characters or fewer.' }, 400);
      }

      const issueDescription = [
        `**What happened?**\n${description}\n`,
        `**Steps to reproduce:**\n${steps}\n`,
        `**Platform:** ${platform}`,
        `**Severity:** ${severity}`,
        `**Version:** ${version}`,
        saveGame instanceof File ? `**Save game:** Attached` : `**Save game:** Not attached`,
        `**Reported via:** In-Game Bug Reporter`,
      ].join('\n');

      const issueRes = await linearFetch('https://api.linear.app/graphql', apiKey, {
        query: `
          mutation createBugIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              issue { id identifier url }
            }
          }
        `,
        variables: {
          input: {
            teamId,
            title: `[Bug] ${truncate(description, 80)}`,
            description: issueDescription,
            labelIds: [bugLabelId],
          },
        },
      });

      const issueData = await issueRes.json();
      if (issueData.errors?.length) {
        console.error('Linear errors:', JSON.stringify(issueData.errors));
        return json({ error: 'Failed to create issue' }, 500);
      }

      const issue = issueData.data.issueCreate.issue;
      let attachmentStatus = 'none';

      // Upload save game if present
      if (saveGame && saveGame instanceof File && saveGame.size > 0) {
        try {
          await uploadFileAsAttachment(apiKey, env.GITHUB_TOKEN, issue.id, issue.identifier, saveGame, 'Save Game');
          attachmentStatus = 'uploaded';
        } catch (uploadErr) {
          attachmentStatus = `failed: ${uploadErr.message}`;
          console.error('Save game upload failed:', attachmentStatus);
        }
      }

      // Upload screenshot if present
      if (screenshot && screenshot instanceof File && screenshot.size > 0) {
        try {
          await uploadFileAsAttachment(apiKey, env.GITHUB_TOKEN, issue.id, issue.identifier, screenshot, 'Bug Screenshot');
        } catch (uploadErr) {
          console.error('Screenshot upload failed (non-fatal):', uploadErr.message);
        }
      }

      return json({ success: true, issue: { id: issue.identifier, url: issue.url }, attachmentStatus });
    } catch (err) {
      console.error('Bug reporter error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

async function uploadFileAsAttachment(apiKey, githubToken, issueId, issueIdentifier, file, title) {
  const fileContent = await file.text();
  const fileName = file.name || 'attachment';

  // 1. Create a secret Gist with the file
  const gistRes = await fetch(GIST_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'oe-bug-reporter',
    },
    body: JSON.stringify({
      description: `Bug report attachment for ${issueIdentifier}`,
      public: false,
      files: {
        [fileName]: { content: fileContent },
      },
    }),
  });

  if (!gistRes.ok) {
    const err = await gistRes.text();
    throw new Error(`Gist creation failed (${gistRes.status}): ${err}`);
  }

  const gist = await gistRes.json();
  const rawUrl = gist.files[fileName]?.raw_url;
  if (!rawUrl) throw new Error('No raw_url in gist response');

  // 2. Create Linear attachment linking to the raw file
  const attachRes = await linearFetch('https://api.linear.app/graphql', apiKey, {
    query: `
      mutation ($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          attachment { id url }
        }
      }
    `,
    variables: {
      input: {
        issueId,
        title: `${title} (${fileName})`,
        url: rawUrl,
      },
    },
  });

  const attachData = await attachRes.json();
  if (attachData.errors?.length) {
    throw new Error('attachmentCreate failed: ' + JSON.stringify(attachData.errors));
  }

  return attachData;
}

async function linearFetch(url, apiKey, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify(body),
  });
}

async function listIssues(env, url) {
  const first = Math.min(Math.max(Number(url.searchParams.get('limit')) || 25, 1), 100);
  const response = await linearFetch('https://api.linear.app/graphql', env.LINEAR_API_KEY, {
    query: `query ListBugIssues($teamId: ID!, $labelId: ID!, $first: Int!) {
      issues(first: $first, orderBy: updatedAt, filter: { team: { id: { eq: $teamId } }, labels: { id: { eq: $labelId } } }) {
        nodes { id identifier title url createdAt updatedAt priority description state { id name type } }
      }
    }`,
    variables: {
      teamId: env.LINEAR_TEAM_ID || '296eb9e7-4dab-4744-9e05-b56a5888a20b',
      labelId: env.LINEAR_BUG_LABEL_ID || 'cd717ce7-fe84-4eea-9385-1acd11d9e224',
      first,
    },
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    console.error('Linear issue list failed:', JSON.stringify(body.errors || body));
    return json({ error: 'Failed to list issues' }, 502);
  }
  return json({ issues: body.data?.issues?.nodes || [] });
}

async function updateIssue(request, env, identifier) {
  let input;
  try { input = await request.json(); } catch { return json({ error: 'Expected a JSON body.' }, 400); }
  const allowed = ['title', 'description', 'priority', 'stateId', 'assigneeId'];
  const update = Object.fromEntries(allowed.filter((key) => input?.[key] !== undefined).map((key) => [key, input[key]]));
  if (!Object.keys(update).length) return json({ error: 'At least one supported field is required.' }, 400);
  const response = await linearFetch('https://api.linear.app/graphql', env.LINEAR_API_KEY, {
    query: `mutation UpdateBugIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id identifier title url state { id name type } } }
    }`,
    variables: { id: identifier, input: update },
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length || !body.data?.issueUpdate?.success) {
    console.error('Linear issue update failed:', JSON.stringify(body.errors || body));
    return json({ error: 'Failed to update issue' }, 502);
  }
  return json({ issue: body.data.issueUpdate.issue });
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(token && (token === env.ADMIN_TOKEN || token === env.LINEAR_API_KEY));
}

function textField(value) {
  return typeof value === 'string' ? value : undefined;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
