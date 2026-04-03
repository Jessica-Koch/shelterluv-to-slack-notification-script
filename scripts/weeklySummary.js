require('dotenv').config();

const SHELTERLUV_API_KEY = process.env.SHELTERLUV_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID =
  process.env.SLACK_WEEKLY_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;

if (!SHELTERLUV_API_KEY) {
  console.error('Missing SHELTERLUV_API_KEY env var');
}
if (!SLACK_BOT_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN env var');
}
if (!SLACK_CHANNEL_ID) {
  console.error('Missing SLACK_WEEKLY_CHANNEL_ID (or SLACK_CHANNEL_ID) env var');
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

// Extract intake date from an animal record — Shelterluv uses several field names
const getIntakeDate = (animal) =>
  unixStringToDate(
    animal.IntakeDate ??
    animal.DateComeIn ??
    animal.InDate ??
    animal.intake_date ??
    null,
  );

// Extract outcome/adoption date from an animal record
const getOutcomeDate = (animal) =>
  unixStringToDate(
    animal.AdoptionDate ??
    animal.OutDate ??
    animal.outcome_date ??
    animal.DateGoOut ??
    null,
  );

// Extract foster placement date from an animal record
const getFosterDate = (animal) =>
  unixStringToDate(
    animal.FosterDate ??
    animal.FosterStartDate ??
    animal.foster_date ??
    animal.DateFoster ??
    // Fall back to the intake date if the animal is in foster status
    animal.IntakeDate ??
    animal.DateComeIn ??
    null,
  );

// ---------- Shelterluv API ----------

const fetchAnimalsByStatus = async (statusType) => {
  const baseUrl = 'https://new.shelterluv.com/api/v1/animals';
  const limit = 200;
  let offset = 0;
  const all = [];

  while (true) {
    const url = `${baseUrl}?status_type=${encodeURIComponent(statusType)}&limit=${limit}&offset=${offset}`;
    console.log(`Fetching animals (${statusType}) from Shelterluv:`, url);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Shelterluv animals API error (${statusType}):`, res.status, text);
      throw new Error(`Animals API request failed with ${res.status}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.animals) ? json.animals : json;

    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);

    if (json.has_more === false || batch.length < limit) break;

    offset += limit;
  }

  console.log(`Total animals fetched for status "${statusType}":`, all.length);
  return all.filter((a) => a.Type === 'Dog');
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

  // Show up to 8 dogs; each with an optional photo as accessory on its own section
  const blocks = [];
  for (const dog of dogs.slice(0, 8)) {
    const name = dog.Name || 'Unknown';
    const block = {
      type: 'section',
      text: { type: 'mrkdwn', text: `• *${name}*` },
    };
    const photo = dog.CoverPhoto || (Array.isArray(dog.Photos) && dog.Photos[0]) || null;
    if (photo) {
      block.accessory = { type: 'image', image_url: photo, alt_text: name };
    }
    blocks.push(block);
  }

  if (dogs.length > 8) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_...and ${dogs.length - 8} more_` },
    });
  }

  return blocks;
};

const buildWeeklySummaryPayload = ({
  newIntakes,
  movedToFoster,
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
        `*:house_with_garden: Moved to foster:* ${movedToFoster.length}     ` +
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

  // Moved to foster this week
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:house_with_garden: Moved to Foster This Week (${movedToFoster.length})*`,
    },
  });
  if (movedToFoster.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No new foster placements this week._' },
    });
  } else {
    const fosterBlocks = dogListBlock(movedToFoster);
    if (fosterBlocks) blocks.push(...fosterBlocks);
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

  // Fetch data in parallel where possible
  const [inCustodyDogs, fosterDogs, adoptedDogs] = await Promise.all([
    fetchAnimalsByStatus('in custody'),
    fetchAnimalsByStatus('foster'),
    fetchAnimalsByStatus('adopted'),
  ]);

  // New intakes: in-custody dogs with an intake date in the past 7 days
  const newIntakes = inCustodyDogs.filter((dog) => {
    const d = getIntakeDate(dog);
    return d && d >= weekStart;
  });

  // Moved to foster this week: foster dogs with a foster/intake date in the past 7 days
  const movedToFoster = fosterDogs.filter((dog) => {
    const d = getFosterDate(dog);
    return d && d >= weekStart;
  });

  // Still needs foster: all dogs currently in custody at the shelter
  const needsFoster = inCustodyDogs;

  // Adoptions this week: adopted dogs with an outcome date in the past 7 days
  const adoptions = adoptedDogs.filter((dog) => {
    const d = getOutcomeDate(dog);
    return d && d >= weekStart;
  });

  console.log(
    `Summary — new intakes: ${newIntakes.length}, moved to foster: ${movedToFoster.length}, ` +
    `still needs foster: ${needsFoster.length}, adoptions: ${adoptions.length}`,
  );

  const payload = buildWeeklySummaryPayload({
    newIntakes,
    movedToFoster,
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
