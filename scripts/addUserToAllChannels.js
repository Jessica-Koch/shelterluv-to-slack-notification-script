require('dotenv').config();

const CHANNEL_SLACK_BOT_TOKEN = process.env.CHANNEL_SLACK_BOT_TOKEN;
const USER_ID = process.argv[2];

if (!CHANNEL_SLACK_BOT_TOKEN) {
  console.error('Missing CHANNEL_SLACK_BOT_TOKEN in .env');
  process.exit(1);
}

if (!USER_ID) {
  console.error('Usage: node scripts/addUserToAllChannels.js <SLACK_USER_ID>');
  process.exit(1);
}

async function slackGet(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CHANNEL_SLACK_BOT_TOKEN}` },
  });
  return res.json();
}

async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getAllChannels() {
  const channels = [];
  let cursor;
  do {
    const params = {
      limit: 200,
      exclude_archived: true,
      types: 'public_channel',
    };
    if (cursor) params.cursor = cursor;
    const data = await slackGet('conversations.list', params);
    if (!data.ok) throw new Error(`conversations.list failed: ${data.error}`);
    channels.push(...data.channels);
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);
  return channels;
}

async function main() {
  console.log(`Fetching all public channels...`);
  const channels = await getAllChannels();
  console.log(`Found ${channels.length} channels. Adding user ${USER_ID}...`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const channel of channels) {
    // Bot must be in the channel before it can invite others
    await slackPost('conversations.join', { channel: channel.id });

    const data = await slackPost('conversations.invite', {
      channel: channel.id,
      users: USER_ID,
    });

    if (data.ok) {
      console.log(`  + Added to #${channel.name}`);
      added++;
    } else if (data.error === 'already_in_channel') {
      skipped++;
    } else {
      console.warn(`  ! Failed #${channel.name}: ${data.error}`);
      failed++;
    }

    // Slack rate limit: ~50 req/min for this method
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log(
    `\nDone. Added: ${added}, Already in: ${skipped}, Failed: ${failed}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
