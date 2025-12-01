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

// Fetch scheduled vaccines for a single animal
const fetchScheduledVaccinesForAnimal = async (animalId) => {
  const url = `https://new.shelterluv.com/api/v1/animals/${animalId}/vaccines?status=scheduled`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SHELTERLUV_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.error(
      `Failed to fetch scheduled vaccines for animal ${animalId}:`,
      res.status,
      await res.text()
    );
    throw new Error(`Scheduled vaccines fetch failed for ${animalId}`);
  }

  const json = await res.json();
  // matches your sample: { success, vaccines, has_more, total_count }
  return Array.isArray(json.vaccines) ? json.vaccines : [];
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
      `Failed to fetch animal ${internalId}: `,
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

const classifyVaccineType = (product) => {
  const p = (product || '').toLowerCase();

  // Rabies family
  if (p.includes('rabies') || p.includes('rabvac')) {
    return 'rabies';
  }

  // DHPP / DAPP / DA2PP / DA2PPvL etc.
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

  // Bordetella family
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
      status, // <-- keep this
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

// ---------- Group by dog ----------
const groupVaccinesByDog = (buckets, animalsById) => {
  const dogs = {};

  const ensureDog = (id) => {
    if (!dogs[id]) {
      dogs[id] = {
        animalId: id,
        name: animalsById[id].name,
        photoUrl: animalsById[id].photoUrl,
        overdue: [],
        needsAttention: [],
        upcoming: [],
        current: [],
        unknown: [], // <-- new
      };
    }

    return dogs[id];
  };

  const addToDogBucket = (vaccine, status) => {
    const id = vaccine.animalId;
    if (!id) return;
    if (!animalsById[id]) return;

    const dog = ensureDog(id);

    if (status === 'overdue') dog.overdue.push(vaccine);
    else if (status === 'needsAttention') dog.needsAttention.push(vaccine);
    else if (status === 'upcoming') dog.upcoming.push(vaccine);
    else if (status === 'current') dog.current.push(vaccine);
    else dog.unknown.push(vaccine);
  };

  for (const v of buckets.overdue) addToDogBucket(v, 'overdue');
  for (const v of buckets.needsAttention) addToDogBucket(v, 'needsAttention');
  for (const v of buckets.upcoming) addToDogBucket(v, 'upcoming');
  for (const v of buckets.current) addToDogBucket(v, 'current');
  for (const v of buckets.unknown || []) addToDogBucket(v, 'unknown');

  return dogs;
};

// ---------- Emoji mapping instead of icons ----------

const STATUS_EMOJI = {
  overdue: ':red_circle:',
  needsAttention: ':warning:',
  upcoming: ':large_orange_circle:',
  current: ':white_check_mark:',
  none: ':white_small_square:',
  unknown: ':grey_question:',
};

// ---------- Slack payload (one message per dog, using emojis) ----------
const buildSlackPayloadForDog = (dog) => {
  const overdueCount = dog.overdue.length;
  const needsAttentionCount = dog.needsAttention.length;
  const upcomingCount = dog.upcoming.length;
  const currentCount = dog.current.length;

  // Debug log so you can see what the script thinks this dog has
  console.log('Debug dog vaccines:', dog.name, {
    overdue: dog.overdue.map((v) => ({ product: v.product, status: v.status })),
    needsAttention: dog.needsAttention.map((v) => ({
      product: v.product,
      status: v.status,
    })),
    upcoming: dog.upcoming.map((v) => ({
      product: v.product,
      status: v.status,
    })),
    current: dog.current.map((v) => ({ product: v.product, status: v.status })),
    unknown: (dog.unknown || []).map((v) => ({
      product: v.product,
      status: v.status,
    })),
  });

  const allVaccines = [
    ...dog.overdue,
    ...dog.needsAttention,
    ...dog.upcoming,
    ...dog.current,
    ...(dog.unknown || []),
  ];

  // The 3 core vaccine families we always want to show
  const coreTypes = [
    { key: 'rabies', label: 'Rabies' },
    { key: 'dhpp_dapp', label: 'DHPP/DAPP' },
    { key: 'bordetella', label: 'Bordetella' },
  ];

  const summaryLine =
    overdueCount || needsAttentionCount || upcomingCount || currentCount
      ? ` – ${overdueCount} overdue, ${
          needsAttentionCount + upcomingCount
        } within the month, ${currentCount} current`
      : ' – no upcoming scheduled vaccines';

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

  blocks.push({ type: 'divider' });

  // Dog summary block with DOG PHOTO as accessory
  const summaryBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${dog.name}*${summaryLine}`,
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
  blocks.push({ type: 'divider' });

  // For each vaccine type, create its own section, prefixing with an emoji
  coreTypes.forEach(({ key, label }) => {
    const vaccinesForType = allVaccines.filter(
      (v) => classifyVaccineType(v.product) === key
    );

    let statusKey = 'none';
    let statusText = `_no ${label.toLowerCase()} vaccination record`;

    if (vaccinesForType.length > 0) {
      // Pick the soonest scheduled vaccine for this type
      const soonest = vaccinesForType.reduce((a, b) => {
        const at = a.scheduledFor ? a.scheduledFor.getTime() : Infinity;
        const bt = b.scheduledFor ? b.scheduledFor.getTime() : Infinity;
        return bt < at ? b : a;
      });

      const dateStr = soonest.scheduledFor
        ? soonest.scheduledFor.toISOString().slice(0, 10)
        : 'unknown date';

      // Determine status key + human-readable text
      if (soonest.status === 'overdue') {
        statusKey = 'overdue';
        const daysAgo =
          soonest.diffDays != null
            ? Math.floor(Math.abs(soonest.diffDays))
            : null;
        const extra =
          daysAgo != null
            ? ` (${daysAgo} day${daysAgo === 1 ? '' : 's'} overdue)`
            : '';
        statusText = `*Overdue*${extra} – ${dateStr}`;
      } else if (soonest.status === 'needsAttention') {
        statusKey = 'needsAttention';
        const days =
          soonest.diffDays != null ? Math.ceil(soonest.diffDays) : null;
        const extra =
          days != null ? ` (in ${days} day${days === 1 ? '' : 's'})` : '';
        statusText = `*Due soon*${extra} – *${dateStr}*`;
      } else if (soonest.status === 'upcoming') {
        statusKey = 'upcoming';
        const days =
          soonest.diffDays != null ? Math.ceil(soonest.diffDays) : null;
        const extra =
          days != null ? ` (in ${days} day${days === 1 ? '' : 's'})` : '';
        statusText = `*Upcoming*${extra} – *${dateStr}*`;
      } else if (soonest.status === 'current') {
        statusKey = 'current';
        const days =
          soonest.diffDays != null ? Math.ceil(soonest.diffDays) : null;
        const extra =
          days != null ? ` (in ${days} day${days === 1 ? '' : 's'})` : '';
        statusText = `Due${extra} – ${dateStr}`;
      } else {
        statusKey = 'unknown';
        statusText = `*Date unknown* –`;
      }
    }

    const emoji = STATUS_EMOJI[statusKey] || STATUS_EMOJI.unknown;

    const vaccineBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${label}*\n${statusText}\n\n`,
      },
    };

    blocks.push(vaccineBlock);
    blocks.push({ type: 'divider' });
  });

  return {
    text: `Shelterluv vaccine schedule check – ${dog.name}`,
    blocks,
  };
};

// ---------- Main ----------

async function main() {
  console.log('Running vaccine check...');

  // 1. Fetch all scheduled vaccine records
  const scheduledVaccines = await fetchAllScheduledVaccines();

  // 2. Bucket into overdue / needs attention / upcoming / current
  const buckets = bucketScheduledVaccines(scheduledVaccines);

  // 3. Fetch animal details
  const animalsById = await fetchAnimalsForBuckets(buckets);

  const dogsById = groupVaccinesByDog(buckets, animalsById);

  // Enrich each dog with per-animal scheduled vaccines
  for (const dog of Object.values(dogsById)) {
    const perAnimalVaccines = await fetchScheduledVaccinesForAnimal(
      dog.animalId
    );

    const knownIds = new Set(
      [
        ...dog.overdue,
        ...dog.needsAttention,
        ...dog.upcoming,
        ...dog.current,
        ...(dog.unknown || []),
      ].map((v) => v.vaccineId)
    );

    for (const v of perAnimalVaccines) {
      if (knownIds.has(v.id)) continue;

      const { status, diffDays, date } = classifyByDueWindow(v.scheduled_for);

      const normalized = {
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
        dog.overdue.push(normalized);
      } else if (status === 'needsAttention') {
        dog.needsAttention.push(normalized);
      } else if (status === 'upcoming') {
        dog.upcoming.push(normalized);
      } else if (status === 'current') {
        dog.current.push(normalized);
      } else {
        if (!dog.unknown) dog.unknown = [];
        dog.unknown.push(normalized);
      }

      knownIds.add(v.id);
    }

    if (dog.name === 'Rico' || dog.name === 'Lila') {
      console.log('After per-animal enrichment:', dog.name, {
        overdue: dog.overdue.map((v) => v.product),
        needsAttention: dog.needsAttention.map((v) => v.product),
        upcoming: dog.upcoming.map((v) => v.product),
        current: dog.current.map((v) => v.product),
        unknown: (dog.unknown || []).map((v) => v.product),
      });
    }
  }

  const dogEntries = Object.values(dogsById);

  for (const dog of dogEntries) {
    const payload = buildSlackPayloadForDog(dog);

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
      process.exit(1);
    }

    console.log(`Slack message sent for ${dog.name}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
