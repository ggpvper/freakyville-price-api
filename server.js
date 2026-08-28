import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

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

/*
  Supabase-variabler sættes kun i Render -> Environment.
  Brug din sb_secret_... nøgle her. Den må ALDRIG ligge i HTML, Python
  eller GitHub-kode.
*/
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SECRET_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

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

function isValidLicenseKey(value) {
  return typeof value === 'string' && value.trim().length >= 6 && value.trim().length <= 200;
}

function isValidDeviceHash(value) {
  return typeof value === 'string' && value.trim().length >= 16 && value.trim().length <= 256;
}

function requireSupabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      success: false,
      error: 'Licenssystemet er ikke konfigureret på serveren endnu'
    });
  }

  next();
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
  res.send('Freakyville B-værdi item-, timer- og licens-API kører.');
});

/* Enkel, sikker statuskontrol uden at afsløre nogen hemmelige værdier */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    supabaseConfigured: Boolean(supabase),
    timerTokenConfigured: Boolean(TIMER_TOKEN)
  });
});

/* Alle B-værdi-items */
app.get('/api/items', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/* Item-søgning til hjemmeside og overlay */
app.get('/api/items/search', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/*
  LICENSER

  POST /api/licenses/activate
  Body:
  {
    "licenseKey": "FV-TEST-2026-ABCDE",
    "deviceHash": "en-lang-tilfaeldig-hash-fra-klientprogrammet"
  }

  En ubrugt licens bindes første gang til deviceHash. Senere skal samme
  deviceHash bruges. Hvis kunden får ny PC, nulstiller du device_hash i
  Supabase Table Editor eller SQL Editor.
*/
app.post('/api/licenses/activate', requireSupabase, async (req, res, next) => {
  try {
    const licenseKey = String(req.body?.licenseKey || '').trim();
    const deviceHash = String(req.body?.deviceHash || '').trim();

    if (!isValidLicenseKey(licenseKey) || !isValidDeviceHash(deviceHash)) {
      return res.status(400).json({
        success: false,
        error: 'Ugyldig licenseKey eller deviceHash'
      });
    }

    const { data: license, error: findError } = await supabase
      .from('licenses')
      .select('license_key, device_hash, active, created_at, activated_at')
      .eq('license_key', licenseKey)
      .maybeSingle();

    if (findError) throw findError;

    if (!license) {
      return res.status(404).json({
        success: false,
        error: 'Licensnøglen findes ikke'
      });
    }

    if (!license.active) {
      return res.status(403).json({
        success: false,
        error: 'Denne licens er deaktiveret'
      });
    }

    if (license.device_hash && license.device_hash !== deviceHash) {
      return res.status(403).json({
        success: false,
        error: 'Licensen er allerede aktiveret på en anden computer'
      });
    }

    const now = new Date().toISOString();
    const updates = {
      device_hash: deviceHash,
      activated_at: license.activated_at || now,
      last_seen_at: now
    };

    const { data: updatedLicense, error: updateError } = await supabase
      .from('licenses')
      .update(updates)
      .eq('license_key', licenseKey)
      .select('license_key, active, created_at, activated_at, last_seen_at')
      .single();

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: 'Licensen er aktiv på denne computer',
      license: updatedLicense
    });
  } catch (error) {
    next(error);
  }
});

/*
  POST /api/licenses/validate
  Body:
  {
    "licenseKey": "FV-TEST-2026-ABCDE",
    "deviceHash": "samme-hash-som-ved-aktivering"
  }
*/
app.post('/api/licenses/validate', requireSupabase, async (req, res, next) => {
  try {
    const licenseKey = String(req.body?.licenseKey || '').trim();
    const deviceHash = String(req.body?.deviceHash || '').trim();

    if (!isValidLicenseKey(licenseKey) || !isValidDeviceHash(deviceHash)) {
      return res.status(400).json({
        success: false,
        error: 'Ugyldig licenseKey eller deviceHash'
      });
    }

    const { data: license, error: findError } = await supabase
      .from('licenses')
      .select('license_key, device_hash, active, created_at, activated_at')
      .eq('license_key', licenseKey)
      .maybeSingle();

    if (findError) throw findError;

    if (!license) {
      return res.status(404).json({
        success: false,
        error: 'Licensnøglen findes ikke'
      });
    }

    if (!license.active) {
      return res.status(403).json({
        success: false,
        error: 'Denne licens er deaktiveret'
      });
    }

    if (!license.device_hash) {
      return res.status(403).json({
        success: false,
        error: 'Licensen er ikke aktiveret endnu'
      });
    }

    if (license.device_hash !== deviceHash) {
      return res.status(403).json({
        success: false,
        error: 'Licensen hører til en anden computer'
      });
    }

    const now = new Date().toISOString();

    const { error: updateError } = await supabase
      .from('licenses')
      .update({ last_seen_at: now })
      .eq('license_key', licenseKey);

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: 'Licensen er gyldig',
      license: {
        licenseKey: license.license_key,
        activatedAt: license.activated_at,
        checkedAt: now
      }
    });
  } catch (error) {
    next(error);
  }
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

/* Centralt fejl-svar uden at lække serverens hemmeligheder */
app.use((error, req, res, next) => {
  console.error('Serverfejl:', error);

  return res.status(500).json({
    success: false,
    error: 'Intern serverfejl'
  });
});

app.listen(PORT, () => {
  console.log(`Freakyville API kører på port ${PORT}`);
  console.log(`Supabase licenssystem: ${supabase ? 'konfigureret' : 'mangler environment variables'}`);
});
