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

  if (p.includes('rabies') || p.includes('rabvac')) {
    return 'rabies';
  }

  if (
    p.includes('dhpp') ||
    p.includes('dapp') ||
    p.includes('da2pp') ||
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
        await res.text()
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
          }
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
      : null
  );

  return dogsWithIds;
};

// Fetch **all** vaccines (completed + scheduled) for a dog
const fetchAllVaccinesForAnimal = async (animalId) => {
  const url = `https://new.shelterluv.com/api/v1/animals/${animalId}/vaccines`;

  console.log('Calling vaccines endpoint:', url);

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
      await res.text()
    );
    throw new Error(`All-vaccines fetch failed for ${animalId}`);
  }

  const json = await res.json();

  // Some Shelterluv responses are { vaccines: [...] }, others are just [...]
  return Array.isArray(json.vaccines)
    ? json.vaccines
    : Array.isArray(json)
    ? json
    : [];
};

// Fetch ALL scheduled vaccines across the org
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
      console.error(
        'Shelterluv vaccines API error:',
        res.status,
        await res.text()
      );
      throw new Error(`Vaccines API request failed with ${res.status}`);
    }

    const json = await res.json();

    // Typical shape: { success, vaccines, has_more, total_count }
    const batch = Array.isArray(json.vaccines) ? json.vaccines : json;

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    all.push(...batch);

    if (json.has_more === false || batch.length < limit) {
      break;
    }

    offset += limit;
  }

  console.log('Total scheduled vaccines fetched:', all.length);
  return all;
};

// ---------- Slack payload: formatted ----------

// dog: contains the bucketed scheduled vaccines
// allVaccines: raw list from /animals/{id}/vaccines (completed + scheduled)
const buildSlackPayloadForDog = (dog, allVaccines = []) => {
  const overdueCount = dog.overdue.length;
  const needsAttentionCount = dog.needsAttention.length;
  const upcomingCount = dog.upcoming.length;
  const currentCount = dog.current.length;

  // Only scheduled vaccines (from your buckets)
  const scheduledVaccines = [
    ...dog.overdue,
    ...dog.needsAttention,
    ...dog.upcoming,
    ...dog.current,
    ...(dog.unknown || []),
  ];

  // Core vaccine families
  const coreTypes = [
    { key: 'rabies', label: 'Rabies' },
    { key: 'dhpp_dapp', label: 'DHPP/DAPP' },
    { key: 'bordetella', label: 'Bordetella' },
  ];

  // "Other" vaccines from full history
  const otherVaccines = (allVaccines || []).filter(
    (v) => classifyVaccineType(v.product) === 'other'
  );

  const summaryLine =
    overdueCount || needsAttentionCount || upcomingCount || currentCount
      ? `– ${overdueCount} overdue\n` +
        `- ${needsAttentionCount + upcomingCount} due within the month\n` +
        `- ${currentCount} current`
      : 'No upcoming scheduled vaccines';

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${dog.name}'s Vaccine Status`,
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
      (v) => classifyVaccineType(v.product) === key
    );

    const scheduledForType = scheduledVaccines.filter(
      (v) => classifyVaccineType(v.product) === key
    );

    // 1) Last given (from COMPLETED history)
    let lastGivenPart = '';
    if (historyForType.length > 0) {
      const completedDates = historyForType
        .map((v) => (v.completed_at ? unixStringToDate(v.completed_at) : null))
        .filter((d) => d instanceof Date && !isNaN(d.getTime()))
        .sort((a, b) => b.getTime() - a.getTime()); // newest first

      if (completedDates[0]) {
        const lastDateStr = formatDate(completedDates[0]);
        lastGivenPart = `Last given ${lastDateStr}. `;
      }
    }

    // 2) Next scheduled (from SCHEDULED buckets)
    let statusKey = 'none';
    let duePart = '';
    let statusText = '';

    if (scheduledForType.length > 0) {
      // There is at least one scheduled dose → use the soonest to determine status + icon
      const soonest = scheduledForType.reduce((a, b) => {
        const at = a.scheduledFor ? a.scheduledFor.getTime() : Infinity;
        const bt = b.scheduledFor ? b.scheduledFor.getTime() : Infinity;
        return bt < at ? b : a;
      });

      const dateStr = formatDate(soonest.scheduledFor);

      if (soonest.status === 'overdue') {
        statusKey = 'overdue';
        const daysAgo =
          soonest.diffDays != null
            ? Math.floor(Math.abs(soonest.diffDays))
            : null;
        const extra =
          daysAgo != null
            ? `${daysAgo} day${daysAgo === 1 ? '' : 's'} overdue`
            : 'Overdue';
        duePart = `Next dose: *${extra}* – ${dateStr}`;
      } else if (soonest.status === 'needsAttention') {
        statusKey = 'needsAttention';
        const days =
          soonest.diffDays != null ? Math.ceil(soonest.diffDays) : null;
        const extra =
          days != null ? `in ${days} day${days === 1 ? '' : 's'}` : 'due soon';
        duePart = `Next dose: *${extra}* – ${dateStr}`;
      } else if (soonest.status === 'upcoming') {
        statusKey = 'upcoming';
        const days =
          soonest.diffDays != null ? Math.ceil(soonest.diffDays) : null;
        const extra =
          days != null ? `in ${days} day${days === 1 ? '' : 's'}` : 'upcoming';
        duePart = `Next dose: *${extra}* – ${dateStr}`;
      } else if (soonest.status === 'current') {
        statusKey = 'current';
        const days =
          soonest.diffDays != null ? Math.ceil(soonest.diffDays) : null;
        const extra =
          days != null ? `in ${days} day${days === 1 ? '' : 's'}` : 'scheduled';
        duePart = `Next dose: ${extra} – ${dateStr}`;
      } else {
        statusKey = 'unknown';
        duePart = `Next dose date unknown`;
      }

      statusText = `${lastGivenPart}${duePart}`;
    } else if (historyForType.length > 0) {
      // Has vaccine on file, but no future scheduled
      statusKey = 'current';
      statusText = `${lastGivenPart}No upcoming dose scheduled.`;
    } else {
      // Nothing on file at all
      statusKey = 'none';
      statusText = `_No ${label.toLowerCase()} vaccine on file_`;
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
  };
};

// ---------- Main ----------

// ---------- Main ----------

async function main() {
  console.log('Running vaccine schedule check...');

  // 1. All in-custody dogs (with vaccineAnimalId attached)
  const inCustodyDogs = await fetchAllInCustodyDogs();

  for (const animal of inCustodyDogs) {
    const animalId = animal.vaccineAnimalId;

    if (!animalId) {
      console.warn(
        'Skipping animal with no vaccineAnimalId after filtering:',
        animal.Name
      );
      continue;
    }

    const name = animal.Name || `Animal ${animalId}`;
    const photoUrl =
      animal.CoverPhoto ||
      (Array.isArray(animal.Photos) && animal.Photos[0]) ||
      null;

    console.log(
      `\nFetching ALL vaccines for ${name} (vaccine ID: ${animalId})...`
    );

    let allVaccines;
    try {
      allVaccines = await fetchAllVaccinesForAnimal(animalId);
    } catch (err) {
      console.error(
        `Error fetching vaccines for ${name} (${animalId}), skipping:`,
        err.message
      );
      continue;
    }

    // Only those with a scheduled_for timestamp get bucketed for due windows
    const scheduledVaccines = allVaccines.filter((v) => v.scheduled_for);

    const buckets = bucketScheduledVaccines(scheduledVaccines);

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

    const payload = buildSlackPayloadForDog(dog, allVaccines);

    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(
        `Failed to send Slack message for ${dog.name}:`,
        res.status,
        await res.text()
      );
      continue;
    }

    console.log(`Slack message sent for ${dog.name}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
