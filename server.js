import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

/* Alle B-værdi-kategorier */
const CATEGORY_IDS = [
  18, 19, 20, 21, 22,
  23, 24, 25, 26, 27,
  30, 31, 46, 55, 62
];

const API_BASE = 'https://freakyville.dk/api';
const CACHE_MS = 10 * 60 * 1000;

/*
  Sæt TIMER_TOKEN i Render -> Environment.
  Din lokale Python-fil skal bruge præcis samme token.
*/
const TIMER_TOKEN = process.env.TIMER_TOKEN;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20kb' }));

/* --- BO-TIMER-DATA: BEHOLDT --- */
let liveTimers = {
  bplus_bo_robbed: null,
  normal_bo_robbed: null,
  updatedAt: null
};

/* --- ITEM-CACHE --- */
let itemCache = {
  items: [],
  updatedAt: null,
  error: null,
  failedCategories: [],
  priceGroupWarnings: []
};

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/*
  ITEM-PRIS-FIX

  Freakyville sender den rigtige, færdige pris direkte på hvert head
  i item.priceInfo, fx:

    "20-25 Stacks"
    "3-4 DBs"
    "35-70 Stacks"

  Den tekst skal ALTID bruges først. Den indeholder allerede den korrekte
  enhed for det enkelte item. Vi bygger derfor IKKE selv "DBs" på alle
  minDbValue/maxDbValue-tal.
*/
function makePriceText(min, max, priceInfo) {
  if (typeof priceInfo === 'string' && priceInfo.trim()) {
    return priceInfo.trim();
  }

  /*
    Hvis den rå API ikke har priceInfo, vis kun tallet.
    Vi sætter bevidst ikke DBs eller stacks på, da enheden ellers kan blive
    forkert. Eksempel: "20-25 (enhed ikke oplyst af Freakyville)".
  */
  if (min !== null && max !== null) {
    return min === max
      ? `${min} (enhed ikke oplyst)`
      : `${min}-${max} (enhed ikke oplyst)`;
  }

  if (min !== null) return `${min}+ (enhed ikke oplyst)`;
  if (max !== null) return `Op til ${max} (enhed ikke oplyst)`;

  return 'Ikke prissat endnu';
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FreakyvilleTimerPriceBot/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.success || !Array.isArray(data.items)) {
    throw new Error('Ugyldigt svar fra Freakyvilles API');
  }

  return data.items;
}

function createPriceGroupMap(groups) {
  const map = new Map();

  for (const group of groups) {
    map.set(Number(group.id), {
      id: Number(group.id),
      name: group.name || null,
      minDbValue: toNumber(group.minDbValue),
      maxDbValue: toNumber(group.maxDbValue),
      priceInfo: group.priceInfo || null,
      extraPriceInfo: group.extraPriceInfo || null
    });
  }

  return map;
}

async function fetchCategory(categoryId) {
  /* Henter hvert head med dets eget priceInfo-felt. */
  const heads = await getJSON(
    `${API_BASE}/heads/categories/${categoryId}/heads`
  );

  let groupMap = new Map();
  let priceGroupWarning = null;

  try {
    const groups = await getJSON(
      `${API_BASE}/heads/price-groups?categoryId=${categoryId}`
    );

    groupMap = createPriceGroupMap(groups);
  } catch (error) {
    /* Heads vises stadig, hvis prisgruppe-endpointet er nede. */
    priceGroupWarning = {
      categoryId,
      error: error.message
    };
  }

  const items = heads.map(item => {
    const directMin = toNumber(item.minDbValue);
    const directMax = toNumber(item.maxDbValue);

    const priceId =
      item.price_id === null || item.price_id === undefined
        ? null
        : Number(item.price_id);

    const group = priceId !== null ? groupMap.get(priceId) : null;

    const minDbValue =
      directMin !== null
        ? directMin
        : group?.minDbValue ?? null;

    const maxDbValue =
      directMax !== null
        ? directMax
        : group?.maxDbValue ?? null;

    /*
      VIGTIG PRIORITET:
      1. item.priceInfo: pris for det konkrete head, med rigtig enhed.
      2. group.priceInfo: prisgruppe, også med rigtig enhed.
      3. Tal uden opdigtet enhed.
    */
    const priceInfo =
      item.priceInfo ||
      group?.priceInfo ||
      null;

    return {
      id: item.id,
      name: item.name,
      keyword: normalize(item.name),
      categoryId,

      minDbValue,
      maxDbValue,
      priceText: makePriceText(minDbValue, maxDbValue, priceInfo),

      /* Behold rå data, så man kan fejlfinde priser senere. */
      priceInfo,
      extraPriceInfo:
        item.extraPriceInfo ||
        group?.extraPriceInfo ||
        null,
      extraInformation: item.extraInformation || null,

      priceId,
      priceGroup: group?.name || null,
      rarity: item.rarity || null,
      tags: item.tags || null,
      headId: item.headId || null,
      headUrl: item.headUrl || null,
      owner: item.owner || null,
      ownerUpdated: item.ownerUpdated || null
    };
  });

  return { items, priceGroupWarning };
}

function mergeItems(items) {
  const unique = new Map();

  for (const item of items) {
    unique.set(`${item.categoryId}-${item.id}`, item);
  }

  return [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'da')
  );
}

async function refreshPrices(force = false) {
  const cacheIsFresh =
    itemCache.updatedAt &&
    Date.now() - new Date(itemCache.updatedAt).getTime() < CACHE_MS;

  if (!force && cacheIsFresh && itemCache.items.length) {
    return itemCache;
  }

  const responses = await Promise.allSettled(
    CATEGORY_IDS.map(categoryId => fetchCategory(categoryId))
  );

  const allItems = [];
  const failedCategories = [];
  const priceGroupWarnings = [];

  responses.forEach((result, index) => {
    const categoryId = CATEGORY_IDS[index];

    if (result.status === 'fulfilled') {
      allItems.push(...result.value.items);

      if (result.value.priceGroupWarning) {
        priceGroupWarnings.push(result.value.priceGroupWarning);
      }
    } else {
      failedCategories.push({
        categoryId,
        error: result.reason?.message || 'Ukendt fejl'
      });
    }
  });

  const items = mergeItems(allItems);

  /* Behold senest hentede priser, hvis Freakyville midlertidigt fejler. */
  if (!items.length && itemCache.items.length) {
    itemCache = {
      ...itemCache,
      error: 'Kunne ikke opdatere priser. Viser senest hentede priser.',
      failedCategories,
      priceGroupWarnings
    };

    return itemCache;
  }

  itemCache = {
    items,
    updatedAt: new Date().toISOString(),
    error: items.length
      ? null
      : 'Fandt ingen B-værdi-items i Freakyvilles API.',
    failedCategories,
    priceGroupWarnings
  };

  return itemCache;
}

/* Forside: test at serveren er live */
app.get('/', (req, res) => {
  res.send('Freakyville B-værdi item- og timer-API kører.');
});

/* Alle B-værdi-items */
app.get('/api/items', async (req, res) => {
  const data = await refreshPrices(req.query.refresh === '1');

  res.json({
    categories: CATEGORY_IDS,
    updatedAt: data.updatedAt,
    count: data.items.length,
    error: data.error,
    failedCategories: data.failedCategories,
    priceGroupWarnings: data.priceGroupWarnings,
    items: data.items
  });
});

/* Item-søgning til hjemmeside og overlay */
app.get('/api/items/search', async (req, res) => {
  const rawQuery = String(req.query.q || '');
  const query = normalize(rawQuery);
  const terms = query.split(' ').filter(Boolean);

  const data = await refreshPrices(req.query.refresh === '1');

  const results = !terms.length
    ? []
    : data.items
        .filter(item =>
          terms.every(term => item.keyword.includes(term))
        )
        .sort((a, b) => {
          const aRank =
            a.keyword === query ? 0 :
            a.keyword.startsWith(query) ? 1 : 2;

          const bRank =
            b.keyword === query ? 0 :
            b.keyword.startsWith(query) ? 1 : 2;

          return aRank - bRank || a.name.localeCompare(b.name, 'da');
        })
        .slice(0, 25);

  res.json({
    query: rawQuery,
    updatedAt: data.updatedAt,
    totalItems: data.items.length,
    error: data.error,
    failedCategories: data.failedCategories,
    priceGroupWarnings: data.priceGroupWarnings,
    results
  });
});

/*
  --- BO-TIMER-EVENTS: BEHOLDT UÆNDRET ---
  Modtager data fra Python-scriptet på computeren.
*/
app.post('/api/timers/event', (req, res) => {
  const { token, event, timestamp, chatLine } = req.body || {};

  if (!TIMER_TOKEN || token !== TIMER_TOKEN) {
    return res.status(401).json({
      success: false,
      error: 'Forkert eller manglende timer-token'
    });
  }

  const allowedEvents = [
    'bplus_bo_robbed',
    'normal_bo_robbed'
  ];

  if (!allowedEvents.includes(event)) {
    return res.status(400).json({
      success: false,
      error: 'Ukendt timer-event'
    });
  }

  const time = Number(timestamp);

  if (!Number.isFinite(time)) {
    return res.status(400).json({
      success: false,
      error: 'Ugyldigt tidspunkt'
    });
  }

  liveTimers[event] = {
    timestamp: time,
    chatLine: String(chatLine || ''),
    receivedAt: new Date().toISOString()
  };

  liveTimers.updatedAt = new Date().toISOString();

  console.log(`Timer-event modtaget: ${event}`);

  return res.json({
    success: true,
    event,
    timers: liveTimers
  });
});

/* Hjemmesiden og overlayet læser BO-timerne her */
app.get('/api/timers', (req, res) => {
  return res.json({
    success: true,
    timers: liveTimers
  });
});

app.listen(PORT, () => {
  console.log(`Freakyville API kører på port ${PORT}`);
});
