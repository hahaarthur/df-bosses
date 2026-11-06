// Roda no GitHub Actions a cada ~10 minutos.
// Lê o feed do DFProfiler e guarda em bosses.json cada boss que apareceu no dia,
// com horário de início e fim. O userscript "DF Bosses Hoje" lê esse arquivo.

const fs = require('fs');
const path = require('path');

// Mesmos bosses e mesmo reset do userscript.
const BOSSES = [
  { id: 'leaper',   match: /volatile\s*leaper/i },
  { id: 'behemoth', match: /behemoth/i },
  { id: 'hound',    match: /devil\s*hound/i },
  { id: 'bandit',   match: /elite\s*bandit/i },
];
const RESET_UTC_HOUR = 9;

const FEED_URL = 'https://www.dfprofiler.com/bossmap/json/';
const OUT_FILE = path.join(__dirname, 'bosses.json');
const ONSLAUGHT_COORD = 3000;

function dayKey(t) {
  const d = new Date(t - RESET_UTC_HOUR * 3600 * 1000);
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}

const toMs = v => { const n = parseInt(v, 10); return (!isNaN(n) && n > 0) ? n * 1000 : 0; };

function cleanEnemies(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

async function main() {
  const res = await fetch(FEED_URL + '?_=' + Date.now(), {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Cache-Control': 'no-cache',
      'User-Agent': 'df-bosses-hoje (github actions)',
    },
  });
  if (!res.ok) throw new Error('feed HTTP ' + res.status);
  const top = await res.json();

  const today = dayKey(Date.now());
  let data = null;
  try { data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) {}
  if (!data || data.day !== today) data = { day: today, seen: {} };
  data.seen = data.seen || {};

  let changed = false;
  for (const key in top) {
    const raw = top[key];
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.locations)) continue;
    if (!raw.special_enemy_type || raw.special_enemy_type === '0') continue;
    const locs = raw.locations.filter(l => Array.isArray(l) && l.length >= 2)
      .map(l => [parseInt(l[0], 10), parseInt(l[1], 10)]);
    if (locs.some(l => l[0] === ONSLAUGHT_COORD && l[1] === ONSLAUGHT_COORD)) continue;

    const enemies = cleanEnemies(raw.special_enemy_type);
    const start = toMs(raw.start_time), end = toMs(raw.end_time);
    if (!start || !end || dayKey(start) !== today) continue;

    for (const boss of BOSSES) {
      if (!boss.match.test(enemies)) continue;
      const prev = data.seen[boss.id];
      if (!prev || end > prev.end) {
        data.seen[boss.id] = { start, end, locations: locs };
        changed = true;
        console.log('visto:', boss.id, new Date(start).toISOString(), '->', new Date(end).toISOString());
      }
    }
  }

  // Só grava quando algo mudou (ou virou o dia), pra não criar commit à toa.
  const before = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
  const after = JSON.stringify(data, null, 2) + '\n';
  if (changed || before !== after) {
    fs.writeFileSync(OUT_FILE, after);
    console.log('bosses.json atualizado');
  } else {
    console.log('nada novo');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
