require('dotenv').config();

const SHELTERLUV_API_KEY = process.env.SHELTERLUV_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

const DAYS_BEFORE_DUE = 30; // how far ahead to look (outer window)
const TWO_WEEKS_BEFORE_DUE = 14; // "needs attention" window

if (!SHELTERLUV_API_KEY) {
  console.error('Missing SHELTERLUV_API_KEY env var');
}
if (!SLACK_BOT_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN env var');
}
if (!SLACK_CHANNEL_ID) {
  console.error('Missing SLACK_CHANNEL_ID env var');
}
if (!SHELTERLUV_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  process.exit(1);
}

// ---------- Helpers ----------

// Convert Shelterluv unix-string (seconds) to JS Date
const unixStringToDate = (str) => {
  if (!str) return null;
  const seconds = Number(str);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
};

// Format date as 12/1/2025
const formatDate = (date) => {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return 'unknown date';
  }
  const month = date.getMonth() + 1; // 0-based
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
};

// Try to find the Shelterluv internal ID used by the vaccines API
const getVaccineInternalIdFromAnimal = (animal) => {
  const explicitCandidates = [
    animal.animal_id,
    animal.internal_id,
    animal.InternalID,
    animal.InternalId,
    animal.AnimalInternalId,
    animal.ID,
    animal.id,
  ]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v).trim());

  const allPrimitiveValues = Object.values(animal)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim());

  const candidates = [...explicitCandidates, ...allPrimitiveValues];

  const longNumeric = candidates.find((val) => /^\d{8,}$/.test(val));
  if (longNumeric) return longNumeric;

  const anyNumeric = candidates.find((val) => /^\d+$/.test(val));
  if (anyNumeric) return anyNumeric;

  return null;
};

// Classify vaccine product into main families
const classifyVaccineType = (product) => {
  const p = (product || '').toLowerCase();

  if (p.includes('rabies') || p.includes('rabvac') || p.includes('mrab')) {
    return 'rabies';
  }

  if (
    p.includes('dhpp') ||
    p.includes('dhp') ||
    p.includes('dapp') ||
    p.includes('da2pp') ||
    p.includes('da2lpp') ||
    p.includes('da2ppv') ||
    p.includes('dappv') ||
    p.includes('vanguard dapp') ||
    p.includes('nobivac canine 1-dappv')
  ) {
    return 'dhpp_dapp';
  }

  if (p.includes('bordetella') || p.includes('trucan b')) {
    return 'bordetella';
  }

  return 'other';
};

// ---------- Date classification (for scheduled vaccines) ----------

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
  const unknown = [];

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
      status,
    };

    if (status === 'overdue') {
      overdue.push(base);
    } else if (status === 'needsAttention') {
      needsAttention.push(base);
    } else if (status === 'upcoming') {
      upcoming.push(base);
    } else if (status === 'current') {
      current.push(base);
    } else {
      unknown.push(base);
    }
  }

  return { overdue, upcoming, needsAttention, current, unknown };
};

// ---------- Emoji mapping ----------

const STATUS_EMOJI = {
  overdue: ':alert:',
  needsAttention: ':warning:',
  upcoming: ':large_orange_circle:',
  current: ':white_check_mark:',
  none: ':bangbang:',
  unknown: ':grey_question:',
};

// ---------- Shelterluv API calls ----------

// Get all in-custody animals, filter to dogs with an internal ID
const fetchAllInCustodyDogs = async () => {
  const baseUrl = 'https://new.shelterluv.com/api/v1/animals';
  const limit = 200;
  let offset = 0;
  const allAnimals = [];

  while (true) {
    const url = `${baseUrl}?status_type=in+custody&limit=${limit}&offset=${offset}`;

    console.log('Fetching in-custody animals from Shelterluv:', url);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error(
        'Shelterluv animals API error:',
        res.status,
        await res.text(),
      );
      throw new Error(`Animals API request failed with ${res.status}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.animals) ? json.animals : json;

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    allAnimals.push(...batch);

    if (json.has_more === false || batch.length < limit) {
      break;
    }

    offset += limit;
  }

  console.log('Total in-custody animals fetched:', allAnimals.length);

  const dogsWithIds = allAnimals
    .filter((animal) => animal.Type === 'Dog')
    .map((animal) => {
      const vaccineAnimalId = getVaccineInternalIdFromAnimal(animal);

      if (!vaccineAnimalId) {
        console.warn(
          'Could not find vaccine internal ID for animal, skipping:',
          {
            Name: animal.Name,
            rawIdFields: {
              animal_id: animal.animal_id,
              internal_id: animal.internal_id,
              InternalID: animal.InternalID,
              ID: animal.ID,
              id: animal.id,
            },
          },
        );
      }

      return {
        ...animal,
        vaccineAnimalId,
      };
    })
    .filter((animal) => Boolean(animal.vaccineAnimalId));

  console.log(
    'In-custody dogs with vaccine IDs:',
    dogsWithIds.length,
    'example:',
    dogsWithIds[0]
      ? {
          Name: dogsWithIds[0].Name,
          vaccineAnimalId: dogsWithIds[0].vaccineAnimalId,
        }
      : null,
  );

  return dogsWithIds;
};

// Fetch **all** vaccines (completed + scheduled) for a dog (for history)
const fetchAllVaccinesForAnimal = async (animalId) => {
  const url = `https://new.shelterluv.com/api/v1/animals/${animalId}/vaccines`;

  console.log('Calling ALL vaccines endpoint:', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.error(
      `Failed to fetch ALL vaccines for animal ${animalId}:`,
      res.status,
      await res.text(),
    );
    throw new Error(`All-vaccines fetch failed for ${animalId}`);
  }

  const json = await res.json();

  return Array.isArray(json.vaccines)
    ? json.vaccines
    : Array.isArray(json)
      ? json
      : [];
};

// Fetch **scheduled** vaccines for a dog (for next due / expiring)
const fetchScheduledVaccinesForAnimal = async (animalId) => {
  const url = `https://new.shelterluv.com/api/v1/animals/${animalId}/vaccines?status=scheduled`;

  console.log('Calling SCHEDULED vaccines endpoint:', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.error(
      `Failed to fetch SCHEDULED vaccines for animal ${animalId}:`,
      res.status,
      await res.text(),
    );
    throw new Error(`Scheduled-vaccines fetch failed for ${animalId}`);
  }

  const json = await res.json();

  return Array.isArray(json.vaccines)
    ? json.vaccines
    : Array.isArray(json)
      ? json
      : [];
};

// Fetch **overdue** vaccines for a dog (authoritative overdue status)
const fetchOverdueVaccinesForAnimal = async (animalId) => {
  const url = `https://new.shelterluv.com/api/v1/animals/${animalId}/vaccines?status=overdue`;

  console.log('Calling OVERDUE vaccines endpoint:', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.error(
      `Failed to fetch OVERDUE vaccines for animal ${animalId}:`,
      res.status,
      await res.text(),
    );
    throw new Error(`Overdue-vaccines fetch failed for ${animalId}`);
  }

  const json = await res.json();

  return Array.isArray(json.vaccines)
    ? json.vaccines
    : Array.isArray(json)
      ? json
      : [];
};

// ---------- Slack payload: formatted ----------
const buildSlackPayloadForDog = (
  dog,
  allVaccines = [],
  scheduledVaccines = [],
  overdueVaccines = [],
) => {
  const nextScheduledByType = new Map();

  for (const v of scheduledVaccines || []) {
    const type = classifyVaccineType(v.product);
    const date = unixStringToDate(v.scheduled_for);
    if (!date || isNaN(date.getTime())) continue;

    const prev = nextScheduledByType.get(type);
    if (!prev || date.getTime() < prev.getTime()) {
      nextScheduledByType.set(type, date);
    }
  }

  const hasAnyHistory = Array.isArray(allVaccines) && allVaccines.length > 0;

  // Core vaccine families
  const coreTypes = [
    { key: 'rabies', label: 'Rabies' },
    { key: 'dhpp_dapp', label: 'DHPP/DAPP' },
    { key: 'bordetella', label: 'Bordetella' },
  ];

  // Calculate actual status based on Shelterluv statuses + schedules
  let actualOverdueCount = 0;
  let actualNeedsAttentionCount = 0;
  let actualUpcomingCount = 0;
  let actualCurrentCount = 0;
  let missingCoreVaccinesCount = 0;
  const missingVaccineTypes = [];

  coreTypes.forEach(({ key, label }) => {
    const historyForType = (allVaccines || []).filter(
      (v) => classifyVaccineType(v.product) === key,
    );

    const scheduledForType = (scheduledVaccines || []).filter(
      (v) => classifyVaccineType(v.product) === key,
    );
    const hasFutureScheduled = scheduledForType.some((v) => {
      const date = unixStringToDate(v.scheduled_for);
      return date && !isNaN(date.getTime()) && date.getTime() >= Date.now();
    });

    const completedDatesForType = historyForType
      .filter((v) => v.completed_at)
      .map((v) => unixStringToDate(v.completed_at))
      .filter((d) => d && !isNaN(d.getTime()));
    const mostRecentCompleted = completedDatesForType.length > 0
      ? completedDatesForType.reduce((max, d) => (d > max ? d : max))
      : null;

    const hasOverdue =
      !hasFutureScheduled &&
      ((!mostRecentCompleted && historyForType.some((v) => v.status === 'overdue')) ||
        (overdueVaccines || []).some((v) => {
          if (classifyVaccineType(v.product) !== key) return false;
          if (!mostRecentCompleted) return true;
          const overdueDate = unixStringToDate(v.scheduled_for);
          return !overdueDate || mostRecentCompleted < overdueDate;
        }));
    if (hasOverdue) {
      actualOverdueCount++;
      return;
    }

    if (scheduledForType.length > 0) {
      const earliestScheduled = scheduledForType
        .map((v) => unixStringToDate(v.scheduled_for))
        .filter((d) => d && !isNaN(d.getTime()))
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const { status } = classifyByDueWindow(
        earliestScheduled ? earliestScheduled.getTime() / 1000 : null,
      );

      if (status === 'overdue') actualOverdueCount++;
      else if (status === 'needsAttention') actualNeedsAttentionCount++;
      else if (status === 'upcoming') actualUpcomingCount++;
      else if (status === 'current') actualCurrentCount++;

      return;
    }

    const hasCompleted = historyForType.some((v) => v.completed_at);
    if (hasCompleted) {
      actualCurrentCount++;
      return;
    }

    missingCoreVaccinesCount++;
    missingVaccineTypes.push(label);
  });

  const allCoreCurrent =
    actualOverdueCount === 0 &&
    actualNeedsAttentionCount === 0 &&
    actualUpcomingCount === 0 &&
    missingCoreVaccinesCount === 0;

  // "Other" vaccines from full history
  const otherVaccines = (allVaccines || []).filter(
    (v) => classifyVaccineType(v.product) === 'other',
  );

  // ---------- SUMMARY LINE ----------
  let summaryLine;

  if (!hasAnyHistory) {
    summaryLine =
      ':warning: *No vaccine records on file in Shelterluv.* ' +
      "Please verify this dog's vaccination history.\n" +
      `- ${missingCoreVaccinesCount} core vaccines missing`;
  } else {
    let overdueText = `– ${actualOverdueCount} overdue`;
    if (missingCoreVaccinesCount > 0) {
      overdueText += ` (${missingCoreVaccinesCount} missing: ${missingVaccineTypes.join(
        ', ',
      )})`;
    }

    summaryLine =
      overdueText +
      '\n' +
      `- ${
        actualNeedsAttentionCount + actualUpcomingCount
      } due within the month\n` +
      `- ${actualCurrentCount} current`;
  }

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${dog.name}'s Vaccine Status - animal_id: ${dog.animalId}`,

      emoji: true,
    },
  });

  // Summary with photo
  const summaryBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: summaryLine,
    },
  };

  if (dog.photoUrl) {
    summaryBlock.accessory = {
      type: 'image',
      image_url: dog.photoUrl,
      alt_text: dog.name,
    };
  }

  blocks.push(summaryBlock);

  // ---------- CORE VACCINES (last given + next scheduled) ----------
  coreTypes.forEach(({ key, label }) => {
    const historyForType = (allVaccines || []).filter(
      (v) => classifyVaccineType(v.product) === key,
    );

    // Find the most recent completed vaccine
    const completedVaccines = historyForType
      .filter((v) => v.completed_at) // Only completed vaccines
      .map((v) => ({
        ...v,
        completedDate: unixStringToDate(v.completed_at),
      }))
      .filter((v) => v.completedDate && !isNaN(v.completedDate.getTime()))
      .sort((a, b) => b.completedDate.getTime() - a.completedDate.getTime());

    const mostRecent = completedVaccines[0];

    let statusKey = 'none';
    let statusText = '';

    const scheduledForType = (scheduledVaccines || []).filter(
      (v) => classifyVaccineType(v.product) === key,
    );
    const hasFutureScheduled = scheduledForType.some((v) => {
      const date = unixStringToDate(v.scheduled_for);
      return date && !isNaN(date.getTime()) && date.getTime() >= Date.now();
    });

    const completedDatesForBlock = historyForType
      .filter((v) => v.completed_at)
      .map((v) => unixStringToDate(v.completed_at))
      .filter((d) => d && !isNaN(d.getTime()));
    const mostRecentCompletedForBlock = completedDatesForBlock.length > 0
      ? completedDatesForBlock.reduce((max, d) => (d > max ? d : max))
      : null;

    const hasOverdue =
      !hasFutureScheduled &&
      ((!mostRecentCompletedForBlock && historyForType.some((v) => v.status === 'overdue')) ||
        (overdueVaccines || []).some((v) => {
          if (classifyVaccineType(v.product) !== key) return false;
          if (!mostRecentCompletedForBlock) return true;
          const overdueDate = unixStringToDate(v.scheduled_for);
          return !overdueDate || mostRecentCompletedForBlock < overdueDate;
        }));
    if (hasOverdue) {
      statusKey = 'overdue';
      statusText = '*Marked overdue in Shelterluv.*';
    } else if (nextScheduledByType.has(key)) {
      // Use Shelterluv schedule to determine due window
      const now = new Date();
      const nextDueDate = nextScheduledByType.get(key);
      const daysUntilDue = Math.ceil(
        (nextDueDate - now) / (1000 * 60 * 60 * 24),
      );
      const lastDateStr = mostRecent
        ? formatDate(mostRecent.completedDate)
        : 'unknown date';
      const nextDateStr = formatDate(nextDueDate);

      if (daysUntilDue < 0) {
        statusKey = 'overdue';
        const daysOverdue = Math.abs(daysUntilDue);
        statusText = `Last given ${lastDateStr}. *${daysOverdue} days overdue* (was due ${nextDateStr})`;
      } else if (daysUntilDue <= TWO_WEEKS_BEFORE_DUE) {
        statusKey = 'needsAttention';
        statusText = `Last given ${lastDateStr}. *Due in ${daysUntilDue} days* (${nextDateStr})`;
      } else if (daysUntilDue <= DAYS_BEFORE_DUE) {
        statusKey = 'upcoming';
        statusText = `Last given ${lastDateStr}. Due in ${daysUntilDue} days (${nextDateStr})`;
      } else {
        statusKey = 'current';
        statusText = `Last given ${lastDateStr}. Next due ${nextDateStr}`;
      }
    } else if (mostRecent) {
      statusKey = 'current';
      statusText = `Last given ${formatDate(
        mostRecent.completedDate,
      )}. Next due not scheduled`;
    } else {
      statusKey = 'unknown';
      statusText = `No ${label.toLowerCase()} vaccine on file`;
    }

    const emoji = STATUS_EMOJI[statusKey] || STATUS_EMOJI.unknown;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${label}*\n${statusText}\n`,
      },
    });
  });

  // ---------- OTHER VACCINES (optional detail) ----------
  if (otherVaccines.length > 0) {
    const rows = otherVaccines.map((v) => {
      const dateStr = v.scheduled_for
        ? formatDate(unixStringToDate(v.scheduled_for))
        : v.completed_at
          ? formatDate(unixStringToDate(v.completed_at))
          : 'unknown date';

      let statusKey = v.status || 'unknown';
      if (!STATUS_EMOJI[statusKey]) statusKey = 'unknown';
      const emoji = STATUS_EMOJI[statusKey];

      return `${emoji} ${v.product || 'Unknown product'} – ${dateStr}`;
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Other Vaccines*\n${rows.join('\n')}\n`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  return {
    text: `Shelterluv vaccine schedule check – ${dog.name}`,
    blocks,
    allCoreCurrent,
  };
};

const buildSlackSummaryPayload = (dogs) => {
  const rows = dogs.map((dog) => {
    const block = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${dog.name}* — 3 core vaccines current`,
      },
    };

    if (dog.photoUrl) {
      block.accessory = {
        type: 'image',
        image_url: dog.photoUrl,
        alt_text: dog.name,
      };
    }

    return block;
  });

  return {
    text: `Shelterluv vaccine schedule check – ${dogs.length} all current`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${dogs.length} dogs whose vaccines are all up to date`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Dogs with all 3 core vaccines current:',
        },
      },
      ...rows,
      { type: 'divider' },
    ],
  };
};

// ---------- Slack channel clearing ----------

const clearSlackChannel = async () => {
  let cursor;
  let deleted = 0;

  do {
    const params = new URLSearchParams({ channel: SLACK_CHANNEL_ID, limit: '200' });
    if (cursor) params.set('cursor', cursor);

    const historyRes = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
    );
    const history = await historyRes.json();

    if (!history.ok) {
      console.error('Failed to fetch channel history:', history.error);
      return;
    }

    for (const msg of (history.messages || []).filter((m) => !m.subtype)) {
      const delRes = await fetch('https://slack.com/api/chat.delete', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: SLACK_CHANNEL_ID, ts: msg.ts }),
      });
      const delJson = await delRes.json();
      if (!delJson.ok) {
        console.warn(`Failed to delete message ${msg.ts}:`, delJson.error);
      } else {
        deleted++;
      }
    }

    cursor = history.response_metadata?.next_cursor;
  } while (cursor);

  console.log(`Cleared ${deleted} messages from Slack channel.`);
};

// ---------- Main ----------

async function main() {
  console.log('Running vaccine schedule check...');
  await clearSlackChannel();

  const inCustodyDogs = await fetchAllInCustodyDogs();
  const allCoreCurrentDogs = [];
  const fullPayloads = [];

  for (const animal of inCustodyDogs) {
    const animalId = animal.vaccineAnimalId;

    if (!animalId) {
      console.warn(
        'Skipping animal with no vaccineAnimalId after filtering:',
        animal.Name,
      );
      continue;
    }

    const name = animal.Name || `Animal ${animalId}`;
    const photoUrl =
      animal.CoverPhoto ||
      (Array.isArray(animal.Photos) && animal.Photos[0]) ||
      null;

    console.log(
      `\nFetching ALL + SCHEDULED vaccines for ${name} (vaccine ID: ${animalId})...`,
    );

    let allVaccines;
    let scheduledVaccines;
    let overdueVaccines;

    try {
      allVaccines = await fetchAllVaccinesForAnimal(animalId);
      scheduledVaccines = await fetchScheduledVaccinesForAnimal(animalId);
      overdueVaccines = await fetchOverdueVaccinesForAnimal(animalId);
    } catch (err) {
      console.error(
        `Error fetching vaccines for ${name} (${animalId}), skipping:`,
        err.message,
      );
      continue;
    }

    // After fetching allVaccines and scheduledVaccines, filter out stale scheduled ones
    const filteredScheduledVaccines = scheduledVaccines.filter(
      (scheduledVax) => {
        const vaccineType = classifyVaccineType(scheduledVax.product);

        // Find the most recent completed vaccine of the same type
        const completedOfSameType = allVaccines
          .filter(
            (v) =>
              classifyVaccineType(v.product) === vaccineType &&
              v.completed_at &&
              v.status !== 'scheduled',
          )
          .map((v) => ({
            ...v,
            completedDate: unixStringToDate(v.completed_at),
          }))
          .filter((v) => v.completedDate)
          .sort(
            (a, b) => b.completedDate.getTime() - a.completedDate.getTime(),
          );

        if (completedOfSameType.length > 0) {
          const mostRecentCompleted = completedOfSameType[0].completedDate;
          const scheduledDate = unixStringToDate(scheduledVax.scheduled_for);

          if (scheduledDate && mostRecentCompleted) {
            // Calculate the difference in days
            const diffMs =
              scheduledDate.getTime() - mostRecentCompleted.getTime();
            const diffDays = diffMs / (1000 * 60 * 60 * 24);

            // If this scheduled vaccine is within 7 days after the completed vaccine,
            // it's likely a duplicate entry for the same event and should be filtered out
            if (diffDays < 7) {
              console.log(
                `Filtering out stale scheduled ${vaccineType} for ${name}: ` +
                  `scheduled ${formatDate(
                    scheduledDate,
                  )} but already completed ${formatDate(
                    mostRecentCompleted,
                  )} ` +
                  `(${Math.abs(Math.round(diffDays))} days apart)`,
              );
              return false;
            }

            // Also filter if scheduled date is any time in the past relative to completed date
            if (scheduledDate < mostRecentCompleted) {
              console.log(
                `Filtering out old scheduled ${vaccineType} for ${name}: ` +
                  `scheduled ${formatDate(
                    scheduledDate,
                  )} is before completed ${formatDate(mostRecentCompleted)}`,
              );
              return false;
            }
          }
        }

        return true;
      },
    );

    // Use filteredScheduledVaccines instead of scheduledVaccines
    const buckets = bucketScheduledVaccines(filteredScheduledVaccines);

    const dog = {
      animalId,
      name,
      photoUrl,
      overdue: buckets.overdue,
      needsAttention: buckets.needsAttention,
      upcoming: buckets.upcoming,
      current: buckets.current,
      unknown: buckets.unknown,
    };

    const payload = buildSlackPayloadForDog(
      dog,
      allVaccines,
      filteredScheduledVaccines,
      overdueVaccines,
    );

    if (payload.allCoreCurrent) {
      allCoreCurrentDogs.push({
        name: dog.name,
        animalId: dog.animalId,
        photoUrl: dog.photoUrl,
      });
    } else {
      fullPayloads.push(payload);
    }
  }

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

  if (allCoreCurrentDogs.length > 0) {
    const summaryPayload = buildSlackSummaryPayload(allCoreCurrentDogs);
    try {
      await postToSlack(summaryPayload);
      console.log(`Slack summary sent for ${allCoreCurrentDogs.length} dogs.`);
    } catch (err) {
      console.error('Failed to send Slack summary message:', err.message);
      return;
    }
  }

  for (const payload of fullPayloads) {
    try {
      await postToSlack(payload);
      console.log(`Slack message sent for ${payload.text}.`);
    } catch (err) {
      console.error(`Failed to send Slack message for ${payload.text}:`, err.message);
    }
  }
}

// Add this function to calculate next due date based on vaccine type
const calculateNextDueDate = (lastCompletedDate, vaccineType) => {};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
