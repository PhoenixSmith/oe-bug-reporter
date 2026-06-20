// Cloudflare Worker — Orbit Economica Bug Reporter API
// Receives bug reports from OE Electron app, creates Linear issues + attachments.
// POST-only. No web form.
//
// Attachment flow: file → GitHub Gist → attachmentCreate with raw URL

const GIST_API = 'https://api.github.com/gists';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
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
      const description = formData.get('description')?.trim();
      const steps = formData.get('steps')?.trim();
      const platform = formData.get('platform') || 'Unknown';
      const severity = formData.get('severity') || 'Moderate';
      const version = formData.get('version') || 'Unknown';
      const screenshot = formData.get('screenshot');
      const saveGame = formData.get('saveGame');

      if (!description || !steps) {
        return json({ error: 'Description and steps to reproduce are required.' }, 400);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
