'use strict';

// ── STATE ──
let S = {
  base: '',
  raw: '',
  rules: [],
  sitemaps: [],
  extractedSitemapUrls: [],
  currentTab: 'disallow', // 'disallow' | 'allow' | 'sitemap' | 'combined'
  selected: new Set(),
  aborted: false,
  isEditing: false,
  batchResults: [],
  probeStatus: {} // url -> 'live' | 200 | 403 | 404 | 'err'
};

// ── FAST PARALLEL MULTI-TIER PROXY FETCHER (Promise.any) ──
async function fetchText(url) {
  const sources = [
    // Source 1: Jina reader proxy (bypasses Cloudflare WAF, plain text)
    (async () => {
      const r = await fetch('https://r.jina.ai/' + url, {
        headers: { 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(6500)
      });
      if (!r.ok) throw new Error('Jina status ' + r.status);
      let t = await r.text();
      if (t.includes('Markdown Content:')) {
        t = t.split('Markdown Content:')[1].trim();
      }
      t = cleanFetchedText(t);
      if (!isLikelyValidContent(t)) throw new Error('Invalid content');
      return t;
    })(),

    // Source 2: Direct fetch (for permissive/same-origin targets)
    (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('Direct status ' + r.status);
      const t = await r.text();
      if (!t || t.length < 5) throw new Error('Empty');
      return t.trim();
    })(),

    // Source 3: Codetabs CORS proxy
    (async () => {
      const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) throw new Error('Codetabs status ' + r.status);
      const t = await r.text();
      const cleaned = cleanFetchedText(t);
      if (!isLikelyValidContent(cleaned)) throw new Error('Invalid');
      return cleaned;
    })(),

    // Source 4: Corsproxy.io
    (async () => {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) throw new Error('Corsproxy status ' + r.status);
      const t = await r.text();
      const cleaned = cleanFetchedText(t);
      if (!isLikelyValidContent(cleaned)) throw new Error('Invalid');
      return cleaned;
    })(),

    // Source 5: AllOrigins
    (async () => {
      const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) throw new Error('Allorigins status ' + r.status);
      const t = await r.text();
      const cleaned = cleanFetchedText(t);
      if (!isLikelyValidContent(cleaned)) throw new Error('Invalid');
      return cleaned;
    })()
  ];

  try {
    const text = await Promise.any(sources);
    return { ok: true, text };
  } catch (err) {
    console.warn('All parallel proxies failed for', url, err);
    return { ok: false, text: '' };
  }
}

function cleanFetchedText(txt) {
  if (!txt) return '';
  let t = txt.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  return t.trim();
}

function isLikelyValidContent(txt) {
  if (!txt) return false;
  const lo = txt.toLowerCase();
  return lo.includes('user-agent') || lo.includes('disallow') || lo.includes('allow') || lo.includes('sitemap') || lo.includes('<urlset') || lo.includes('<sitemapindex') || lo.includes('http') || txt.length > 20;
}

// ── ROBOTS.TXT DIRECTIVE PARSER ──
function parseRobots(txt) {
  const lines = txt.split(/\r?\n/);
  const rules = [];
  let currentAgents = ['*'];

  for (let raw of lines) {
    let line = raw.trim();
    const hashIdx = line.indexOf('#');
    if (hashIdx !== -1) line = line.substring(0, hashIdx).trim();
    if (!line) continue;

    const lo = line.toLowerCase();

    if (lo.startsWith('user-agent:')) {
      const ag = line.slice(11).trim();
      currentAgents = [ag];
    } else if (lo.startsWith('disallow:')) {
      const path = line.slice(9).trim();
      if (path) {
        currentAgents.forEach(a => rules.push({ type: 'dis', agent: a, path }));
      }
    } else if (lo.startsWith('allow:')) {
      const path = line.slice(6).trim();
      if (path) {
        currentAgents.forEach(a => rules.push({ type: 'all', agent: a, path }));
      }
    } else if (lo.startsWith('sitemap:')) {
      const sm = line.slice(8).trim();
      if (sm) rules.push({ type: 'sitemap', agent: '*', path: sm });
    }
  }
  return rules;
}

function highlightRobots(txt) {
  return txt
    .replace(/^(#.*)$/gm, '<span class="r-cmt">$1</span>')
    .replace(/^(User-agent:)(.*)$/gim, '<span class="r-ua">$1</span>$2')
    .replace(/^(Disallow:)(.*)$/gim, '<span class="r-dis">$1</span>$2')
    .replace(/^(Allow:)(.*)$/gim, '<span class="r-all">$1</span>$2')
    .replace(/^(Sitemap:)(.*)$/gim, '<span class="r-sm">$1</span>$2');
}

// ── URL NORMALIZATION (No double slashes, strips wildcard prefixes) ──
function normalizeBase(raw) {
  let u = (raw || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    return new URL(u).origin;
  } catch {
    return u.replace(/\/+$/, '');
  }
}

function resolveEndpointUrl(base, path) {
  const b = (base || '').replace(/\/+$/, '');
  let p = (path || '').trim();
  p = p.replace(/\$$/, '');
  p = p.replace(/^\/\*+\/?/, '/');
  p = p.replace(/^\/+/, '/');
  return b + p;
}

// ── PATRICK STOX STYLE RULE MATCHING ──
function robotsMatch(testPath, rulePath) {
  if (!rulePath) return false;
  if (rulePath === '/') return true;

  let pattern = rulePath
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  if (pattern.endsWith('\\$')) {
    pattern = pattern.slice(0, -2) + '$';
  } else {
    pattern = pattern + '.*';
  }

  const re = new RegExp('^' + pattern);
  return re.test(testPath);
}

function checkUrlAgainst(testPath, agentFilter = '*') {
  const normPath = testPath.startsWith('/') ? testPath : '/' + testPath;
  const targetAgent = (agentFilter || '*').toLowerCase();

  const dis = S.rules.filter(r => r.type === 'dis' && (r.agent === '*' || r.agent.toLowerCase() === targetAgent));
  const all = S.rules.filter(r => r.type === 'all' && (r.agent === '*' || r.agent.toLowerCase() === targetAgent));

  let bestDis = null;
  let bestAll = null;

  for (const r of dis) {
    if (robotsMatch(normPath, r.path)) {
      if (!bestDis || r.path.length > bestDis.path.length) bestDis = r;
    }
  }

  for (const r of all) {
    if (robotsMatch(normPath, r.path)) {
      if (!bestAll || r.path.length > bestAll.path.length) bestAll = r;
    }
  }

  if (!bestDis && !bestAll) {
    return { allowed: true, reason: 'Allowed (no matching Disallow rule found)' };
  }
  if (bestDis && !bestAll) {
    return { allowed: false, reason: `Blocked by Disallow: ${bestDis.path} (Agent: ${bestDis.agent})` };
  }
  if (!bestDis && bestAll) {
    return { allowed: true, reason: `Allowed by Allow: ${bestAll.path} (Agent: ${bestAll.agent})` };
  }

  if (bestAll.path.length > bestDis.path.length) {
    return { allowed: true, reason: `Allowed: Allow "${bestAll.path}" is longer than Disallow "${bestDis.path}"` };
  } else if (bestDis.path.length > bestAll.path.length) {
    return { allowed: false, reason: `Blocked: Disallow "${bestDis.path}" is longer than Allow "${bestAll.path}"` };
  } else {
    return { allowed: true, reason: `Allowed: Equal length rule match defaults to Allow` };
  }
}

// ── MAIN SCAN PIPELINE ──
async function go() {
  const inputEl = document.getElementById('inp');
  let raw = inputEl.value.trim();
  if (!raw) { toast('Please enter a target domain or URL', 'err'); return; }

  const base = normalizeBase(raw);
  S.base = base;
  S.raw = '';
  S.rules = [];
  S.sitemaps = [];
  S.extractedSitemapUrls = [];
  S.selected.clear();
  S.aborted = false;
  S.probeStatus = {};

  const btn = document.getElementById('scanBtn');
  btn.textContent = 'SCANNING...';
  btn.classList.add('active');

  show('statusBar');
  hide('results');
  clearLiveLog();
  logLive('Target normalized: ' + base);
  setStatus(`Fetching ${base}/robots.txt...`, 20);

  const robotsUrl = `${base}/robots.txt`;
  logLive('Requesting ' + robotsUrl + ' via parallel multi-tier proxies...');
  const res = await fetchText(robotsUrl);

  if (res.ok && res.text) {
    S.raw = res.text;
    S.rules = parseRobots(res.text);
    S.sitemaps = S.rules.filter(r => r.type === 'sitemap').map(r => r.path);

    const disCount = S.rules.filter(r => r.type === 'dis').length;
    const allCount = S.rules.filter(r => r.type === 'all').length;
    logLive(`✓ robots.txt parsed! Found ${disCount} Disallow rules, ${allCount} Allow rules, ${S.sitemaps.length} Sitemaps`);
    setStatus('Directives loaded. Checking sitemaps...', 55);
  } else {
    S.raw = '';
    logLive('⚠ Direct fetch failed. You can paste rules manually.');
    toast('robots.txt fetch failed. Try pasting directly if target has strong blocking.', 'warn');
  }

  // Ensure default sitemaps checked
  const defaultSMs = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
  for (const sm of defaultSMs) {
    const full = base + sm;
    if (!S.sitemaps.includes(full)) S.sitemaps.push(full);
  }

  setStatus('Recon ready! Crawling sitemap XML...', 80);
  renderAll();

  // Auto crawl sitemaps in background
  if (S.sitemaps.length) {
    logLive('Crawling XML sitemaps for page URLs in real time...');
    crawlAllSitemaps(true);
  } else {
    setStatus('Done!', 100);
    setTimeout(() => hide('statusBar'), 1200);
  }

  btn.textContent = 'FETCH & SCAN';
  btn.classList.remove('active');
}

function qs(d) {
  document.getElementById('inp').value = d;
  go();
}

// ── LIVE STREAMING LOG ──
function logLive(msg) {
  const feed = document.getElementById('liveFeedLog');
  if (!feed) return;
  const line = document.createElement('div');
  line.className = 'live-log-line';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
}

function clearLiveLog() {
  const feed = document.getElementById('liveFeedLog');
  if (feed) feed.innerHTML = '';
}

// ── MANUAL PASTE / EDIT ──
function toggleManualInput() {
  const mb = document.getElementById('manualBox');
  mb.classList.toggle('hidden');
  if (!mb.classList.contains('hidden')) {
    document.getElementById('manualTxt').focus();
    if (S.base && !document.getElementById('manualBase').value) {
      document.getElementById('manualBase').value = S.base;
    }
  }
}

function parseManual() {
  const txt = document.getElementById('manualTxt').value.trim();
  if (!txt) { toast('Please paste robots.txt content', 'err'); return; }

  let baseInput = document.getElementById('manualBase').value.trim() || 'https://target.local';
  S.base = normalizeBase(baseInput);

  S.raw = txt;
  S.rules = parseRobots(txt);
  S.sitemaps = S.rules.filter(r => r.type === 'sitemap').map(r => r.path);
  if (!S.sitemaps.length) S.sitemaps.push(S.base + '/sitemap.xml');
  S.selected.clear();
  S.extractedSitemapUrls = [];
  S.probeStatus = {};

  toggleManualInput();
  renderAll();
  toast('Custom robots.txt parsed successfully!', 'ok');
}

// ── IN-CARD LIVE EDITOR ──
function toggleEditMode() {
  S.isEditing = !S.isEditing;
  const pre = document.getElementById('rawPre');
  const editArea = document.getElementById('editArea');
  const btn = document.getElementById('editToggleBtn');

  if (S.isEditing) {
    document.getElementById('rawEditor').value = S.raw;
    pre.classList.add('hidden');
    editArea.classList.remove('hidden');
    btn.textContent = '👁️ View';
  } else {
    pre.classList.remove('hidden');
    editArea.classList.add('hidden');
    btn.textContent = '✏️ Edit';
  }
}

function applyEditorChanges() {
  const updated = document.getElementById('rawEditor').value;
  S.raw = updated;
  S.rules = parseRobots(updated);
  S.sitemaps = S.rules.filter(r => r.type === 'sitemap').map(r => r.path);
  toggleEditMode();
  renderAll();
  toast('Updated directives applied!', 'ok');
}

// ── RENDER ENGINE ──
function renderAll() {
  renderStats();
  renderRaw();
  renderSitemaps();
  renderCurrentList();
  populateAgentSelect();
  show('results');
}

function renderStats() {
  const dis = S.rules.filter(r => r.type === 'dis');
  const all = S.rules.filter(r => r.type === 'all');
  const agents = [...new Set(S.rules.map(r => r.agent))];

  document.getElementById('countDis').textContent = dis.length;
  document.getElementById('countAll').textContent = all.length;
  document.getElementById('countSm').textContent = S.extractedSitemapUrls.length;
  document.getElementById('countCombined').textContent = dis.length + all.length + S.extractedSitemapUrls.length;

  const data = [
    { n: dis.length, l: 'Disallowed Endpoints', c: '#ff4757' },
    { n: all.length, l: 'Allowed Endpoints', c: '#00f5a0' },
    { n: S.sitemaps.length, l: 'Sitemap Files', c: '#00d9f5' },
    { n: S.extractedSitemapUrls.length, l: 'Sitemap URLs', c: '#ff9ff3' },
    { n: agents.length, l: 'User Agents', c: '#ffd700' },
    { n: S.rules.length, l: 'Total Directives', c: '#7a9db0' },
  ];

  document.getElementById('statsRow').innerHTML = data.map((d, i) => `
    <div class="stat" style="--sc:${d.c};animation:fadeUp .4s ${i * 0.05}s ease backwards">
      <span class="stat-n">${d.n}</span>
      <span class="stat-l">${d.l}</span>
    </div>
  `).join('');

  if (!document.getElementById('fadeUpKF')) {
    const s = document.createElement('style');
    s.id = 'fadeUpKF';
    s.textContent = '@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }
}

function renderRaw() {
  const badge = document.getElementById('rawBadge');
  const pre = document.getElementById('rawPre');

  if (S.raw) {
    badge.textContent = 'ACTIVE';
    badge.style.cssText = 'background:rgba(0,245,160,.12);border-color:rgba(0,245,160,.3);color:#00f5a0';
    pre.innerHTML = highlightRobots(esc(S.raw));
  } else {
    badge.textContent = 'EMPTY / CORS';
    badge.style.cssText = 'background:rgba(255,71,87,.12);border-color:rgba(255,71,87,.3);color:#ff4757';
    pre.innerHTML = '<span class="muted">No robots.txt fetched. Click "Edit" or "Paste / Edit robots.txt" above.</span>';
  }
}

function renderSitemaps() {
  const list = document.getElementById('smList');
  const badge = document.getElementById('smBadge');
  badge.textContent = S.sitemaps.length + ' found';

  if (!S.sitemaps.length) {
    list.innerHTML = '<span class="muted">No sitemaps discovered</span>';
    return;
  }

  list.innerHTML = S.sitemaps.map(u => `
    <div class="url-row">
      <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>
      <span class="url-tag sitemap-tag">SITEMAP</span>
      <div class="dis-btns">
        <button class="dis-btn" onclick="window.open('${esc(u)}','_blank')" title="Open">&#x1F517;</button>
        <button class="dis-btn" onclick="copyT('${esc(u)}')" title="Copy URL">&#x1F4CB;</button>
      </div>
    </div>
  `).join('');
}

// ── RECURSIVE SITEMAP XML CRAWLER ──
async function crawlAllSitemaps(isAuto = false) {
  if (!S.sitemaps.length) return;
  const btn = document.getElementById('crawlSitemapBtn');
  if (btn) btn.textContent = 'Crawling...';
  if (!isAuto) toast('Crawling XML sitemaps for page URLs...', 'ok');

  const gathered = new Set();
  const subSitemaps = new Set();
  const baseHost = new URL(S.base).hostname;

  for (const smUrl of S.sitemaps.slice(0, 4)) {
    try {
      const res = await fetchText(smUrl);
      if (res.ok && res.text) {
        const rawUrls = res.text.match(/https?:\/\/[a-zA-Z0-9\.\-_/]+/g) || [];
        rawUrls.forEach(u => {
          if (u.includes(baseHost)) {
            if (u.endsWith('.xml')) subSitemaps.add(u);
            else if (!isStaticAsset(u)) gathered.add(u);
          }
        });
      }
    } catch (e) {}
  }

  // Crawl sub-sitemaps (e.g. blog-0.xml, static-0.xml)
  for (const sub of Array.from(subSitemaps).slice(0, 6)) {
    try {
      logLive('Crawling sub-sitemap: ' + sub);
      const res = await fetchText(sub);
      if (res.ok && res.text) {
        const rawUrls = res.text.match(/https?:\/\/[a-zA-Z0-9\.\-_/]+/g) || [];
        rawUrls.forEach(u => {
          if (u.includes(baseHost) && !u.endsWith('.xml') && !isStaticAsset(u)) {
            gathered.add(u);
          }
        });
      }
    } catch (e) {}
  }

  if (btn) btn.textContent = '⚡ Crawl XML URLs';
  S.extractedSitemapUrls = Array.from(gathered);
  logLive(`✓ Sitemap crawl finished: Extracted ${S.extractedSitemapUrls.length} page URLs`);
  setStatus('All URLs extracted!', 100);
  setTimeout(() => hide('statusBar'), 1500);

  renderStats();
  if (S.currentTab === 'sitemap' || S.currentTab === 'combined') {
    renderCurrentList();
  }

  if (S.extractedSitemapUrls.length) {
    toast(`Extracted ${S.extractedSitemapUrls.length} URLs from XML Sitemaps!`, 'ok');
  }
}

function isStaticAsset(url) {
  return /\.(svg|webp|png|jpg|jpeg|gif|css|js|ico|woff|woff2|ttf|eot)(\?.*)?$/i.test(url);
}

// ── TAB SWITCHING & LIST RENDERING ──
function switchTab(tabName) {
  S.currentTab = tabName;
  document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
  if (tabName === 'disallow') document.getElementById('tabDisallow').classList.add('active');
  if (tabName === 'allow') document.getElementById('tabAllow').classList.add('active');
  if (tabName === 'sitemap') document.getElementById('tabSitemap').classList.add('active');
  if (tabName === 'combined') document.getElementById('tabCombined').classList.add('active');

  S.selected.clear();
  renderCurrentList();
}

function getActiveListItems() {
  const query = (document.getElementById('urlFilterInput')?.value || '').trim().toLowerCase();

  let items = [];
  if (S.currentTab === 'disallow') {
    items = S.rules.filter(r => r.type === 'dis').map(r => ({
      type: 'disallow',
      path: r.path,
      agent: r.agent,
      fullUrl: resolveEndpointUrl(S.base, r.path)
    }));
  } else if (S.currentTab === 'allow') {
    items = S.rules.filter(r => r.type === 'all').map(r => ({
      type: 'allow',
      path: r.path,
      agent: r.agent,
      fullUrl: resolveEndpointUrl(S.base, r.path)
    }));
  } else if (S.currentTab === 'sitemap') {
    items = S.extractedSitemapUrls.map(u => ({
      type: 'sitemap',
      path: u.replace(S.base, '') || '/',
      agent: '*',
      fullUrl: u
    }));
  } else if (S.currentTab === 'combined') {
    const dis = S.rules.filter(r => r.type === 'dis').map(r => ({
      type: 'disallow', path: r.path, agent: r.agent, fullUrl: resolveEndpointUrl(S.base, r.path)
    }));
    const all = S.rules.filter(r => r.type === 'all').map(r => ({
      type: 'allow', path: r.path, agent: r.agent, fullUrl: resolveEndpointUrl(S.base, r.path)
    }));
    const sm = S.extractedSitemapUrls.map(u => ({
      type: 'sitemap', path: u.replace(S.base, '') || '/', agent: '*', fullUrl: u
    }));
    items = [...dis, ...all, ...sm];
  }

  if (query) {
    items = items.filter(it => it.fullUrl.toLowerCase().includes(query) || it.path.toLowerCase().includes(query));
  }

  return items;
}

function renderCurrentList() {
  const listEl = document.getElementById('endpointsList');
  const countBadge = document.getElementById('activeCountBadge');
  const items = getActiveListItems();

  countBadge.textContent = items.length + ' URLs';
  if (S.currentTab === 'disallow') countBadge.className = 'badge-pill red-pill';
  else if (S.currentTab === 'allow') countBadge.className = 'badge-pill green-pill';
  else if (S.currentTab === 'sitemap') countBadge.className = 'badge-pill cyan-pill';
  else countBadge.className = 'badge-pill purple-pill';

  if (!items.length) {
    listEl.innerHTML = '<span class="muted">No endpoints found in this category.</span>';
    document.getElementById('batchBar').classList.add('hidden');
    return;
  }

  // Display items (slice up to 100 for instant UI rendering)
  const displaySlice = items.slice(0, 100);
  listEl.innerHTML = displaySlice.map((it, i) => {
    const sel = S.selected.has(it.fullUrl);
    const probe = S.probeStatus[it.fullUrl];

    let probeBadge = '';
    if (probe === 200 || probe === 'live') {
      probeBadge = '<span class="probe-tag probe-live">200 OK</span>';
    } else if (probe && probe !== 'err') {
      probeBadge = `<span class="probe-tag probe-info">${probe}</span>`;
    } else if (probe === 'err') {
      probeBadge = '<span class="probe-tag probe-err">ERR</span>';
    }

    let typeTag = '';
    if (it.type === 'disallow') typeTag = '<span class="cat-pill c-dis">DISALLOW</span>';
    else if (it.type === 'allow') typeTag = '<span class="cat-pill c-all">ALLOW</span>';
    else typeTag = '<span class="cat-pill c-sm">SITEMAP</span>';

    return `
      <div class="dis-item${sel ? ' selected' : ''}" data-url="${esc(it.fullUrl)}" style="animation:fadeUp .2s ${Math.min(i * 0.01, 0.3)}s ease backwards" onclick="toggleItemSel('${esc(it.fullUrl)}',event)">
        <div class="dis-chk${sel ? ' checked' : ''}" onclick="toggleItemSel('${esc(it.fullUrl)}',event)"></div>
        <div class="dis-info">
          <div class="dis-rule-line">
            ${typeTag}
            <span class="dis-path">${esc(it.path)}</span>
            <span class="dis-agent">${esc(it.agent)}</span>
            ${probeBadge}
          </div>
          <div class="dis-full-url" title="Full Target URL">${esc(it.fullUrl)}</div>
        </div>
        <div class="dis-btns">
          <button class="dis-btn" onclick="event.stopPropagation();probeUrl('${esc(it.fullUrl)}')" title="Probe Status">⚡</button>
          <button class="dis-btn" onclick="event.stopPropagation();window.open('${esc(it.fullUrl)}','_blank')" title="Open in new tab">&#x1F517;</button>
          <button class="dis-btn" onclick="event.stopPropagation();copyT('${esc(it.fullUrl)}')" title="Copy URL">&#x1F4CB;</button>
        </div>
      </div>
    `;
  }).join('') + (items.length > 100 ? `<div style="text-align:center;padding:12px;font-family:var(--mono);font-size:12px;color:var(--txt3);">Showing first 100 of ${items.length} URLs (filter above to narrow down)</div>` : '');

  document.getElementById('batchBar').classList.remove('hidden');
  updateSelCount();
}

function toggleItemSel(url, e) {
  if (e.target.classList.contains('dis-btn')) return;
  if (S.selected.has(url)) S.selected.delete(url);
  else S.selected.add(url);
  renderCurrentList();
}

function updateSelCount() {
  document.getElementById('selCount').textContent = S.selected.size + ' selected';
}

function selectAllUrls() {
  const items = getActiveListItems();
  items.forEach(it => S.selected.add(it.fullUrl));
  renderCurrentList();
}

function clearSelUrls() {
  S.selected.clear();
  renderCurrentList();
}

function getDelay() {
  const sel = document.getElementById('tabDelay');
  return parseInt(sel ? sel.value : '120', 10);
}

// ── 1-CLICK TAB OPENERS ──
function openAllActiveTab() {
  const items = getActiveListItems();
  const urls = [...new Set(items.map(it => it.fullUrl))];
  if (!urls.length) { toast('No URLs in current category to open', 'warn'); return; }

  const limit = Math.min(urls.length, 30);
  if (!confirm(`Open ${limit} tabs in your browser?`)) return;

  const delay = getDelay();
  urls.slice(0, limit).forEach((u, i) => {
    setTimeout(() => window.open(u, '_blank'), i * delay);
  });
  toast(`Opening ${limit} tabs!`, 'ok');
}

function openSelectedUrls() {
  if (!S.selected.size) { toast('No URLs selected', 'warn'); return; }
  const urls = Array.from(S.selected);
  const limit = Math.min(urls.length, 30);
  if (!confirm(`Open ${limit} selected tabs?`)) return;

  const delay = getDelay();
  urls.slice(0, limit).forEach((u, i) => {
    setTimeout(() => window.open(u, '_blank'), i * delay);
  });
  toast(`Opening ${limit} selected tabs!`, 'ok');
}

function openAllSitemaps() {
  if (!S.sitemaps.length) { toast('No sitemaps found', 'warn'); return; }
  const delay = getDelay();
  S.sitemaps.forEach((u, i) => {
    setTimeout(() => window.open(u, '_blank'), i * delay);
  });
  toast(`Opening ${S.sitemaps.length} sitemaps!`, 'ok');
}

function copyActiveTab() {
  const items = getActiveListItems();
  const urls = [...new Set(items.map(it => it.fullUrl))];
  if (!urls.length) { toast('No URLs to copy', 'warn'); return; }
  navigator.clipboard.writeText(urls.join('\n')).then(() => {
    toast(`Copied ${urls.length} URLs!`, 'ok');
  });
}

// ── HIGH-RELIABILITY LIVE STATUS PROBER ──
async function probeUrl(url) {
  toast(`Probing ${url}...`, 'ok');
  try {
    const r = await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(3000) });
    S.probeStatus[url] = 'live';
  } catch (e) {
    try {
      const pr = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(4000) });
      if (pr.ok) S.probeStatus[url] = 200;
      else S.probeStatus[url] = pr.status;
    } catch {
      S.probeStatus[url] = 'err';
    }
  }
  renderCurrentList();
}

async function probeActiveTab() {
  const items = getActiveListItems();
  const urls = [...new Set(items.map(it => it.fullUrl))].slice(0, 30);
  if (!urls.length) return;

  const btn = document.getElementById('probeActiveBtn');
  btn.textContent = 'Probing...';
  toast(`Probing first ${urls.length} endpoints...`, 'ok');

  for (const u of urls) {
    try {
      await fetch(u, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
      S.probeStatus[u] = 'live';
    } catch {
      S.probeStatus[u] = 'err';
    }
    renderCurrentList();
  }

  btn.textContent = '⚡ Probe Live Status';
  toast('Probing complete!', 'ok');
}

async function probeSelectedUrls() {
  if (!S.selected.size) return;
  const urls = Array.from(S.selected);
  toast(`Probing ${urls.length} selected endpoints...`, 'ok');
  for (const u of urls) {
    try {
      await fetch(u, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
      S.probeStatus[u] = 'live';
    } catch {
      S.probeStatus[u] = 'err';
    }
    renderCurrentList();
  }
  toast('Selected endpoints probed!', 'ok');
}

// ── PATRICK STOX STYLE RULE TESTER ──
function populateAgentSelect() {
  const sel = document.getElementById('testAgent');
  const current = sel.value;
  const agents = ['*', ...new Set(S.rules.map(r => r.agent).filter(a => a !== '*'))];

  sel.innerHTML = agents.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  if (agents.includes(current)) sel.value = current;
}

function testUrl() {
  const input = document.getElementById('testUrl');
  let path = input.value.trim();
  if (!path) { toast('Enter a path to test', 'warn'); return; }

  if (/^https?:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch {}
  }

  const agent = document.getElementById('testAgent').value;
  const result = checkUrlAgainst(path, agent);

  const el = document.getElementById('testResult');
  el.className = 'test-result ' + (result.allowed ? 'allowed' : 'blocked');
  el.innerHTML = `
    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">
      ${result.allowed ? '✅ ALLOWED (Crawlable)' : '🚫 BLOCKED (Disallowed)'}
    </div>
    <div style="font-size:12px;opacity:.9;"><b>Target:</b> <code>${esc(path)}</code> | <b>Agent:</b> <code>${esc(agent)}</code></div>
    <div style="font-size:11.5px;opacity:.8;margin-top:4px;">${esc(result.reason)}</div>
  `;
  el.classList.remove('hidden');
}

function toggleBatchTest() {
  const single = document.getElementById('singleTestBox');
  const batch = document.getElementById('batchTestBox');
  const btn = document.getElementById('batchTestToggle');

  if (batch.classList.contains('hidden')) {
    batch.classList.remove('hidden');
    single.classList.add('hidden');
    btn.textContent = 'Switch to Single URL Test';
  } else {
    batch.classList.add('hidden');
    single.classList.remove('hidden');
    btn.textContent = 'Toggle Batch URL Test';
  }
}

function testBatchUrls() {
  const text = document.getElementById('batchUrls').value.trim();
  if (!text) { toast('Paste URLs or paths into the box', 'warn'); return; }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const agent = document.getElementById('testAgent').value || '*';

  S.batchResults = lines.map(line => {
    let p = line;
    let full = line;
    if (/^https?:\/\//i.test(line)) {
      try {
        const u = new URL(line);
        p = u.pathname;
        full = line;
      } catch {}
    } else {
      if (!p.startsWith('/')) p = '/' + p;
      full = resolveEndpointUrl(S.base, p);
    }
    const res = checkUrlAgainst(p, agent);
    return { path: p, full, allowed: res.allowed, reason: res.reason };
  });

  renderBatchResults();
}

function renderBatchResults() {
  const table = document.getElementById('batchResultsTable');
  const allowed = S.batchResults.filter(r => r.allowed);
  const blocked = S.batchResults.filter(r => !r.allowed);

  table.classList.remove('hidden');
  table.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;font-family:var(--mono);font-size:12px;">
      <span style="color:#00f5a0">Allowed: <b>${allowed.length}</b></span>
      <span style="color:#ff4757">Blocked: <b>${blocked.length}</b></span>
      <span style="color:var(--txt2)">Total: <b>${S.batchResults.length}</b></span>
    </div>
    <div class="batch-results-list">
      ${S.batchResults.map(r => `
        <div class="batch-res-row ${r.allowed ? 'b-allowed' : 'b-blocked'}">
          <span class="b-badge">${r.allowed ? 'ALLOWED' : 'BLOCKED'}</span>
          <span class="b-path" title="${esc(r.full)}">${esc(r.path)}</span>
          <span class="b-reason">${esc(r.reason)}</span>
          <button class="dis-btn" onclick="window.open('${esc(r.full)}','_blank')" title="Open">&#x1F517;</button>
        </div>
      `).join('')}
    </div>
  `;

  document.getElementById('openAllowedBtn').style.display = allowed.length ? 'inline-block' : 'none';
  document.getElementById('openBlockedBtn').style.display = blocked.length ? 'inline-block' : 'none';
}

function openAllowedBatch() {
  const allowed = S.batchResults.filter(r => r.allowed).map(r => r.full);
  const delay = getDelay();
  allowed.forEach((u, i) => setTimeout(() => window.open(u, '_blank'), i * delay));
  toast(`Opening ${allowed.length} Allowed URLs!`, 'ok');
}

function openBlockedBatch() {
  const blocked = S.batchResults.filter(r => !r.allowed).map(r => r.full);
  const delay = getDelay();
  blocked.forEach((u, i) => setTimeout(() => window.open(u, '_blank'), i * delay));
  toast(`Opening ${blocked.length} Blocked URLs!`, 'ok');
}

// ── EXPORT ENGINE ──
function expJSON() {
  const d = {
    target: S.base,
    scannedAt: new Date().toISOString(),
    robotsTxt: { raw: S.raw },
    rules: S.rules,
    sitemaps: S.sitemaps,
    extractedSitemapUrls: S.extractedSitemapUrls
  };
  dl('robotscheck.json', JSON.stringify(d, null, 2), 'application/json');
}

function expMD() {
  const dis = S.rules.filter(r => r.type === 'dis');
  const all = S.rules.filter(r => r.type === 'all');
  let md = `# RobotsCheck Recon Report: ${S.base}\n\n*Timestamp: ${new Date().toLocaleString()}*\n\n## Disallowed Endpoints (${dis.length})\n\n`;
  dis.forEach(d => {
    const full = resolveEndpointUrl(S.base, d.path);
    md += `- \`${d.path}\` (Agent: \`${d.agent}\`) → [${full}](${full})\n`;
  });
  md += `\n## Allowed Endpoints (${all.length})\n\n`;
  all.forEach(a => {
    const full = resolveEndpointUrl(S.base, a.path);
    md += `- \`${a.path}\` (Agent: \`${a.agent}\`) → [${full}](${full})\n`;
  });
  md += `\n## Sitemaps (${S.sitemaps.length})\n\n`;
  S.sitemaps.forEach(u => md += `- [${u}](${u})\n`);
  md += `\n## Sitemap Extracted URLs (${S.extractedSitemapUrls.length})\n\n`;
  S.extractedSitemapUrls.slice(0, 100).forEach(u => md += `- [${u}](${u})\n`);
  dl('robotscheck.md', md, 'text/markdown');
}

function expCSV() {
  let c = 'type,agent,path,full_url\n';
  S.rules.forEach(r => {
    const full = r.type === 'sitemap' ? r.path : resolveEndpointUrl(S.base, r.path);
    c += `${r.type},"${r.agent}","${r.path}","${full}"\n`;
  });
  S.extractedSitemapUrls.forEach(u => {
    c += `sitemap_url,"*",,"${u}"\n`;
  });
  dl('robotscheck.csv', c, 'text/csv');
}

function expTXT() {
  let t = `# RobotsCheck Recon — ${S.base}\n# Disallowed Endpoints:\n`;
  S.rules.filter(r => r.type === 'dis').forEach(d => t += resolveEndpointUrl(S.base, d.path) + '\n');
  t += `\n# Allowed Endpoints:\n`;
  S.rules.filter(r => r.type === 'all').forEach(a => t += resolveEndpointUrl(S.base, a.path) + '\n');
  t += `\n# Sitemap URLs (${S.extractedSitemapUrls.length}):\n`;
  S.extractedSitemapUrls.forEach(u => t += u + '\n');
  dl('robotscheck.txt', t, 'text/plain');
}

function dl(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  toast('Report saved: ' + name, 'ok');
}

// ── UTILITIES ──
function setStatus(msg, pct) {
  document.getElementById('statusMsg').textContent = msg;
  document.getElementById('prog').style.width = pct + '%';
  document.getElementById('progPct').textContent = pct + '%';
}

function toggleCard(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function resetUI() {
  hide('results');
  hide('statusBar');
  document.getElementById('inp').value = '';
  document.getElementById('scanBtn').textContent = 'FETCH & SCAN';
  document.getElementById('scanBtn').classList.remove('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyEl(id) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.innerText || el.textContent).then(() => toast('Copied to clipboard!', 'ok'));
}

function copyT(t) {
  navigator.clipboard.writeText(t).then(() => toast('Copied URL!', 'ok'));
}

function toast(msg, type = 'ok') {
  const c = document.getElementById('toast');
  const d = document.createElement('div');
  d.className = 'toast-item';
  const ico = { ok: '✓', err: '✗', warn: '!' };
  d.textContent = (ico[type] || '•') + ' ' + msg;
  if (type === 'err') d.style.borderColor = 'rgba(255,71,87,.5)';
  if (type === 'warn') d.style.borderColor = 'rgba(255,165,0,.5)';
  c.appendChild(d);
  setTimeout(() => {
    d.style.opacity = '0';
    d.style.transition = 'opacity .3s';
    setTimeout(() => d.remove(), 300);
  }, 3200);
}

// ── 3D CANVAS BACKGROUND ──
(function() {
  const cv = document.getElementById('bg');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  let W, H, nodes = [];

  function rsz() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
  function init() {
    nodes = [];
    const n = Math.min(65, Math.floor(W * H / 13000));
    for (let i = 0; i < n; i++) {
      nodes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.8 + 0.8,
        c: Math.random() > 0.55 ? '#00f5a0' : Math.random() > 0.5 ? '#00d9f5' : '#ffffff',
        a: Math.random() * 0.5 + 0.1
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y, d = Math.hypot(dx, dy);
        if (d < 130) {
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `rgba(0,245,160,${(1 - d / 130) * 0.1})`;
          ctx.lineWidth = 0.4;
          ctx.stroke();
        }
      }
    }
    nodes.forEach(n => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, 6.28);
      ctx.fillStyle = n.c;
      ctx.globalAlpha = n.a;
      ctx.fill();
      ctx.globalAlpha = 1;
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
    });
    requestAnimationFrame(draw);
  }

  rsz(); init(); draw();
  window.addEventListener('resize', () => { rsz(); init(); });
})();

// ── 3D HOLOGRAPHIC SPHERE ──
(function() {
  const cv = document.getElementById('sphere');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = 420, H = 420, cx = W / 2, cy = H / 2, R = 155;
  cv.width = W; cv.height = H;

  const N = 240;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const phi = Math.acos(-1 + (2 * i) / N);
    const th = Math.sqrt(N * Math.PI) * phi;
    pts.push({ phi, th });
  }

  let ang = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ang += 0.004;
    const cos = Math.cos(ang), sin = Math.sin(ang);

    const proj = pts.map(p => {
      const x0 = R * Math.sin(p.phi) * Math.cos(p.th);
      const y0 = R * Math.sin(p.phi) * Math.sin(p.th);
      const z0 = R * Math.cos(p.phi);
      const x1 = x0 * cos - z0 * sin;
      const z1 = x0 * sin + z0 * cos;
      const fov = 500, sc = fov / (fov + z1);
      return { px: cx + x1 * sc, py: cy + y0 * sc, z: z1, sc };
    }).sort((a, b) => a.z - b.z);

    const g = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 1.3);
    g.addColorStop(0, 'rgba(0,245,160,0.06)');
    g.addColorStop(1, 'rgba(0,245,160,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.3, 0, 6.28);
    ctx.fillStyle = g;
    ctx.fill();

    proj.forEach(p => {
      const dep = (p.z + R) / (2 * R);
      ctx.beginPath();
      ctx.arc(p.px, p.py, dep * 2.2 + 0.4, 0, 6.28);
      ctx.fillStyle = dep > 0.5 ? '#00f5a0' : '#00d9f5';
      ctx.globalAlpha = dep * 0.75 + 0.05;
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * Math.abs(Math.sin(ang * 0.25 + 0.8)), 0, 0, 6.28);
    ctx.strokeStyle = 'rgba(0,245,160,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    requestAnimationFrame(draw);
  }
  draw();
})();
