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

const TIMER_TOKEN = process.env.TIMER_TOKEN;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20kb' }));

/* Timer-delen er beholdt */
let liveTimers = {
  bplus_bo_robbed: null,
  normal_bo_robbed: null,
  updatedAt: null
};

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
  Returnerer en enhed KUN hvis Freakyvilles rå data faktisk indeholder den.
  Ingen standard-DBs og ingen gætning. Det forhindrer, at stacks bliver
  vist som DBs og at DBs bliver vist som stacks.
*/
function findExplicitUnit(...values) {
  const text = values
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => String(value))
    .join(' ')
    .toLowerCase();

  if (/\bstacks?\b|\bstk\.?\b/.test(text)) return 'stacks';
  if (/\bdbs?\b|\bdiamond\s*blocks?\b|\bdiamant\s*blocks?\b/.test(text)) return 'DBs';
  if (/\bdiamonds?\b|\bdiamanter?\b/.test(text)) return 'diamonds';
  if (/\bmio\.?\b|\bmillion(er)?\b/.test(text)) return 'mio.';
  if (/\btusind\b|\bk\b/.test(text)) return 'k';

  return null;
}

/*
  VIGTIGT OM ENHEDER

  API'en må ikke selv opfinde "DBs" eller "stacks". Hvis Freakyville
  sender en pris-tekst, viser vi den præcis som den står. Hvis den kun
  sender tal, leder vi efter en enhed i ALLE item- og gruppefelter.

  Hvis kilde-API'en ikke giver enhed nogen steder, vises kun tallet
  uden en falsk enhed, fx "20-25 (enhed ukendt)". Det er ærligt og
  forhindrer at prisdata bliver forkert.
*/
function makePriceText(min, max, priceInfo, unit) {
  if (priceInfo && String(priceInfo).trim()) {
    return String(priceInfo).trim();
  }

  let amount = null;
  if (min !== null && max !== null) {
    amount = min === max ? String(min) : `${min}-${max}`;
  } else if (min !== null) {
    amount = `${min}+`;
  } else if (max !== null) {
    amount = `Op til ${max}`;
  }

  if (!amount) return 'Ikke prissat endnu';

  /* Brug kun enhed der faktisk fandtes i kilde-API'en. */
  return unit ? `${amount} ${unit}` : `${amount} (enhed ukendt)`;
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FreakyvilleTimerPriceBot/1.0)'
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

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

      /* Gem alle almindelige mulige enheds-felter fra Freakyville. */
      unit: group.unit || null,
      priceUnit: group.priceUnit || null,
      valueUnit: group.valueUnit || null,
      raw: group
    });
  }

  return map;
}

async function fetchCategory(categoryId) {
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
    priceGroupWarning = { categoryId, error: error.message };
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

    const minDbValue = directMin !== null ? directMin : group?.minDbValue ?? null;
    const maxDbValue = directMax !== null ? directMax : group?.maxDbValue ?? null;

    /* Hvis priceInfo findes, er det den originale fulde pris-tekst. */
    const priceInfo = directPriceInfo || group?.priceInfo || null;
    const extraPriceInfo = item.extraPriceInfo || group?.extraPriceInfo || null;

    /*
      Finder stacks/DBs osv. fra al rå data, men sætter aldrig selv DBs
      som fallback. Det er det centrale fix.
    */
    const priceUnit = findExplicitUnit(
      item.unit,
      item.priceUnit,
      item.valueUnit,
      item.price_unit,
      item.value_unit,
      item.extraPriceInfo,
      item.priceInfo,
      item.price_group_name,
      item.priceGroup,
      group?.unit,
      group?.priceUnit,
      group?.valueUnit,
      group?.extraPriceInfo,
      group?.priceInfo,
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
      priceText: makePriceText(minDbValue, maxDbValue, priceInfo, priceUnit),

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

  return { items, priceGroupWarning };
}

function mergeItems(items) {
  const unique = new Map();
  for (const item of items) unique.set(`${item.categoryId}-${item.id}`, item);
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'da'));
}

async function refreshPrices(force = false) {
  const cacheIsFresh =
    itemCache.updatedAt &&
    Date.now() - new Date(itemCache.updatedAt).getTime() < CACHE_MS;

  if (!force && cacheIsFresh && itemCache.items.length) return itemCache;

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
    error: items.length ? null : 'Fandt ingen B-værdi-items i Freakyvilles API.',
    failedCategories,
    priceGroupWarnings
  };

  return itemCache;
}

app.get('/', (req, res) => {
  res.send('Freakyville B-værdi item- og timer-API kører.');
});

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

app.get('/api/items/search', async (req, res) => {
  const rawQuery = String(req.query.q || '');
  const query = normalize(rawQuery);
  const terms = query.split(' ').filter(Boolean);
  const data = await refreshPrices(req.query.refresh === '1');

  const results = !terms.length
    ? []
    : data.items
        .filter(item => terms.every(term => item.keyword.includes(term)))
        .sort((a, b) => {
          const aRank = a.keyword === query ? 0 : a.keyword.startsWith(query) ? 1 : 2;
          const bRank = b.keyword === query ? 0 : b.keyword.startsWith(query) ? 1 : 2;
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

/* ALT HERUNDER ER TIMER-KODEN OG ER IKKE ÆNDRET. */
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

app.get('/api/timers', (req, res) => {
  return res.json({
    success: true,
    timers: liveTimers
  });
});

app.listen(PORT, () => {
  console.log(`Freakyville API kører på port ${PORT}`);
});
