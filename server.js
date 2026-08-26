import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

/* Kun B-værdi-kategorier fra Freakyville */
const SOURCE_URLS = [
  'https://freakyville.dk/priser/nprison/18',
  'https://freakyville.dk/priser/nprison/19',
  'https://freakyville.dk/priser/nprison/20',
  'https://freakyville.dk/priser/nprison/21',
  'https://freakyville.dk/priser/nprison/22',
  'https://freakyville.dk/priser/nprison/23',
  'https://freakyville.dk/priser/nprison/24',
  'https://freakyville.dk/priser/nprison/25',
  'https://freakyville.dk/priser/nprison/26',
  'https://freakyville.dk/priser/nprison/27',
  'https://freakyville.dk/priser/nprison/30',
  'https://freakyville.dk/priser/nprison/31',
  'https://freakyville.dk/priser/nprison/46',
  'https://freakyville.dk/priser/nprison/55',
  'https://freakyville.dk/priser/nprison/62'
];

/* Opdater højst alle 10 minutter */
const CACHE_MS = 10 * 60 * 1000;

app.use(cors({ origin: '*' }));

let cache = {
  items: [],
  updatedAt: null,
  error: null,
  failedSources: []
};

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parsePrice(value = '') {
  const cleaned = String(value)
    .replace(/\./g, '')
    .replace(/,/g, '.');

  const match = cleaned.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function isLikelyItemName(value = '') {
  const text = String(value).trim();

  return (
    text.length >= 2 &&
    text.length <= 120 &&
    /[a-zæøå]/i.test(text) &&
    !/^(pris|værdi|value|dbs?|item)$/i.test(text)
  );
}

function itemFromText(text, source) {
  const value = String(text).replace(/\s+/g, ' ').trim();

  const priceMatch = value.match(
    /(?:^|\s)([\d.,]+)\s*(?:dbs?|db)(?:\s|$)/i
  );

  if (!priceMatch) return null;

  const price = parsePrice(priceMatch[1]);

  const name = value
    .replace(priceMatch[0], ' ')
    .replace(/(?:pris|værdi|value)\s*:?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (price === null || !isLikelyItemName(name)) return null;

  return {
    name,
    price,
    source
  };
}

function extractItems(html, source) {
  const $ = cheerio.load(html);
  const found = [];

  /* Finder items, hvis Freakyville bruger tabeller */
  $('tr').each((_, row) => {
    const cells = $(row)
      .find('td, th')
      .map((__, cell) =>
        $(cell).text().replace(/\s+/g, ' ').trim()
      )
      .get();

    if (cells.length < 2) return;

    const priceCell = cells.find(cell =>
      /\d[\d.,]*\s*(?:dbs?|db)\b/i.test(cell)
    );

    const nameCell = cells.find(
      cell => cell !== priceCell && isLikelyItemName(cell)
    );

    const price = parsePrice(priceCell || '');

    if (nameCell && price !== null) {
      found.push({
        name: nameCell,
        price,
        source
      });
    }
  });

  /*
    Ekstra forsøg: Finder kort, lister og almindelige item-elementer.
    Det gør den mere robust, hvis Freakyville ikke bruger tabeller.
  */
  $('[class*="item"], [class*="price"], li, article, .card, .row').each(
    (_, element) => {
      const item = itemFromText($(element).text(), source);

      if (item) found.push(item);
    }
  );

  return found;
}

function mergeItems(items) {
  const unique = new Map();

  for (const item of items) {
    const key = normalize(item.name);

    if (!key) continue;

    /*
      Hvis samme item står flere steder, beholder den seneste fundne pris.
      Du kan senere ændre dette, hvis Freakyville bruger identiske navne
      til forskellige items.
    */
    unique.set(key, {
      ...item,
      keyword: key
    });
  }

  return [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'da')
  );
}

async function fetchOneSource(source) {
  const response = await fetch(source, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; FreakyvilleTimerPriceBot/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  return extractItems(html, source);
}

async function refreshPrices(force = false) {
  const isFresh =
    cache.updatedAt &&
    Date.now() - new Date(cache.updatedAt).getTime() < CACHE_MS;

  if (!force && isFresh && cache.items.length) {
    return cache;
  }

  const results = await Promise.allSettled(
    SOURCE_URLS.map(source => fetchOneSource(source))
  );

  const allItems = [];
  const failedSources = [];

  results.forEach((result, index) => {
    const source = SOURCE_URLS[index];

    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    } else {
      failedSources.push({
        source,
        error: result.reason?.message || 'Ukendt fejl'
      });
    }
  });

  const items = mergeItems(allItems);

  /*
    Behold sidste fungerende cache, hvis alle kilder fejler midlertidigt.
  */
  if (!items.length && cache.items.length) {
    cache = {
      ...cache,
      error: 'Kunne ikke opdatere priser lige nu. Viser sidste gemte priser.',
      failedSources
    };

    return cache;
  }

  cache = {
    items,
    updatedAt: new Date().toISOString(),
    error: items.length
      ? null
      : 'Fandt ingen priser på B-værdi-siderne.',
    failedSources
  };

  return cache;
}

app.get('/', (req, res) => {
  res.send('Freakyville B-værdi pris-API kører.');
});

/* Se alle fundne items og fejl */
app.get('/api/items', async (req, res) => {
  const data = await refreshPrices(req.query.refresh === '1');

  res.json({
    sources: SOURCE_URLS,
    updatedAt: data.updatedAt,
    count: data.items.length,
    error: data.error,
    failedSources: data.failedSources,
    items: data.items
  });
});

/* Søg: /api/items/search?q=plastic+steve+head */
app.get('/api/items/search', async (req, res) => {
  const rawQuery = req.query.q || '';
  const query = normalize(rawQuery);
  const data = await refreshPrices(req.query.refresh === '1');
  const terms = query.split(' ').filter(Boolean);

  const matches = !terms.length
    ? []
    : data.items
        .filter(item =>
          terms.every(term => item.keyword.includes(term))
        )
        .sort((a, b) => {
          const aRank =
            a.keyword === query ? 0 : a.keyword.startsWith(query) ? 1 : 2;

          const bRank =
            b.keyword === query ? 0 : b.keyword.startsWith(query) ? 1 : 2;

          return (
            aRank - bRank ||
            a.name.localeCompare(b.name, 'da')
          );
        })
        .slice(0, 20);

  res.json({
    sources: SOURCE_URLS,
    query: rawQuery,
    updatedAt: data.updatedAt,
    totalItems: data.items.length,
    error: data.error,
    failedSources: data.failedSources,
    results: matches
  });
});

app.listen(PORT, () => {
  console.log(`Freakyville B-værdi pris-API kører på port ${PORT}`);
});
