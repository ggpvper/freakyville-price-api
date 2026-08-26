import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

/*
  Alle B-værdi-kategorier fra Freakyville.
  Hver kategori hentes fra:
  https://freakyville.dk/api/heads/categories/KATEGORI/heads
*/
const CATEGORY_IDS = [
  18, 19, 20, 21, 22,
  23, 24, 25, 26, 27,
  30, 31, 46, 55, 62
];

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
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function makePriceText(item) {
  if (item.priceInfo) {
    return item.priceInfo;
  }

  const min = toNumber(item.minDbValue);
  const max = toNumber(item.maxDbValue);

  if (min !== null && max !== null) {
    return min === max ? `${min} DBs` : `${min}-${max} DBs`;
  }

  if (min !== null) {
    return `${min}+ DBs`;
  }

  if (max !== null) {
    return `Op til ${max} DBs`;
  }

  return 'Ikke prissat endnu';
}

async function fetchCategory(categoryId) {
  const url = `https://freakyville.dk/api/heads/categories/${categoryId}/heads`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Kategori ${categoryId}: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.success || !Array.isArray(data.items)) {
    throw new Error(`Kategori ${categoryId}: ugyldigt API-svar`);
  }

  return data.items.map(item => ({
    id: item.id,
    name: item.name,
    keyword: normalize(item.name),
    categoryId,

    minDbValue: toNumber(item.minDbValue),
    maxDbValue: toNumber(item.maxDbValue),
    priceText: makePriceText(item),

    priceInfo: item.priceInfo || null,
    extraPriceInfo: item.extraPriceInfo || null,
    extraInformation: item.extraInformation || null,

    priceId: item.price_id || null,
    rarity: item.rarity || null,
    tags: item.tags || null,

    headId: item.headId || null,
    headUrl: item.headUrl || null,

    owner: item.owner || null,
    ownerUpdated: item.ownerUpdated || null
  }));
}

function combineItems(items) {
  const unique = new Map();

  for (const item of items) {
    /*
      Brug categoryId + item-id, så heads med samme navn
      i forskellige kategorier ikke bliver fjernet.
    */
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

  const requests = await Promise.allSettled(
    CATEGORY_IDS.map(categoryId => fetchCategory(categoryId))
  );

  const allItems = [];
  const failedCategories = [];

  requests.forEach((result, index) => {
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

  const items = combineItems(allItems);

  /*
    Hvis Freakyville kortvarigt ikke svarer, beholdes de seneste priser,
    så søgningen ikke går helt tom.
  */
  if (!items.length && cache.items.length) {
    cache = {
      ...cache,
      error: 'Kunne ikke opdatere lige nu. Viser senest hentede priser.',
      failedCategories
    };

    return cache;
  }

  cache = {
    items,
    updatedAt: new Date().toISOString(),
    error: items.length
      ? null
      : 'Fandt ingen items fra Freakyvilles B-værdi API.',
    failedCategories
  };

  return cache;
}

app.get('/', (req, res) => {
  res.send('Freakyville B-værdi item-API kører.');
});

/* Se alle hentede B-værdi-items */
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

/*
  Søg eksempel:
  /api/items/search?q=jellyfish
  /api/items/search?q=pickle+rick
*/
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
  console.log(`Freakyville B-værdi API kører på port ${PORT}`);
});
