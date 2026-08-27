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
  VIGTIGT:
  Opret TIMER_TOKEN i Render → Environment.
  Skriv IKKE din rigtige hemmelige kode direkte i denne fil.
*/
const TIMER_TOKEN = process.env.TIMER_TOKEN;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20kb' }));

/* Gemmer seneste timer-events, modtaget fra dit lokale Python-program */
let liveTimers = {
  bplus_bo_robbed: null,
  normal_bo_robbed: null,
  updatedAt: null
};

/* Gemmer itemdata i 10 minutter, så Freakyvilles API ikke spammes */
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
  Finder den faktiske enhed for en pris.

  Prisgrupper fra Freakyville kan have "stacks", "DBs", "k", osv. i
  priceInfo eller extraPriceInfo. Den gamle version ignorerede det og
  tilføjede altid "DBs" til tal-priser. Derfor blev fx Frozone vist forkert.
*/
function getPriceUnit(...texts) {
  const text = texts
    .filter(Boolean)
    .map(value => String(value))
    .join(' ')
    .toLowerCase();

  if (/\bstacks?\b|\bstk\.?\b/.test(text)) return 'stacks';
  if (/\bdbs?\b|\bdiamond\s*blocks?\b|\bdiamant\s*blocks?\b/.test(text)) return 'DBs';
  if (/\bdiamonds?\b|\bdiamanter?\b/.test(text)) return 'diamonds';
  if (/\bmio\.?\b|\bmillion(er)?\b/.test(text)) return 'mio.';
  if (/\bk\b|\btusind\b/.test(text)) return 'k';

  return null;
}

/*
  Brug altid prisinfo-præcis som Freakyville sender den, når den findes.
  Hvis API'en kun giver min/max-tal, bruger vi enhed fundet i priceInfo,
  extraPriceInfo eller det rå item. DBs bruges kun som sidste fallback,
  når der ingen enhed findes i kildedataen.
*/
function makePriceText(min, max, priceInfo, extraPriceInfo, rawUnitText) {
  if (priceInfo) return String(priceInfo);

  const unit = getPriceUnit(extraPriceInfo, rawUnitText) || 'DBs';

  if (min !== null && max !== null) {
    return min === max ? `${min} ${unit}` : `${min}-${max} ${unit}`;
  }

  if (min !== null) return `${min}+ ${unit}`;
  if (max !== null) return `Op til ${max} ${unit}`;

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
      extraPriceInfo: group.extraPriceInfo || null,

      /* Gem eventuelle enheds-felter fra Freakyvilles API */
      unit: group.unit || group.priceUnit || group.valueUnit || null,
      raw: group
    });
  }

  return map;
}

async function fetchCategory(categoryId) {
  /* Henter alle heads i kategorien. */
  const heads = await getJSON(
    `${API_BASE}/heads/categories/${categoryId}/heads`
  );

  /* Henter kategoriens prisgrupper. */
  let groupMap = new Map();
  let priceGroupWarning = null;

  try {
    const groups = await getJSON(
      `${API_BASE}/heads/price-groups?categoryId=${categoryId}`
    );

    groupMap = createPriceGroupMap(groups);
  } catch (error) {
    priceGroupWarning = {
      categoryId,
      error: error.message
    };
  }

  const items = heads.map(item => {
    const directMin = toNumber(item.minDbValue);
    const directMax = toNumber(item.maxDbValue);
    const directPriceInfo = item.priceInfo || null;

    const priceId =
      item.price_id === null || item.price_id === undefined
        ? null
        : Number(item.price_id);

    const group = priceId !== null ? groupMap.get(priceId) : null;

    /* Prisprioritet: direkte itemdata før prisgruppe. */
    const minDbValue =
      directMin !== null
        ? directMin
        : group?.minDbValue ?? null;

    const maxDbValue =
      directMax !== null
        ? directMax
        : group?.maxDbValue ?? null;

    const priceInfo =
      directPriceInfo ||
      group?.priceInfo ||
      null;

    const extraPriceInfo =
      item.extraPriceInfo ||
      group?.extraPriceInfo ||
      null;

    /* Finder enheden fra alle felter, som den originale API kan sende. */
    const priceUnit = getPriceUnit(
      item.unit,
      item.priceUnit,
      item.valueUnit,
      group?.unit,
      item.extraPriceInfo,
      group?.extraPriceInfo,
      item.priceInfo,
      group?.priceInfo,
      item.price_group_name,
      group?.name
    );

    return {
      id: item.id,
      name: item.name,
      keyword: normalize(item.name),
      categoryId,

      minDbValue,
      maxDbValue,
      priceUnit,
      priceText: makePriceText(
        minDbValue,
        maxDbValue,
        priceInfo,
        extraPriceInfo,
        priceUnit
      ),

      priceInfo,
      extraPriceInfo,
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

  return {
    items,
    priceGroupWarning
  };
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

/* Forside: hurtig test af at Render-serveren er live */
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

/* Item-søgning */
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

/* Modtager timer-events fra det lokale Python-program. */
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

/* Timer-hjemmeside og overlay læser denne status. */
app.get('/api/timers', (req, res) => {
  return res.json({
    success: true,
    timers: liveTimers
  });
});

app.listen(PORT, () => {
  console.log(`Freakyville API kører på port ${PORT}`);
});
