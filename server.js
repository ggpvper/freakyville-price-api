import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

const CATEGORY_IDS = [
  18, 19, 20, 21, 22,
  23, 24, 25, 26, 27,
  30, 31, 46, 55, 62
];

const API_BASE = 'https://freakyville.dk/api/heads/categories';
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

function priceText(item) {
  if (item.priceInfo) return item.priceInfo;

  const min = toNumber(item.minDbValue);
  const max = toNumber(item.maxDbValue);

  if (min !== null && max !== null) {
    return min === max ? `${min} DBs` : `${min}-${max} DBs`;
  }

  if (min !== null) return `${min}+ DBs`;
  if (max !== null) return `Op til ${max} DBs`;

  return 'Ikke prissat endnu';
}

function formatItem(item, categoryId) {
  return {
    id: item.id,
    name: item.name,
    keyword: normalize(item.name),
    categoryId,
    minDbValue: toNumber(item.minDbValue),
    maxDbValue: toNumber(item.maxDbValue),
    priceText: priceText(item),
    priceInfo: item.priceInfo || null,
    extraPriceInfo: item.extraPriceInfo || null,
    extraInformation: item.extraInformation || null,
    rarity: item.rarity || null,
    tags: item.tags || null,
    headId: item.headId || null,
    headUrl: item.headUrl || null,
    owner: item.owner || null,
    ownerUpdated: item.ownerUpdated || null
  };
}

async function fetchCategory(categoryId) {
  const url = `${API_BASE}/${categoryId}/heads`;

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
    throw new Error('API svarede ikke med en gyldig itemliste');
  }

  return data.items.map(item => formatItem(item, categoryId));
}

function mergeItems(items) {
  const unique = new Map();

  for (const item of items) {
    const key = `${item.categoryId}-${item.id}`;
    unique.set(key, item);
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
    error: items.length ? null : 'Fandt ingen B-værdi-items i Freakyvilles API.',
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
        .filter(item => terms.every(term => item.keyword.includes(term)))
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
