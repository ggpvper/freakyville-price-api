<!-- INDSÆT CSS I DIN EKSISTERENDE <style>-BLOK -->
<style>
.item-price-section{position:relative;z-index:5;margin-top:18px;padding:18px;border:2px solid #00cfff;border-radius:17px;background:linear-gradient(145deg,#061827,#030b15);box-shadow:0 0 25px #00cfff17}
.item-price-title{margin:0 0 5px;font-size:20px;color:#eaf8ff}.item-price-description{margin:0 0 13px;color:#aebfd1;font-size:12px}.item-price-search-row{display:flex;gap:9px}.item-price-input{width:100%;height:42px;box-sizing:border-box;border:1px solid #00cfff;border-radius:10px;padding:0 12px;background:#071b30;color:#fff;font-size:14px;font-weight:700;outline:none}.item-price-input:focus{box-shadow:0 0 0 3px #00cfff26}.item-price-results{display:grid;gap:8px;margin-top:12px}.item-price-result{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 13px;border:1px solid #24415f;border-radius:10px;background:#04101c}.item-price-name{font-weight:900;color:#f4f8ff}.item-price-value{white-space:nowrap;color:#21ff42;font-weight:950;font-variant-numeric:tabular-nums}.item-price-meta{margin-top:10px;color:#8fa7bd;font-size:10px}.item-price-message{padding:11px 13px;border:1px solid #ffc40055;border-radius:10px;background:#ffc4000c;color:#f2d98c;font-size:12px}@media(max-width:520px){.item-price-search-row{display:block}.item-price-result{align-items:flex-start;flex-direction:column;gap:4px}}
</style>

<!-- INDSÆT HTML'EN LIGE FØR </main> -->
<section class="item-price-section" aria-labelledby="itemPriceTitle">
  <h2 class="item-price-title" id="itemPriceTitle">◆ NPrison item-værdier</h2>
  <p class="item-price-description">Søg efter heads og andre items. Priser vises i DBs og opdateres fra Freakyville via din pris-API.</p>
  <div class="item-price-search-row">
    <input id="itemPriceSearch" class="item-price-input" type="search" autocomplete="off" placeholder="Søg fx Plastic Steve Head" aria-label="Søg efter NPrison item">
  </div>
  <div id="itemPriceResults" class="item-price-results" aria-live="polite"></div>
  <div id="itemPriceMeta" class="item-price-meta">Skriv mindst 2 bogstaver for at søge.</div>
</section>

<!-- INDSÆT SCRIPTET LIGE FØR </body>. RET API_URL TIL DIN EGEN SERVER -->
<script>
(() => {
  'use strict';
  const API_URL = 'https://DIN-API-DOMÆNE.DK/api/items/search';
  const input = document.getElementById('itemPriceSearch');
  const results = document.getElementById('itemPriceResults');
  const meta = document.getElementById('itemPriceMeta');
  let timer;
  let controller;

  const formatDBs = value => new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(value) + ' DBs';
  const formatTime = value => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'ukendt';
  const escapeHTML = text => String(text).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));

  function message(text) {
    results.innerHTML = `<div class="item-price-message">${escapeHTML(text)}</div>`;
  }

  async function search(query) {
    if (controller) controller.abort();
    controller = new AbortController();
    message('Søger efter priser…');

    try {
      const response = await fetch(API_URL + '?q=' + encodeURIComponent(query), { signal: controller.signal });
      if (!response.ok) throw new Error('Kunne ikke hente priser lige nu.');
      const data = await response.json();

      if (data.error && !data.results?.length) throw new Error(data.error);
      if (!data.results?.length) {
        message('Intet item fundet. Prøv fx en kortere søgning eller en anden stavemåde.');
      } else {
        results.innerHTML = data.results.map(item => `
          <article class="item-price-result">
            <span class="item-price-name">${escapeHTML(item.name)}</span>
            <span class="item-price-value">${formatDBs(item.price)}</span>
          </article>
        `).join('');
      }
      meta.textContent = `Senest opdateret: ${formatTime(data.updatedAt)} · Kilde: Freakyville NPrison-priser`;
    } catch (error) {
      if (error.name === 'AbortError') return;
      message(error.message || 'Der opstod en fejl under søgningen.');
      meta.textContent = 'Tjek at API_URL peger på din aktive pris-API.';
    }
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(timer);
    if (query.length < 2) {
      results.innerHTML = '';
      meta.textContent = 'Skriv mindst 2 bogstaver for at søge.';
      return;
    }
    timer = setTimeout(() => search(query), 300);
  });
})();
</script>
