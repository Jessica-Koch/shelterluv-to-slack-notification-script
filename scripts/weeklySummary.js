require('dotenv').config();

const SHELTERLUV_API_KEY = process.env.SHELTERLUV_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_WEEKLY_CHANNEL_ID;

if (!SHELTERLUV_API_KEY) {
  console.error('Missing SHELTERLUV_API_KEY env var');
}
if (!SLACK_BOT_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN env var');
}
if (!SLACK_CHANNEL_ID) {
  console.error(
    'Missing SLACK_WEEKLY_CHANNEL_ID (or SLACK_CHANNEL_ID) env var',
  );
}
if (!SHELTERLUV_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  process.exit(1);
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Convert Shelterluv unix-string (seconds) to JS Date
const unixStringToDate = (str) => {
  if (!str) return null;
  const seconds = Number(str);
  if (!Number.isFinite(seconds) || seconds === 0) return null;
  return new Date(seconds * 1000);
};

// Format date as M/D/YYYY
const formatDate = (date) => {
  if (!date || isNaN(date.getTime())) return 'unknown date';
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
};

// ---------- Shelterluv API ----------

const fetchAnimals = async (statusType, since = 0, sortByUpdated = false) => {
  const limit = 100;
  let offset = 0;
  const all = [];

  while (true) {
    const statusParam = statusType
      ? `&status_type=${encodeURIComponent(statusType)}`
      : '';
    const sortParam = sortByUpdated ? '&sort=updated_at' : '';
    const url = `https://new.shelterluv.com/api/v1/animals?since=${since}${statusParam}${sortParam}&limit=${limit}&offset=${offset}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `Shelterluv animals API error (${statusType}):`,
        res.status,
        text,
      );
      throw new Error(`Animals API request failed with ${res.status}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.animals) ? json.animals : json;

    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);

    if (json.has_more === false || batch.length < limit) break;

    offset += limit;
  }

  return all;
};

// ---------- Slack ----------

const postToSlack = async (payload) => {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, ...payload }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json;
};

// Build a simple dog-list section block (with optional first photo)
const dogListBlock = (dogs) => {
  if (dogs.length === 0) return null;

  const blocks = [];
  for (const dog of dogs) {
    const name = dog.Name || 'Unknown';
    const block = {
      type: 'section',
      text: { type: 'mrkdwn', text: `• *${name}*` },
    };
    const photo =
      dog.CoverPhoto || (Array.isArray(dog.Photos) && dog.Photos[0]) || null;
    if (photo) {
      block.accessory = { type: 'image', image_url: photo, alt_text: name };
    }
    blocks.push(block);
  }

  return blocks;
};

const buildWeeklySummaryPayload = ({
  newIntakes,
  needsFoster,
  adoptions,
  weekStart,
  weekEnd,
}) => {
  const dateRange = `${formatDate(weekStart)} – ${formatDate(weekEnd)}`;
  const blocks = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `Weekly Rescue Summary: ${dateRange}`,
      emoji: true,
    },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*:dog: New intakes:* ${newIntakes.length}     ` +
        `*:paw_prints: Adoptions:* ${adoptions.length}     ` +
        `*:sos: Still needs foster:* ${needsFoster.length}`,
    },
  });

  blocks.push({ type: 'divider' });

  // New intakes
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:dog: New Dogs This Week (${newIntakes.length})*`,
    },
  });
  if (newIntakes.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No new intakes this week._' },
    });
  } else {
    const intakeBlocks = dogListBlock(newIntakes);
    if (intakeBlocks) blocks.push(...intakeBlocks);
  }

  blocks.push({ type: 'divider' });

  // Adoptions
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:paw_prints: Adopted This Week (${adoptions.length})*`,
    },
  });
  if (adoptions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No adoptions this week._' },
    });
  } else {
    const adoptionBlocks = dogListBlock(adoptions);
    if (adoptionBlocks) blocks.push(...adoptionBlocks);
  }

  blocks.push({ type: 'divider' });

  // Still needs foster
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:sos: Dogs Still Needing a Foster (${needsFoster.length})*`,
    },
  });
  if (needsFoster.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_All dogs have fosters — amazing!_' },
    });
  } else {
    const needsBlocks = dogListBlock(needsFoster);
    if (needsBlocks) blocks.push(...needsBlocks);
  }

  return {
    text: `Weekly Rescue Summary: ${dateRange}`,
    blocks,
  };
};

// ---------- Main ----------

async function main() {
  console.log('Running weekly rescue summary...');

  const now = new Date();
  const weekStart = new Date(now.getTime() - ONE_WEEK_MS);
  const weekStartTimestamp = Math.floor(weekStart.getTime() / 1000);

  // Fetch data in parallel.
  // sort=updated_at makes `since` filter on LastUpdatedUnixTime rather than
  // intake time, so recently-adopted dogs (updated this week) are included.
  const [inCustodyDogs, updatedThisWeek] = await Promise.all([
    fetchAnimals('in custody'),
    fetchAnimals(null, weekStartTimestamp, true),
  ]);

  const newIntakes = updatedThisWeek.filter(
    (dog) => dog.Type === 'Dog' && Number(dog.LastIntakeUnixTime) >= weekStartTimestamp,
  );

  // Adoptions: dogs updated this week whose status changed to "Healthy in Home"
  const adoptions = updatedThisWeek.filter(
    (dog) => dog.Type === 'Dog' && dog.Status === 'Healthy in Home',
  );

  // Still needs foster: dogs at boarding locations (not yet in a foster home)
  const NEEDS_FOSTER_LOCATIONS = new Set([
    'paradise pet resort',
    "love's legacy rescue",
  ]);
  const needsFoster = inCustodyDogs.filter((dog) => {
    const loc = (dog.CurrentLocation?.Tier1 || '').toLowerCase();
    return !dog.InFoster && NEEDS_FOSTER_LOCATIONS.has(loc);
  });

  console.log(
    `Summary — new intakes: ${newIntakes.length}, still needs foster: ${needsFoster.length}, adoptions: ${adoptions.length}`,
  );

  const payload = buildWeeklySummaryPayload({
    newIntakes,
    needsFoster,
    adoptions,
    weekStart,
    weekEnd: now,
  });

  try {
    await postToSlack(payload);
    console.log('Weekly summary posted to Slack.');
  } catch (err) {
    console.error('Failed to post weekly summary to Slack:', err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
