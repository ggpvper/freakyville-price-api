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

app.use(cors({ origin: '*' }));

let cache = {
  items: [],
  updatedAt: null,
  error: null,
  failedCategories: []
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

function priceTextFromValues(min, max, fallback = null) {
  if (fallback) return fallback;

  if (min !== null && max !== null) {
    return min === max ? `${min} DBs` : `${min}-${max} DBs`;
  }

  if (min !== null) return `${min}+ DBs`;
  if (max !== null) return `Op til ${max} DBs`;

  return 'Ikke prissat endnu';
}

function makeGroupMap(groups) {
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

function formatItem(item, categoryId, groupMap) {
  const ownMin = toNumber(item.minDbValue);
  const ownMax = toNumber(item.maxDbValue);

  const priceId =
    item.price_id === null || item.price_id === undefined
      ? null
      : Number(item.price_id);

  const group = priceId !== null ? groupMap.get(priceId) : null;

  /*
    Bruger først itemets direkte værdi.
    Hvis den mangler, bruges værdien fra den tilknyttede prisgruppe.
  */
  const minDbValue = ownMin ?? group?.minDbValue ?? null;
  const maxDbValue = ownMax ?? group?.maxDbValue ?? null;
  const priceInfo = item.priceInfo || group?.priceInfo || null;
  const extraPriceInfo = item.extraPriceInfo || group?.extraPriceInfo || null;

  return {
    id: item.id,
    name: item.name,
    keyword: normalize(item.name),
    categoryId,

    minDbValue,
    maxDbValue,
    priceText: priceTextFromValues(minDbValue, maxDbValue, priceInfo),

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
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FreakyvilleTimerPriceBot/1.0)',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.success || !Array.isArray(data.items)) {
    throw new Error('Freakyvilles API svarede ikke med en gyldig itemliste');
  }

  return data.items;
}

async function fetchCategory(categoryId) {
  const [heads, priceGroups] = await Promise.all([
    getJSON(`${API_BASE}/heads/categories/${categoryId}/heads`),
    getJSON(`${API_BASE}/price-groups?categoryId=${categoryId}`)
  ]);

  const groupMap = makeGroupMap(priceGroups);

  return heads.map(item => formatItem(item, categoryId, groupMap));
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
    cache.updatedAt &&
    Date.now() - new Date(cache.updatedAt).getTime() < CACHE_MS;

  if (!force && cacheIsFresh && cache.items.length) {
    return cache;
  }

  const responses = await Promise.allSettled(
    CATEGORY_IDS.map(categoryId => fetchCategory(categoryId))
  );

  const allItems = [];
  const failedCategories = [];

  responses.forEach((result, index) => {
    const categoryId = CATEGORY_IDS[index];

    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    } else {
      failedCategories.push({
        categoryId,
        error: result.reason?.message || 'Ukendt fejl'
      });
    }
  });

  const items = mergeItems(allItems);

  /* Behold gamle værdier, hvis Freakyvilles API midlertidigt ikke svarer */
  if (!items.length && cache.items.length) {
    cache = {
      ...cache,
      error: 'Kunne ikke opdatere priser. Viser senest gemte værdier.',
      failedCategories
    };

    return cache;
  }

  cache = {
    items,
    updatedAt: new Date().toISOString(),
    error: items.length
      ? null
      : 'Fandt ingen B-værdi-items i Freakyvilles API.',
    failedCategories
  };

  return cache;
}

app.get('/', (req, res) => {
  res.send('Freakyville B-værdi pris-API kører.');
});

app.get('/api/items', async (req, res) => {
  const data = await refreshPrices(req.query.refresh === '1');

  res.json({
    categories: CATEGORY_IDS,
    updatedAt: data.updatedAt,
    count: data.items.length,
    error: data.error,
    failedCategories: data.failedCategories,
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
    results
  });
});

app.listen(PORT, () => {
  console.log(`Freakyville B-værdi pris-API kører på port ${PORT}`);
});
