import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

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

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FreakyvilleTimerPriceBot/1.0)',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();

  if (!data.success || !Array.isArray(data.items)) {
    throw new Error('Freakyvilles API svarede ikke med en gyldig itemliste');
  }

  return data.items;
}

function makeGroupMap(groups) {
  const map = new Map();

  for (const group of groups) {
    map.set(Number(group.id), {
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
  /*
    Heads hentes altid. Det er den vigtigste request,
    fordi den giver os selve itemnavnene.
  */
  const
