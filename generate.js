

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://trellis.consciousb.one/web/user.php?id=';
const AVATAR_BASE = 'https://trellis.consciousb.one/dynamic/avatars/avatar_';
const MIN_ID = 1;
const MAX_ID = 1000;
const MAX_FOLLOWERS = 9999;
const CONCURRENCY = 25;
const TIMEOUT_MS = 12000;
const RETRIES = 2;
const OUTPUT = path.join(__dirname, 'leaderboard.json');


function fetchTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    signal: ctrl.signal,
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0 (LeaderboardBot)'
    }
  }).finally(() => clearTimeout(timer));
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await fetchTimeout(url, TIMEOUT_MS);
    } catch (e) {
      lastErr = e;
      if (i < RETRIES - 1) await new Promise(r => setTimeout(r, 400));
    }
  }
  throw lastErr;
}


function isMissingUser(html) {
  if (/This user doesn'?t exist\.?/i.test(html)) return true;
  if (/User\s+not\s+found/i.test(html)) return true;
  const re = /<div[^>]*class=["']main-content["'][^>]*>[\s\S]*?<h3[^>]*>\s*This user doesn'?t exist\.?\s*<\/h3>[\s\S]*?<\/div>/i;
  return re.test(html);
}

function parseUsername(html, id) {
  const patterns = [
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<h2[^>]*>([\s\S]*?)<\/h2>/i,
    /class="[^"]*username[^"]*"[^>]*>([\s\S]*?)</i,
    /class="[^"]*user-name[^"]*"[^>]*>([\s\S]*?)</i,
    /<title>([\s\S]*?)<\/title>/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      let txt = m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
      if (txt && txt.length < 60 && txt !== 'Trellis') {
        if (txt.includes('·')) txt = txt.split('·')[0].trim();
        if (txt && !/^\d+$/.test(txt)) return txt;
      }
    }
  }
  return `user_${id}`;
}

function parseFollowers(html) {
  const anchorRe = /<a[^>]*href="#followersModal"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const inner = match[1];
    if (!/follower/i.test(inner)) continue;
    const bold = inner.match(/<b[^>]*>([\d,]+)<\/b>/i);
    if (bold) {
      const n = parseInt(bold[1].replace(/,/g, ''), 10);
      if (!isNaN(n)) return n;
    }
    const num = inner.match(/([\d,]+)/);
    if (num) {
      const n = parseInt(num[1].replace(/,/g, ''), 10);
      if (!isNaN(n)) return n;
    }
  }
  const text = html.replace(/<[^>]+>/g, ' ');
  const m = text.match(/([\d,]+)\s*followers?/i);
  if (m) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

function parseAvatar(html, id) {
  // Primary: <img src="..." class="img-polaroid" ...>
  var patterns = [
    /<img[^>]*\bsrc=["']([^"']+)["'][^>]*\bclass=["'][^"']*\bimg-polaroid\b[^"']*["']/i,
    /<img[^>]*\bclass=["'][^"']*\bimg-polaroid\b[^"']*["'][^>]*\bsrc=["']([^"']+)["']/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) {
      var src = m[1].trim();
      if (src.indexOf('http') === 0) return src;
      if (src.indexOf('//') === 0) return 'https:' + src;
      if (src.indexOf('/') === 0) return 'https://trellis.consciousb.one' + src;
      return 'https://trellis.consciousb.one/' + src;
    }
  }

 
  var imgRe = /<img[^>]+src=["']([^"']*\/dynamic\/avatars\/avatar_[^"']*)["']/gi;
  var m2;
  while ((m2 = imgRe.exec(html)) !== null) {
    var s = m2[1];
    if (s.indexOf('http') === 0) return s;
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (s.indexOf('/') === 0) return 'https://trellis.consciousb.one' + s;
    return 'https://trellis.consciousb.one/' + s;
  }

  return AVATAR_BASE + id + '.png';
}


function parseVerified(html) {
  const match = html.match(/<span class="label label-success"><i class="icon-ok icon-white"><\/i>\s* Verified<\/span>/);
  return match !== null;
}


async function fetchUser(id) {
  const url = BASE_URL + id;
  let res;
  try {
    res = await fetchWithRetry(url);
  } catch (e) {
    return { id, ok: false, reason: 'network' };
  }
  if (!res.ok) return { id, ok: false, reason: 'http ' + res.status };

  const html = await res.text();

  if (isMissingUser(html)) {
    return { id, ok: false, reason: 'missing' };
  }

  const followers = parseFollowers(html);
  if (followers === null) return { id, ok: false, reason: 'no followers' };
  if (followers < 0 || followers > MAX_FOLLOWERS) {
    return { id, ok: false, reason: 'range' };
  }

  return {
    id,
    ok: true,
    followers,
    username: parseUsername(html, id),
    avatar: parseAvatar(html, id),
    profile: url,
    verified: parseVerified(html)
  };
}


async function fetchAll() {
  const ids = [];
  for (let i = MIN_ID; i <= MAX_ID; i++) ids.push(i);

  const queue = [...ids];
  const results = [];
  let failed = 0;
  let done = 0;
  const total = ids.length;

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      const r = await fetchUser(id);
      done++;
      if (r.ok) results.push(r);
      else failed++;

      process.stdout.write(
        `\rProgress: ${done}/${total} (ok: ${results.length}, skipped: ${failed})   `
      );
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, total); w++) workers.push(worker());
  await Promise.all(workers);
  console.log('');

  results.sort((a, b) => {
    if (b.followers !== a.followers) return b.followers - a.followers;
    return a.id - b.id;
  });

  let last = null, rank = 0;
  results.forEach((u, idx) => {
    if (u.followers !== last) {
      rank = idx + 1;
      last = u.followers;
    }
    u.rank = rank;
  });

  return { results, failed, total };
}

(async () => {
  const start = Date.now();
  console.log(`Fetching users ${MIN_ID}–${MAX_ID}...`);

  const { results, failed, total } = await fetchAll();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const output = {
    generatedAt: new Date().toISOString(),
    totalFetched: total,
    failed: failed,
    count: results.length,
    leaderboard: results.map(u => ({
      rank: u.rank,
      id: u.id,
      username: u.username,
      followers: u.followers,
      avatar: u.avatar,
      profile: u.profile,
      verified: u.verified === true
    }))
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nDone in ${elapsed}s`);
  console.log(`Wrote ${results.length} users to ${OUTPUT}`);
  console.log(`Skipped: ${failed}`);
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
