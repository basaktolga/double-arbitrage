// ==UserScript==
// @name         Boosted Odds Finder
// @description  Finds Stake boosted odds across every sport category and uploads them to your hosted Arb Finder
// @version      1.0
// @match        *://searedup.com/*
// @match        *://*.searedup.com/*
// @match        *://stake.com/*
// @match        *://*.stake.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'bof-panel';
  const BTN_ID = 'bof-btn';
  const BANNER_ID = 'bof-banner';
  const KEY = 'bof_state_v4';
  const CFG_KEY = 'bof_cfg_v5';
  const STALE_CRAWL_MS = 20 * 60 * 1000;

  if (document.getElementById(BTN_ID)) return;

  const DEFAULT_SLUGS = [
    'home', 'soccer', 'basketball', 'tennis', 'ice-hockey', 'baseball', 'american-football',
    'mma', 'boxing', 'volleyball', 'table-tennis', 'cricket', 'esports', 'handball',
    'darts', 'rugby-union', 'rugby-league', 'snooker', 'badminton', 'futsal', 'aussie-rules',
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (s) => parseFloat(String(s).trim().replace(',', '.'));
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  // ---------- state ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (e) { return fresh(); }
  }
  function fresh() { return { active: false, queue: [], done: [], results: {}, log: [] }; }
  function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }

  // cloud settings: { url, key, auto, intervalMin, nextRun, lastUpload, lastUploadMsg }
  // Settings (server URL + upload key) live in the userscript manager's own storage
  // when available, so the site's scripts can't read them from localStorage.
  const CFG_DEFAULT = { url: '', key: '', auto: false, intervalMin: 30, nextRun: 0 };
  const gmGet = (typeof GM !== 'undefined' && GM && GM.getValue) ? (k) => GM.getValue(k, '')
    : (typeof GM_getValue === 'function') ? (k) => Promise.resolve(GM_getValue(k, '')) : null;
  const gmSet = (typeof GM !== 'undefined' && GM && GM.setValue) ? (k, v) => GM.setValue(k, v)
    : (typeof GM_setValue === 'function') ? (k, v) => Promise.resolve(GM_setValue(k, v)) : null;
  let cfgCache = null;
  async function initCfg() {
    if (!gmGet) return;
    try {
      const raw = await gmGet(CFG_KEY);
      cfgCache = raw ? JSON.parse(raw) : null;
      if (!cfgCache) { // migrate from older versions that used localStorage
        const old = localStorage.getItem(CFG_KEY);
        if (old) { cfgCache = JSON.parse(old); await gmSet(CFG_KEY, old); localStorage.removeItem(CFG_KEY); }
      }
    } catch (e) { cfgCache = null; }
  }
  function loadCfg() {
    try {
      const src = gmGet ? cfgCache : JSON.parse(localStorage.getItem(CFG_KEY));
      return Object.assign({}, CFG_DEFAULT, src || {});
    } catch (e) { return Object.assign({}, CFG_DEFAULT); }
  }
  function saveCfg(c) {
    if (gmGet && gmSet) { cfgCache = c; gmSet(CFG_KEY, JSON.stringify(c)); return; }
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
  }

  // ---------- scanning ----------
  function matchName(btn) {
    let n = btn.parentElement;
    for (let i = 0; i < 10 && n && n !== document.body; i++, n = n.parentElement) {
      const sibs = n.querySelectorAll('[data-testid="fixture-outcome"]');
      if (sibs.length >= 2) {
        const names = [];
        sibs.forEach((s) => {
          const nm = s.getAttribute('aria-label') || txt(s.querySelector('[data-testid="outcome-button-name"]'));
          if (nm && !names.includes(nm)) names.push(nm);
        });
        return names.slice(0, 3).join(' vs ');
      }
    }
    return '';
  }

  function categoryOfPage() {
    const m = location.pathname.match(/\/sports\/([^/]+)/);
    return m ? m[1] : location.pathname.replace(/\//g, '') || 'home';
  }

  function scanDom() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('[data-testid="multi-bet-boosted-odds"]').forEach((boostedEl) => {
      const btn = boostedEl.closest('button, a, [data-testid="fixture-outcome"]') || boostedEl.parentElement.parentElement;
      if (!btn || seen.has(btn)) return;
      seen.add(btn);
      const oldEl = btn.querySelector('[data-testid="multi-bet-original-odds"]');
      const nameEl = btn.querySelector('[data-testid="outcome-button-name"]');
      const newOdds = num(txt(boostedEl));
      const oldOdds = oldEl ? num(txt(oldEl)) : null;
      if (!(newOdds > 1)) return;
      out.push({
        label: btn.getAttribute('aria-label') || txt(nameEl) || '(selection)',
        match: matchName(btn),
        oldOdds,
        newOdds,
        uplift: oldOdds > 1 ? (newOdds / oldOdds - 1) * 100 : null,
        category: categoryOfPage(),
      });
    });
    return out;
  }

  // The same selection shows up on the home page and on its sport page. Keep one copy and
  // prefer the sport page's category, because the worker needs the sport to match fixtures.
  function merge(st, items) {
    let added = 0;
    items.forEach((r) => {
      const k = [r.match, r.label, r.oldOdds, r.newOdds].join('|');
      const ex = st.results[k];
      if (!ex) { st.results[k] = r; added++; }
      else if ((ex.category === 'home' || !ex.category) && r.category && r.category !== 'home') ex.category = r.category;
    });
    return added;
  }

  async function scrollScan(st) {
    let still = 0;
    let added = 0;
    window.scrollTo(0, 0);
    await sleep(300);
    for (let i = 0; i < 25; i++) {
      added += merge(st, scanDom());
      const before = window.scrollY;
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      await sleep(550);
      if (Math.abs(window.scrollY - before) < 4) { if (++still >= 2) break; } else still = 0;
    }
    added += merge(st, scanDom());
    window.scrollTo(0, 0);
    return added;
  }

  // ---------- upload ----------
  function postText(url, body, key) {
    const gm = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
    if (gm) {
      return new Promise((resolve, reject) => {
        gm({
          method: 'POST', url, data: body, headers: { 'Content-Type': 'application/json', 'X-Upload-Key': key },
          onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
        });
      });
    }
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Key': key }, body })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }

  async function upload(st) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) return 'Cloud not set up (tap Cloud)';
    const items = Object.values(st.results);
    if (!items.length) return 'Nothing to upload';
    try {
      const base = cfg.url.replace(/\/+$/, '');
      await postText(base + '/api/stake/upload', JSON.stringify({ scannedAt: Date.now(), items }), cfg.key);
      cfg.lastUpload = Date.now();
      cfg.lastUploadMsg = 'Uploaded ' + items.length + ' items';
      saveCfg(cfg);
      return cfg.lastUploadMsg;
    } catch (e) {
      cfg.lastUploadMsg = 'Upload failed: ' + e.message;
      saveCfg(cfg);
      return cfg.lastUploadMsg;
    }
  }

  // ---------- crawl ----------
  function discoverUrls() {
    const m = location.pathname.match(/^(.*?\/sports)(\/|$)/);
    const base = location.origin + (m ? m[1] : '/sports');
    const slugs = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        if (u.origin !== location.origin) return;
        const mm = u.pathname.match(/\/sports\/([a-z0-9-]+)\/?$/i);
        if (mm && !slugs.includes(mm[1])) slugs.push(mm[1]);
      } catch (e) {}
    });
    DEFAULT_SLUGS.forEach((s) => { if (!slugs.includes(s)) slugs.push(s); });
    return slugs.map((s) => base + '/' + s);
  }

  function setBanner(text, stopFn) {
    let b = document.getElementById(BANNER_ID);
    if (!text) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = BANNER_ID;
      Object.assign(b.style, {
        position: 'fixed', left: '8px', right: '8px', top: '8px', zIndex: 2147483647,
        background: '#1a2c38', color: '#fff', border: '1px solid #00e701', borderRadius: '10px',
        padding: '10px', font: '14px -apple-system, sans-serif', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
      });
      document.body.appendChild(b);
    }
    b.innerHTML = '';
    const s = document.createElement('span');
    s.textContent = text;
    b.appendChild(s);
    if (stopFn) {
      const x = mkBtn('Stop', stopFn);
      x.style.marginRight = '0';
      b.appendChild(x);
    }
  }

  function startCrawl() {
    const st = fresh();
    st.active = true;
    st.startedAt = Date.now();
    st.queue = discoverUrls();
    st.total = st.queue.length;
    save(st);
    goNextOrStep(st);
  }

  function goNextOrStep(st) {
    const target = new URL(st.queue[0]);
    if (target.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '')) crawlStep();
    else location.href = st.queue[0];
  }

  async function finishCrawl(st) {
    st.active = false;
    save(st);
    const cfg = loadCfg();
    cfg.nextRun = Date.now() + (cfg.intervalMin || 30) * 60000;
    saveCfg(cfg);
    setBanner('Scan done, uploading…');
    const msg = await upload(st);
    setBanner(msg);
    setTimeout(() => setBanner(''), 4000);
    render();
  }

  async function crawlStep() {
    let st = load();
    if (!st.active || !st.queue.length) return;
    const stop = () => { const s = load(); s.active = false; save(s); setBanner(''); render(); };
    setBanner(`Scanning ${st.total - st.queue.length + 1}/${st.total}: ${categoryOfPage()}…`, stop);
    await sleep(3500);
    st = load();
    if (!st.active) return;
    const added = await scrollScan(st);
    st.log.push(`${categoryOfPage()}: +${added}`);
    st.done.push(location.pathname);
    st.queue.shift();
    if (st.queue.length) {
      save(st);
      goNextOrStep(st);
    } else {
      await finishCrawl(st);
    }
  }

  // ---------- auto mode ----------
  function autoTick() {
    const cfg = loadCfg();
    if (!cfg.auto || !cfg.url || !cfg.key) return;
    const st = load();
    if (st.active) {
      if (st.startedAt && Date.now() - st.startedAt > STALE_CRAWL_MS) { st.active = false; save(st); } // stuck crawl
      return;
    }
    if (Date.now() >= (cfg.nextRun || 0)) startCrawl();
  }

  // ---------- UI ----------
  const fab = document.createElement('button');
  fab.id = BTN_ID;
  fab.textContent = '⚡';
  Object.assign(fab.style, {
    position: 'fixed', right: '14px', bottom: '110px', zIndex: 2147483647,
    width: '48px', height: '48px', borderRadius: '24px', border: 'none',
    background: '#00e701', color: '#000', fontSize: '22px',
    boxShadow: '0 2px 10px rgba(0,0,0,.5)',
  });
  document.body.appendChild(fab);

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function mkBtn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      padding: '8px 12px', marginRight: '6px', marginBottom: '6px', border: '1px solid #2f4553',
      background: '#1a2c38', color: '#fff', borderRadius: '6px', fontSize: '14px',
    });
    b.onclick = fn;
    return b;
  }

  function setupCloud() {
    const cfg = loadCfg();
    const url = prompt('Arb Finder URL (e.g. https://arb-finder.onrender.com):', cfg.url || '');
    if (url === null) return;
    const key = prompt('Upload key (UPLOAD_KEY on Render, or APP_PASSWORD if you did not set one):', cfg.key || '');
    if (key === null) return;
    cfg.url = url.trim();
    cfg.key = key.trim();
    saveCfg(cfg);
  }

  function ago(ts) {
    if (!ts) return 'never';
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'just now' : m + ' min ago';
  }

  function render() {
    let p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    p = document.createElement('div');
    p.id = PANEL_ID;
    Object.assign(p.style, {
      position: 'fixed', left: '8px', right: '8px', bottom: '8px', top: '60px',
      zIndex: 2147483647, background: '#0f212e', color: '#fff', borderRadius: '12px',
      padding: '12px', overflow: 'auto', font: '14px -apple-system, sans-serif',
      boxShadow: '0 4px 20px rgba(0,0,0,.7)',
    });

    const st = load();
    const cfg = loadCfg();
    const results = Object.values(st.results)
      .sort((a, b) => (b.uplift ?? -1) - (a.uplift ?? -1));

    const head = document.createElement('div');
    head.style.marginBottom = '6px';
    head.appendChild(mkBtn('Scan ALL categories', () => { p.remove(); startCrawl(); }));
    head.appendChild(mkBtn('Scan this page', async () => {
      const s = load();
      setBanner('Scanning this page…');
      await scrollScan(s);
      save(s);
      setBanner('');
      render();
    }));
    head.appendChild(mkBtn('Upload now', async () => {
      const msg = await upload(load());
      setBanner(msg);
      setTimeout(() => setBanner(''), 3500);
      render();
    }));
    head.appendChild(mkBtn('Cloud setup', () => { setupCloud(); render(); }));
    head.appendChild(mkBtn(cfg.auto ? 'Auto: ON (tap to stop)' : 'Auto: OFF (tap to start)', () => {
      const c = loadCfg();
      if (!c.auto && (!c.url || !c.key)) { setupCloud(); }
      const c2 = loadCfg();
      if (!c2.url || !c2.key) { render(); return; }
      c2.auto = !c.auto;
      c2.nextRun = 0;
      saveCfg(c2);
      render();
      if (c2.auto) autoTick();
    }));
    head.appendChild(mkBtn('Copy', () => {
      copyText(results.map((r) =>
        `[${r.category}] ${r.match ? r.match + ' | ' : ''}${r.label} | ${r.oldOdds ?? '?'} -> ${r.newOdds}` +
        (r.uplift != null ? ` | +${r.uplift.toFixed(1)}%` : '')
      ).join('\n'));
    }));
    head.appendChild(mkBtn('Debug', () => {
      // Copies a slice of the page structure so a broken selector can be fixed.
      const el = document.querySelector('[data-testid="multi-bet-boosted-odds"]') ||
        document.querySelector('[data-testid="fixture-outcome"]');
      let c = el;
      for (let i = 0; c && i < 4 && c.parentElement; i++) c = c.parentElement;
      const dump = c ? c.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').slice(0, 4000)
        : 'No odds elements found on ' + location.pathname;
      copyText(dump);
      setBanner(c ? 'Page structure copied — paste it to Claude' : 'No odds elements on this page');
      setTimeout(() => setBanner(''), 3000);
    }));
    head.appendChild(mkBtn('Clear', () => { save(fresh()); render(); }));
    head.appendChild(mkBtn('Close', () => p.remove()));
    p.appendChild(head);

    const cloud = document.createElement('div');
    cloud.style.cssText = 'color:#7f8ea3;margin-bottom:6px;font-size:12px';
    cloud.textContent = !cfg.url
      ? 'Cloud: not set up'
      : 'Cloud: ' + (cfg.lastUploadMsg || 'no upload yet') + ' (' + ago(cfg.lastUpload) + ')' +
        (cfg.auto ? ' · auto every ' + (cfg.intervalMin || 30) + ' min, next ' + (cfg.nextRun > Date.now() ? 'in ' + Math.round((cfg.nextRun - Date.now()) / 60000) + ' min' : 'now') : '');
    p.appendChild(cloud);

    const info = document.createElement('div');
    info.style.cssText = 'color:#b1bad3;margin-bottom:8px;font-size:13px';
    info.textContent = results.length
      ? `${results.length} boosted selection(s), sorted by uplift`
      : 'Nothing stored yet. Tap "Scan ALL categories".';
    p.appendChild(info);

    if (st.log && st.log.length) {
      const lg = document.createElement('div');
      lg.style.cssText = 'color:#7f8ea3;margin-bottom:8px;font-size:12px';
      lg.textContent = 'Last crawl: ' + st.log.join(', ');
      p.appendChild(lg);
    }

    results.forEach((r) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        background: '#1a2c38', borderRadius: '8px', padding: '10px', marginBottom: '8px',
      });
      const top = document.createElement('div');
      top.style.cssText = 'font-weight:600;margin-bottom:2px';
      top.textContent = r.label;
      row.appendChild(top);
      const sub = document.createElement('div');
      sub.style.cssText = 'color:#b1bad3;font-size:12px;margin-bottom:4px';
      sub.textContent = (r.match ? r.match + ' · ' : '') + r.category;
      row.appendChild(sub);
      const odds = document.createElement('div');
      odds.innerHTML =
        `<b style="color:#ff9800;font-size:18px">${r.newOdds.toFixed(2)}</b>` +
        (r.oldOdds != null ? ` <span style="color:#b1bad3;text-decoration:line-through">${r.oldOdds.toFixed(2)}</span>` : '') +
        (r.uplift != null ? ` <span style="color:#ffd600">+${r.uplift.toFixed(1)}%</span>` : '');
      row.appendChild(odds);
      p.appendChild(row);
    });

    document.body.appendChild(p);
  }

  fab.onclick = render;

  initCfg().then(() => {
    // Resume an in-progress crawl after a page navigation
    const st0 = load();
    if (st0.active && st0.queue.length) crawlStep();

    // Auto mode: check every 30 s whether a scan is due (only while a tab is open and active)
    setInterval(autoTick, 30000);
    setTimeout(autoTick, 6000);
  });
})();
