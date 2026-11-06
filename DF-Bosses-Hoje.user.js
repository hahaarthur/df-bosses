// ==UserScript==
// @name         DF Bosses Hoje
// @namespace    df1
// @version      1.2.1
// @downloadURL  https://raw.githubusercontent.com/hahaarthur/df-bosses/main/DF-Bosses-Hoje.user.js
// @updateURL    https://raw.githubusercontent.com/hahaarthur/df-bosses/main/DF-Bosses-Hoje.user.js
// @description  Painel embaixo do Onslaught Cycles: mostra se Volatile Leaper, Behemoth, Devil Hound e Elite Bandit estão ativos agora ou se o tempo deles já passou hoje.
// @match        *://fairview.deadfrontier.com/onlinezombiemmo/*
// @connect      www.dfprofiler.com
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ======== CONFIG ========
  // Bosses mostrados. "match" é procurado no nome dos inimigos do feed (sem diferenciar maiúscula).
  const BOSSES = [
    { id: 'leaper',   name: 'Volatile Leaper', match: /volatile\s*leaper/i },
    { id: 'behemoth', name: 'Behemoth',        match: /behemoth/i },
    { id: 'hound',    name: 'Devil Hound',     match: /devil\s*hound/i },
    { id: 'bandit',   name: 'Elite Bandit',    match: /elite\s*bandit/i },
  ];

  // Hora (UTC) em que o "feito hoje" zera. 9 = 09:00 UTC = 06:00 no horário de Brasília.
  const RESET_UTC_HOUR = 9;

  // Arquivo atualizado pelo GitHub Actions (funciona mesmo com o jogo fechado).
  // Deixe '' para não usar.
  const REMOTE_URL = 'https://raw.githubusercontent.com/hahaarthur/df-bosses/main/bosses.json';
  const REMOTE_POLL_MS = 5 * 60 * 1000;

  // Mesmo feed que o Onslaught Cycles usa.
  const FEED_URL = 'https://www.dfprofiler.com/bossmap/json/';
  const POLL_MS = 90 * 1000;      // de quanto em quanto tempo atualiza
  const RETRY_MS = 30 * 1000;
  const ONSLAUGHT_COORD = 3000;   // eventos do Onslaught ficam em 3000,3000 — ignorados aqui

  // Posição: logo abaixo do painel do Onslaught Cycles.
  const ONSLAUGHT_PANEL_ID = 'onslaughtCyclesPanel';
  const RIGHT_COLUMN_SELECTOR = "td.design2010[style*='right_margin.jpg']";
  const PANEL_ID = 'dfBossesHojePanel';
  const PANEL_WIDTH_PX = 180;
  const PANEL_GAP_PX = 8;
  const FALLBACK_TOP_PX = 220;    // se o Onslaught Cycles não estiver na página

  const DONE_KEY = 'bosses_done_v2'; // v2: descarta o que a versão antiga guardou (contava boss de wasteland/nest)

  // Só conta o boss ISOLADO (world boss): o evento tem que ter só ele, tipo "1 x Devil Hound".
  // Na wasteland e nos nests ele vem junto com outros inimigos no mesmo evento — esses são ignorados.
  function isWorldBoss(boss, enemiesText) {
    const lines = String(enemiesText).split('\n').map(s => s.trim()).filter(Boolean);
    return lines.length === 1 && boss.match.test(lines[0]);
  }
  const COLLAPSED_KEY = 'bosses_collapsed';

  // Cores no mesmo estilo do Onslaught Cycles
  const COLOR_ACCENT = '#ffb000';
  const COLOR_ACTIVE = '#ffffff';
  const COLOR_IDLE = '#8a8a8a';
  const COLOR_DONE = '#5fbf5f';
  const COLOR_MUTED = '#6f6f6f';

  // ======== NÃO RODA NA TELA DE LOGIN ========
  if (!document.querySelector('a[href*="action=logout"]')) return;

  // ======== "FEITO HOJE" ========
  // Cada boss aparece uma vez por dia e dura ~3h. "Feito" = já apareceu hoje e o tempo dele acabou.
  // O feed apaga o evento pouco depois que termina, então o script GUARDA cada aparição que vê
  // (início/fim, já anunciado ou ativo). Basta o jogo ter ficado aberto uma vez enquanto o boss
  // estava no feed; depois disso ele vira "feito" sozinho quando o horário de fim passar,
  // mesmo que o jogo esteja fechado nessa hora.
  function dayKey(t) {
    const d = new Date(t - RESET_UTC_HOUR * 3600 * 1000);
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }
  function loadDone() {
    let s = null;
    try { s = JSON.parse(GM_getValue(DONE_KEY, 'null')); } catch (e) {}
    if (!s || s.day !== dayKey(Date.now())) s = { day: dayKey(Date.now()), seen: {} };
    s.seen = s.seen || {};
    return s;
  }
  function saveDone(s) {
    try { GM_setValue(DONE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  // Guarda as aparições de hoje vistas no feed
  function rememberSightings() {
    const s = loadDone();
    let changed = false;
    for (const boss of BOSSES) {
      for (const e of events) {
        if (!isWorldBoss(boss, e.enemies) || !e.start || !e.end) continue;
        if (dayKey(e.start) !== s.day) continue;
        const prev = s.seen[boss.id];
        if (!prev || e.end > prev.end) { s.seen[boss.id] = { start: e.start, end: e.end }; changed = true; }
      }
    }
    if (changed) saveDone(s);
  }
  function isDone(s, id, now) {
    const seen = s.seen[id];
    return !!(seen && now >= seen.end);
  }

  // ======== FEED ========
  let events = [];       // { enemies, start, end, startedFlag, endedFlag, locations }
  let lastFetch = 0;
  let lastError = '';
  let fetching = false;

  function request(url) {
    const busted = url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: busted,
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Cache-Control': 'no-cache' },
        timeout: 20000,
        onload: function (res) {
          if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
          resolve(res.responseText);
        },
        onerror: function () { reject(new Error('erro de rede')); },
        ontimeout: function () { reject(new Error('tempo esgotado')); },
      });
    });
  }

  function unescapeHtml(s) {
    const el = document.createElement('textarea');
    el.innerHTML = String(s == null ? '' : s);
    return el.value;
  }
  const toMs = v => { const n = parseInt(v, 10); return (!isNaN(n) && n > 0) ? n * 1000 : 0; };

  function parseFeed(text) {
    const top = JSON.parse(text);
    const out = [];
    for (const key in top) {
      const raw = top[key];
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.locations)) continue;
      if (!raw.special_enemy_type || raw.special_enemy_type === '0') continue;
      const locs = raw.locations.filter(l => Array.isArray(l) && l.length >= 2)
        .map(l => [parseInt(l[0], 10), parseInt(l[1], 10)]);
      if (locs.some(l => l[0] === ONSLAUGHT_COORD && l[1] === ONSLAUGHT_COORD)) continue;
      out.push({
        enemies: unescapeHtml(String(raw.special_enemy_type).replace(/<br\s*\/?>/gi, '\n')),
        start: toMs(raw.start_time),
        end: toMs(raw.end_time),
        startedFlag: raw.started === '1',
        endedFlag: raw.ended === '1',
        locations: locs,
      });
    }
    return out;
  }

  // Junta o que o GitHub viu com o que este navegador viu.
  function pollRemote() {
    if (!REMOTE_URL || REMOTE_URL.indexOf('SEU_USUARIO') !== -1) return;
    request(REMOTE_URL).then(function (text) {
      const remote = JSON.parse(text);
      console.log('[DF Bosses] GitHub lido:', remote && remote.day, Object.keys((remote && remote.seen) || {}));
      const s = loadDone();
      if (!remote || remote.day !== s.day || !remote.seen) return;
      let changed = false;
      for (const boss of BOSSES) {
        const r = remote.seen[boss.id];
        if (!r || !r.end) continue;
        const prev = s.seen[boss.id];
        if (!prev || r.end > prev.end) { s.seen[boss.id] = { start: r.start, end: r.end }; changed = true; }
      }
      if (changed) { saveDone(s); render(); }
    }).catch(function (err) {
      console.warn('[DF Bosses] erro lendo o GitHub:', err && err.message ? err.message : err);
    }).then(function () {
      setTimeout(pollRemote, REMOTE_POLL_MS);
    });
  }

  function poll() {
    if (fetching) return;
    fetching = true;
    request(FEED_URL).then(function (text) {
      events = parseFeed(text);
      lastFetch = Date.now();
      lastError = '';
      rememberSightings();
    }).catch(function (err) {
      lastError = err && err.message ? err.message : String(err);
    }).then(function () {
      fetching = false;
      render();
      setTimeout(poll, lastError && !lastFetch ? RETRY_MS : POLL_MS);
    });
  }

  function isActive(e, now) {
    if (!e.start || !e.end) return e.startedFlag && !e.endedFlag;
    return now >= e.start && now < e.end;
  }

  // Estado de um boss agora: evento ativo (o que termina por último) e o próximo anunciado.
  function bossStatus(boss, now) {
    let active = null, upcoming = null;
    for (const e of events) {
      if (!isWorldBoss(boss, e.enemies)) continue;
      if (isActive(e, now)) { if (!active || e.end > active.end) active = e; }
      else if (e.start > now) { if (!upcoming || e.start < upcoming.start) upcoming = e; }
    }
    return { active, upcoming };
  }

  function shortTime(ms) {
    if (ms < 0) ms = 0;
    const m = Math.ceil(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'm';
  }

  // ======== PAINEL ========
  let panel, headerEl, bodyEl;
  let collapsed = false;

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:absolute;width:' + PANEL_WIDTH_PX + 'px;box-sizing:border-box;z-index:10;' +
      'font-family:"Courier New",Arial;font-size:11px;font-weight:600;' +
      'color:rgb(230,204,77);background:rgba(0,0,0,0.9);' +
      'border:2px solid #990000;padding:5px;user-select:none;';

    headerEl = document.createElement('div');
    headerEl.style.cssText = 'display:flex;justify-content:space-between;gap:6px;color:#fff;cursor:pointer;padding-bottom:3px;';
    headerEl.title = 'Clique para recolher';
    headerEl.addEventListener('click', function () {
      collapsed = !collapsed;
      try { GM_setValue(COLLAPSED_KEY, collapsed); } catch (e) {}
      render();
    });
    panel.appendChild(headerEl);

    bodyEl = document.createElement('div');
    panel.appendChild(bodyEl);

    try { collapsed = GM_getValue(COLLAPSED_KEY, false) === true; } catch (e) {}

    // Fica no <body> (fora da coluna da direita) de propósito: o Onslaught Cycles
    // se posiciona abaixo de tudo que está na coluna, então se este painel ficasse
    // lá dentro os dois ficariam empurrando um ao outro pra baixo.
    document.body.appendChild(panel);
  }

  function dock() {
    const ons = document.getElementById(ONSLAUGHT_PANEL_ID);
    let left, top;
    if (ons && ons.offsetHeight) {
      const r = ons.getBoundingClientRect();
      left = r.left + window.scrollX;
      top = r.bottom + window.scrollY + PANEL_GAP_PX;
    } else {
      const cell = document.querySelector(RIGHT_COLUMN_SELECTOR);
      if (cell) {
        const r = cell.getBoundingClientRect();
        left = r.left + window.scrollX + 10;
        top = r.top + window.scrollY + FALLBACK_TOP_PX;
      } else {
        left = window.scrollX + window.innerWidth - PANEL_WIDTH_PX - PANEL_GAP_PX;
        top = window.scrollY + FALLBACK_TOP_PX;
      }
    }
    const l = Math.round(left) + 'px', t = Math.round(top) + 'px';
    if (panel.style.left !== l) panel.style.left = l;
    if (panel.style.top !== t) panel.style.top = t;
  }

  function bossRow(boss, st, done, now) {
    const active = !!st.active && !done;
    const el = document.createElement('div');
    el.style.cssText =
      'display:flex;gap:5px;align-items:baseline;line-height:1.35;padding-left:4px;' +
      'border-left:3px solid ' + (active ? COLOR_ACCENT : 'transparent') + ';' +
      (active ? 'background:rgba(255,255,255,0.10);' : '');
    if (active && st.active.locations.length) {
      el.title = 'Locais: ' + st.active.locations.map(l => l[0] + ',' + l[1]).join('  ');
    }

    const check = document.createElement('span');
    check.textContent = done ? '✔' : '';
    check.style.cssText = 'flex:0 0 12px;color:' + (done ? COLOR_DONE : COLOR_MUTED) + ';';

    const name = document.createElement('span');
    name.textContent = boss.name;
    name.style.cssText = 'flex:1 1 auto;color:' +
      (done ? COLOR_DONE : active ? COLOR_ACTIVE : COLOR_IDLE) + ';' +
      (done ? 'text-decoration:line-through;' : '');

    const status = document.createElement('span');
    status.style.cssText = 'flex:0 0 auto;';
    if (done) {
      status.textContent = 'feito';
      status.style.color = COLOR_DONE;
    } else if (active) {
      status.textContent = 'ON ' + shortTime(st.active.end - now);
      status.style.color = COLOR_ACCENT;
    } else if (st.upcoming) {
      status.textContent = 'em ' + shortTime(st.upcoming.start - now);
      status.style.color = '#7fd4ff';
    } else {
      status.textContent = '—';
      status.style.color = COLOR_MUTED;
    }

    el.appendChild(check);
    el.appendChild(name);
    el.appendChild(status);
    return el;
  }

  function render() {
    if (!panel) return;
    dock();
    const now = Date.now();
    const ds = loadDone();

    headerEl.textContent = '';
    const title = document.createElement('span');
    title.textContent = 'Bosses Hoje';
    headerEl.appendChild(title);
    const count = document.createElement('span');
    count.textContent = BOSSES.filter(b => isDone(ds, b.id, now)).length + '/' + BOSSES.length;
    count.style.color = '#ddd';
    headerEl.appendChild(count);

    bodyEl.style.display = collapsed ? 'none' : 'block';
    if (collapsed) return;
    bodyEl.textContent = '';

    for (const boss of BOSSES) {
      bodyEl.appendChild(bossRow(boss, bossStatus(boss, now), isDone(ds, boss.id, now), now));
    }

    if (!lastFetch) {
      const msg = document.createElement('div');
      msg.textContent = lastError ? 'erro no feed: ' + lastError : 'carregando...';
      msg.style.cssText = 'color:' + COLOR_MUTED + ';padding-left:7px;';
      bodyEl.appendChild(msg);
    } else if (lastError) {
      const msg = document.createElement('div');
      msg.textContent = 'falha ao atualizar: ' + lastError;
      msg.style.cssText = 'color:' + COLOR_MUTED + ';padding-left:7px;';
      bodyEl.appendChild(msg);
    }
  }

  // ======== INÍCIO ========
  buildPanel();
  render();
  poll();
  pollRemote();
  setInterval(render, 1000);
})();
