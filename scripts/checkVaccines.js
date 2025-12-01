require('dotenv').config();

const SHELTERLUV_API_KEY = process.env.SHELTERLUV_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const DAYS_BEFORE_DUE = 30; // how far ahead to look (outer window)
const TWO_WEEKS_BEFORE_DUE = 14; // "needs attention" window

if (!SHELTERLUV_API_KEY) {
  console.error('Missing SHELTERLUV_API_KEY env var');
}
if (!SLACK_WEBHOOK_URL) {
  console.error('Missing SLACK_WEBHOOK_URL env var');
}
if (!SHELTERLUV_API_KEY || !SLACK_WEBHOOK_URL) {
  process.exit(1);
}

// ---------- Helpers ----------

// Convert Shelterluv unix-string to JS Date
const unixStringToDate = (str) => {
  if (!str) return null;
  const seconds = Number(str);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
};

// ---------- Shelterluv API calls ----------

const fetchAllScheduledVaccines = async () => {
  const baseUrl = 'https://new.shelterluv.com/api/v1/vaccines';
  const limit = 200;
  let offset = 0;
  const all = [];

  while (true) {
    const url = `${baseUrl}?status=scheduled&limit=${limit}&offset=${offset}`;

    console.log('Fetching scheduled vaccines from Shelterluv:', url);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error('Shelterluv API error:', res.status, await res.text());
      throw new Error(`Shelterluv API request failed with ${res.status}`);
    }

    const json = await res.json();

    // Your sample shows: { success, vaccines, has_more, total_count }
    const batch = Array.isArray(json.vaccines) ? json.vaccines : json;

    // If vaccines is empty or missing, we’re done
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    all.push(...batch);

    // Pagination: stop if API says no more
    if (json.has_more === false || batch.length < limit) {
      break;
    }

    offset += limit;
  }

  console.log(`Total scheduled vaccines fetched: ${all.length}`);
  return all;
};

const fetchAnimalById = async (internalId) => {
  const url = `https://new.shelterluv.com/api/v1/animals/${internalId}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.error(
      `Failed to fetch animal ${internalId}:`,
      res.status,
      await res.text()
    );
    throw new Error(`Animal fetch failed for ${internalId}`);
  }

  const data = await res.json();
  return data;
};

// For all vaccines in our buckets, fetch the corresponding animals
const fetchAnimalsForBuckets = async (buckets) => {
  const ids = new Set();

  for (const v of buckets.overdue) if (v.animalId) ids.add(v.animalId);
  for (const v of buckets.needsAttention) if (v.animalId) ids.add(v.animalId);
  for (const v of buckets.upcoming) if (v.animalId) ids.add(v.animalId);
  for (const v of buckets.current) if (v.animalId) ids.add(v.animalId);

  const animalsById = {};

  for (const id of ids) {
    try {
      const animal = await fetchAnimalById(id);

      // 1. Only dogs
      if (animal.Type !== 'Dog') continue;

      // 2. Only certain statuses (tweak this to match your Shelterluv config)
      const status = (animal.Status || '').toLowerCase();

      const isAdoptable =
        status.includes('available') || // catches "Available", "Available in foster", etc.
        status.includes('adoptable');

      if (!isAdoptable) {
        // Skip animals that aren't currently adoptable
        continue;
      }

      const name = animal.Name || `Animal ${id}`;
      const coverPhoto =
        animal.CoverPhoto ||
        (Array.isArray(animal.Photos) && animal.Photos[0]) ||
        null;

      animalsById[id] = {
        name,
        photoUrl: coverPhoto,
      };
    } catch (err) {
      console.error(`Skipping animal ${id} due to fetch error`, err);
    }
  }

  return animalsById;
};

// ---------- Date classification ----------

const classifyByDueWindow = (scheduledForStr) => {
  const date = unixStringToDate(scheduledForStr);
  if (!date) return { status: 'unknown', diffDays: null, date: null };

  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays < 0) {
    return { status: 'overdue', diffDays, date };
  }

  if (diffDays <= TWO_WEEKS_BEFORE_DUE) {
    return { status: 'needsAttention', diffDays, date };
  }

  if (diffDays <= DAYS_BEFORE_DUE && diffDays > TWO_WEEKS_BEFORE_DUE) {
    return { status: 'upcoming', diffDays, date };
  }

  return { status: 'current', diffDays, date };
};

const bucketScheduledVaccines = (vaccines) => {
  const overdue = [];
  const upcoming = [];
  const needsAttention = [];
  const current = [];

  for (const v of vaccines) {
    const { status, diffDays, date } = classifyByDueWindow(v.scheduled_for);

    const base = {
      vaccineId: v.id,
      animalId: v.animal_id,
      product: v.product,
      manufacturer: v.manufacturer,
      lot: v.lot,
      scheduledFor: date,
      diffDays,
    };

    if (status === 'overdue') {
      overdue.push(base);
    } else if (status === 'needsAttention') {
      needsAttention.push(base);
    } else if (status === 'upcoming') {
      upcoming.push(base);
    } else if (status === 'current') {
      current.push(base);
    }
  }

  return { overdue, upcoming, needsAttention, current };
};

// ---------- Group by dog ----------

const groupVaccinesByDog = (buckets, animalsById) => {
  const dogs = {};

  const addToDogBucket = (vaccine, status) => {
    const id = vaccine.animalId;
    if (!id) return;

    if (!animalsById[id]) return; // skip animals we didn't fetch / non-dogs

    if (!dogs[id]) {
      dogs[id] = {
        animalId: id,
        name: animalsById[id].name,
        photoUrl: animalsById[id].photoUrl,
        overdue: [],
        needsAttention: [],
        upcoming: [],
        current: [],
      };
    }

    dogs[id][status].push(vaccine);
  };

  for (const v of buckets.overdue) {
    addToDogBucket(v, 'overdue');
  }
  for (const v of buckets.needsAttention) {
    addToDogBucket(v, 'needsAttention');
  }
  for (const v of buckets.upcoming) {
    addToDogBucket(v, 'upcoming');
  }
  for (const v of buckets.current) {
    addToDogBucket(v, 'current');
  }

  return dogs; // object keyed by animalId
};

// ---------- Slack payload (grouped by dog, with picture) ----------
const buildSlackPayloadForDogs = (dogsById) => {
  const dogEntries = Object.values(dogsById);

  if (dogEntries.length === 0) {
    return {
      text: 'No dogs with vaccines overdue or due soon. 🎉',
    };
  }

  const blocks = [];

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Shelterluv vaccine schedule check*',
    },
  });

  blocks.push({ type: 'divider' });

  dogEntries.forEach((dog) => {
    const overdueCount = dog.overdue.length;
    const needsAttentionCount = dog.needsAttention.length;
    const upcomingCount = dog.upcoming.length;
    const currentCount = dog.current.length;

    const lines = [];

    // Overdue
    if (overdueCount > 0) {
      lines.push(`❗ *${overdueCount} overdue*`);
      dog.overdue
        .sort((a, b) => a.diffDays - b.diffDays)
        .forEach((v) => {
          const dateStr = v.scheduledFor
            ? v.scheduledFor.toISOString().slice(0, 10)
            : 'unknown date';
          const daysAgo = Math.floor(Math.abs(v.diffDays));
          lines.push(
            `• *${v.product}* (lot: ${
              v.lot || 'n/a'
            }) – expires on *${dateStr}* (${daysAgo} day${
              daysAgo === 1 ? '' : 's'
            } overdue)`
          );
        });
      lines.push('');
    }

    // Needs attention (<= TWO_WEEKS_BEFORE_DUE)
    if (needsAttentionCount > 0) {
      lines.push(
        `⚠️ *${needsAttentionCount} due within ${TWO_WEEKS_BEFORE_DUE} days*`
      );
      dog.needsAttention
        .sort((a, b) => a.diffDays - b.diffDays)
        .forEach((v) => {
          const dateStr = v.scheduledFor
            ? v.scheduledFor.toISOString().slice(0, 10)
            : 'unknown date';
          const days = Math.ceil(v.diffDays);
          lines.push(
            `• *${v.product}* (lot: ${
              v.lot || 'n/a'
            }) – expires on: *${dateStr}* (in ${days} day${
              days === 1 ? '' : 's'
            })`
          );
        });
      lines.push('');
    }

    // Upcoming (between TWO_WEEKS_BEFORE_DUE and DAYS_BEFORE_DUE)
    if (upcomingCount > 0) {
      lines.push(
        `⏰ *${upcomingCount} due in ${
          TWO_WEEKS_BEFORE_DUE + 1
        }–${DAYS_BEFORE_DUE} days*`
      );
      dog.upcoming
        .sort((a, b) => a.diffDays - b.diffDays)
        .forEach((v) => {
          const dateStr = v.scheduledFor
            ? v.scheduledFor.toISOString().slice(0, 10)
            : 'unknown date';
          const days = Math.ceil(v.diffDays);
          lines.push(
            `• *${v.product}* (lot: ${
              v.lot || 'n/a'
            }) – expires on: *${dateStr}* (in ${days} day${
              days === 1 ? '' : 's'
            })`
          );
        });
      lines.push('');
    }

    // Current (beyond DAYS_BEFORE_DUE) — for sanity-checking the classifier
    if (currentCount > 0) {
      lines.push(
        `✅ *${currentCount} current (due later than ${DAYS_BEFORE_DUE} days)*`
      );
      dog.current
        .sort((a, b) => a.diffDays - b.diffDays)
        .forEach((v) => {
          const dateStr = v.scheduledFor
            ? v.scheduledFor.toISOString().slice(0, 10)
            : 'unknown date';
          const days = Math.ceil(v.diffDays);
          lines.push(
            `• *${v.product}* (lot: ${
              v.lot || 'n/a'
            }) – expires on: *${dateStr}* (in ${days} day${
              days === 1 ? '' : 's'
            })`
          );
        });
    }

    const sectionBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${dog.name}*` +
          (overdueCount || needsAttentionCount || upcomingCount || currentCount
            ? ` – ${overdueCount} overdue, ${
                needsAttentionCount + upcomingCount
              } within the month, ${currentCount} current`
            : '') +
          `\n\n` +
          lines.join('\n'),
      },
    };

    if (dog.photoUrl) {
      sectionBlock.accessory = {
        type: 'image',
        image_url: dog.photoUrl,
        alt_text: dog.name,
      };
    }

    blocks.push(sectionBlock);
    blocks.push({ type: 'divider' });
  });

  return {
    text: 'Shelterluv vaccine schedule check',
    blocks,
  };
};

// ---------- Main ----------

async function main() {
  console.log('Running vaccine check...');

  // 1. Fetch all scheduled vaccine records
  const scheduledVaccines = await fetchAllScheduledVaccines();

  console.log('scheduledVaccines length:', scheduledVaccines.length);
  console.log('First few scheduled vaccines:', scheduledVaccines.slice(0, 5));

  // 2. Bucket into overdue / needs attention / upcoming / current
  const buckets = bucketScheduledVaccines(scheduledVaccines);
  console.log(
    `Found ${buckets.overdue.length} overdue, ${buckets.needsAttention.length} due within ${TWO_WEEKS_BEFORE_DUE} days, ${buckets.upcoming.length} due in the next ${DAYS_BEFORE_DUE} days, ${buckets.current.length} further out.`
  );

  // 3. Fetch animal details
  const animalsById = await fetchAnimalsForBuckets(buckets);
  console.log(
    `Fetched details for ${Object.keys(animalsById).length} animals.`
  );

  // 4. Group vaccines by dog
  const dogsById = groupVaccinesByDog(buckets, animalsById);

  // 5. Build Slack payload (grouped by dog, with pictures)
  const payload = buildSlackPayloadForDogs(dogsById);

  // 6. Post to Slack via webhook
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(
      'Failed to send Slack message:',
      res.status,
      await res.text()
    );
    process.exit(1);
  }

  console.log('Slack message sent.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
