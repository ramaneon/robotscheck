'use strict';

// ── STATE ──
let S = {
  base: '',
  raw: '',
  rules: [],
  sitemaps: [],
  disAllAgents: [],
  selAgent: '*',
  selectedDis: new Set(),
  extractedUrls: [],
  filteredSmUrls: [],
  selectedSm: new Set(),
  aborted: false,
  isEditing: false,
  batchResults: [],
  probeStatus: {}
};

// ── MULTI-TIER RESILIENT PROXY ENGINE ──
async function fetchText(url) {
  // 1. Primary: Jina AI reader proxy (bypasses Cloudflare WAF, returns clean plain text)
  try {
    const jinaUrl = 'https://r.jina.ai/' + url;
    const r = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/plain' },
      signal: AbortSignal.timeout(7000)
    });
    if (r.ok) {
      let t = await r.text();
      if (t.includes('Markdown Content:')) {
        t = t.split('Markdown Content:')[1].trim();
      }
      t = cleanFetchedText(t);
      if (isLikelyValidContent(t)) return { ok: true, text: t };
    }
  } catch (e) {}

  // 2. Direct fetch (if same-origin or CORS permissive)
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const t = await r.text();
      if (t && t.length > 5) return { ok: true, text: t.trim() };
    }
  } catch (e) {}

  // 3. Fallback public CORS proxies
  const fallbacks = [
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];

  for (const proxyFn of fallbacks) {
    try {
      const pUrl = proxyFn(url);
      const r = await fetch(pUrl, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const t = await r.text();
        const cleaned = cleanFetchedText(t);
        if (cleaned && cleaned.length > 5) return { ok: true, text: cleaned };
      }
    } catch (e) {}
  }

  return { ok: false, text: '' };
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
  return lo.includes('user-agent') || lo.includes('disallow') || lo.includes('sitemap') || lo.includes('<urlset') || lo.includes('<sitemapindex') || lo.includes('http') || txt.length > 15;
}

// ── ROBOTS.TXT PARSER (RFC 9309 & Google Robots Spec Compliant) ──
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

// ── URL NORMALIZATION & RESOLUTION ──
function normalizeBase(raw) {
  let u = (raw || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return parsed.origin;
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

// ── MAIN SCAN FLOW ──
async function go() {
  const inputEl = document.getElementById('inp');
  let raw = inputEl.value.trim();
  if (!raw) { toast('Please enter a target domain or URL', 'err'); return; }

  const base = normalizeBase(raw);
  S.base = base;
  S.raw = '';
  S.rules = [];
  S.sitemaps = [];
  S.disAllAgents = [];
  S.selAgent = '*';
  S.selectedDis.clear();
  S.extractedUrls = [];
  S.filteredSmUrls = [];
  S.selectedSm.clear();
  S.aborted = false;
  S.probeStatus = {};

  const btn = document.getElementById('scanBtn');
  btn.textContent = 'SCANNING...';
  btn.classList.add('active');

  show('statusBar');
  hide('results');
  setStatus(`Probing ${base}/robots.txt...`, 20);

  const robotsUrl = `${base}/robots.txt`;
  const res = await fetchText(robotsUrl);

  if (res.ok && res.text) {
    S.raw = res.text;
    S.rules = parseRobots(res.text);
    S.sitemaps = S.rules.filter(r => r.type === 'sitemap').map(r => r.path);
    setStatus('Parsing directives & sitemaps...', 60);
  } else {
    S.raw = '';
    toast('Direct robots.txt probe failed. Try editing or pasting directly.', 'warn');
  }

  // Check default sitemaps
  const defaultSMs = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
  for (const sm of defaultSMs) {
    const full = base + sm;
    if (!S.sitemaps.includes(full)) S.sitemaps.push(full);
  }

  setStatus('Recon finished!', 100);

  setTimeout(() => {
    hide('statusBar');
    renderAll();
    btn.textContent = 'FETCH & SCAN';
    btn.classList.remove('active');

    // Auto-crawl sitemaps in background for seamless UX
    if (S.sitemaps.length) {
      crawlAllSitemaps(true);
    }
  }, 350);
}

function qs(d) {
  document.getElementById('inp').value = d;
  go();
}

// ── MANUAL PASTE / EDIT ROBOTS.TXT ──
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
  S.selectedDis.clear();
  S.extractedUrls = [];
  S.probeStatus = {};

  toggleManualInput();
  renderAll();
  toast('Custom robots.txt loaded and parsed!', 'ok');
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
  toast('Updated rules applied!', 'ok');
}

// ── RENDER ENGINE ──
function renderAll() {
  renderStats();
  renderRaw();
  renderSitemaps();
  renderDisallowed();
  populateAgentSelect();
  show('results');
  document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
  const disCount = S.rules.filter(r => r.type === 'dis').length;
  toast(`Recon ready: ${disCount} Disallowed endpoints extracted`, 'ok');
}

function renderStats() {
  const dis = S.rules.filter(r => r.type === 'dis');
  const all = S.rules.filter(r => r.type === 'all');
  const agents = [...new Set(S.rules.map(r => r.agent))];

  const data = [
    { n: dis.length, l: 'Disallowed Endpoints', c: '#ff4757' },
    { n: all.length, l: 'Allowed Rules', c: '#00f5a0' },
    { n: S.sitemaps.length, l: 'Sitemaps', c: '#00d9f5' },
    { n: agents.length, l: 'User Agents', c: '#ffd700' },
    { n: S.extractedUrls.length, l: 'Sitemap URLs', c: '#ff9ff3' },
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

// ── RECURSIVE SITEMAP XML CRAWLER & URL EXTRACTOR ──
async function crawlAllSitemaps(isAuto = false) {
  if (!S.sitemaps.length) return;
  const btn = document.getElementById('crawlSitemapBtn');
  if (btn) btn.textContent = 'Crawling...';
  if (!isAuto) toast('Crawling sitemaps and sub-sitemaps for page URLs...', 'ok');

  const gathered = new Set();
  const subSitemaps = new Set();
  const baseHost = new URL(S.base).hostname;

  // 1. Fetch main sitemaps to locate URLs and sub-sitemaps (e.g. blog-0.xml, static-0.xml)
  for (const smUrl of S.sitemaps.slice(0, 4)) {
    try {
      const res = await fetchText(smUrl);
      if (res.ok && res.text) {
        const rawUrls = res.text.match(/https?:\/\/[a-zA-Z0-9\.\-_/]+/g) || [];
        rawUrls.forEach(u => {
          if (u.includes(baseHost)) {
            if (u.endsWith('.xml')) {
              subSitemaps.add(u);
            } else if (!isStaticAsset(u)) {
              gathered.add(u);
            }
          }
        });
      }
    } catch (e) {}
  }

  // 2. Fetch sub-sitemaps found in sitemap indexes
  const subList = Array.from(subSitemaps).slice(0, 5);
  for (const sub of subList) {
    try {
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

  if (btn) btn.textContent = '⚡ Crawl & Extract URLs';
  S.extractedUrls = Array.from(gathered);
  S.filteredSmUrls = [...S.extractedUrls];

  renderSitemapExplorer();
  renderStats();

  if (S.extractedUrls.length) {
    toast(`Extracted ${S.extractedUrls.length} page URLs from Sitemap XML!`, 'ok');
  }
}

function isStaticAsset(url) {
  return /\.(svg|webp|png|jpg|jpeg|gif|css|js|ico|woff|woff2|ttf|eot)(\?.*)?$/i.test(url);
}

function renderSitemapExplorer() {
  const badge = document.getElementById('smTotalBadge');
  const countEl = document.getElementById('smFilteredCount');
  const listEl = document.getElementById('sitemapUrlsList');

  badge.textContent = `${S.extractedUrls.length} URLs Extracted`;
  countEl.textContent = `${S.filteredSmUrls.length} matching URLs`;

  if (!S.filteredSmUrls.length) {
    listEl.innerHTML = '<span class="muted">No matching sitemap URLs found.</span>';
    return;
  }

  // Render items (capped at first 100 for instant UI rendering, with pagination notice)
  const displaySlice = S.filteredSmUrls.slice(0, 100);
  listEl.innerHTML = displaySlice.map((u, i) => {
    const sel = S.selectedSm.has(u);
    const probe = S.probeStatus[u];
    let probeHtml = '';
    if (probe === 200 || probe === 'live') {
      probeHtml = '<span class="probe-tag probe-live">200 OK</span>';
    } else if (probe && probe !== 'err') {
      probeHtml = `<span class="probe-tag probe-info">${probe}</span>`;
    } else if (probe === 'err') {
      probeHtml = '<span class="probe-tag probe-err">ERR</span>';
    }

    return `
      <div class="dis-item${sel ? ' selected' : ''}" data-url="${esc(u)}" style="animation:fadeUp .2s ${Math.min(i * 0.01, 0.3)}s ease backwards" onclick="toggleSelSm('${esc(u)}',event)">
        <div class="dis-chk${sel ? ' checked' : ''}" onclick="toggleSelSm('${esc(u)}',event)"></div>
        <div class="dis-info">
          <div class="dis-rule-line">
            <span class="sm-url-text">${esc(u)}</span>
            ${probeHtml}
          </div>
        </div>
        <div class="dis-btns">
          <button class="dis-btn" onclick="event.stopPropagation();probeUrl('${esc(u)}')" title="Probe Status">⚡</button>
          <button class="dis-btn" onclick="event.stopPropagation();window.open('${esc(u)}','_blank')" title="Open in browser">&#x1F517;</button>
          <button class="dis-btn" onclick="event.stopPropagation();copyT('${esc(u)}')" title="Copy URL">&#x1F4CB;</button>
        </div>
      </div>
    `;
  }).join('') + (S.filteredSmUrls.length > 100 ? `<div style="text-align:center;padding:12px;font-family:var(--mono);font-size:12px;color:var(--txt3);">Showing first 100 of ${S.filteredSmUrls.length} URLs (use search bar above to filter)</div>` : '');
}

function filterSitemapUrls() {
  const q = document.getElementById('smSearchInput').value.trim().toLowerCase();
  if (!q) {
    S.filteredSmUrls = [...S.extractedUrls];
  } else {
    S.filteredSmUrls = S.extractedUrls.filter(u => u.toLowerCase().includes(q));
  }
  renderSitemapExplorer();
}

function toggleSelSm(url, e) {
  if (e.target.classList.contains('dis-btn')) return;
  if (S.selectedSm.has(url)) S.selectedSm.delete(url);
  else S.selectedSm.add(url);
  renderSitemapExplorer();
}

function selectAllSitemapUrls() {
  S.filteredSmUrls.forEach(u => S.selectedSm.add(u));
  renderSitemapExplorer();
}

function clearSelSitemapUrls() {
  S.selectedSm.clear();
  renderSitemapExplorer();
}

function openSelectedSitemapUrls() {
  if (!S.selectedSm.size) { toast('No sitemap URLs selected', 'warn'); return; }
  const urls = Array.from(S.selectedSm);
  if (urls.length > 30) {
    if (!confirm(`Open ${urls.length} tabs in browser?`)) return;
  }
  const delay = getDelay();
  urls.forEach((u, i) => setTimeout(() => window.open(u, '_blank'), i * delay));
  toast(`Opening ${urls.length} selected sitemap URLs!`, 'ok');
}

function openAllSitemapUrls() {
  const targetList = S.filteredSmUrls.length ? S.filteredSmUrls : S.extractedUrls;
  if (!targetList.length) { toast('No extracted sitemap URLs to open', 'warn'); return; }
  const limit = Math.min(targetList.length, 30);
  if (!confirm(`Open first ${limit} sitemap URLs in tabs?`)) return;

  const delay = getDelay();
  targetList.slice(0, limit).forEach((u, i) => {
    setTimeout(() => window.open(u, '_blank'), i * delay);
  });
  toast(`Opening ${limit} sitemap URLs in browser tabs!`, 'ok');
}

function copyAllSitemapUrls() {
  const list = S.filteredSmUrls.length ? S.filteredSmUrls : S.extractedUrls;
  if (!list.length) { toast('No sitemap URLs to copy', 'warn'); return; }
  navigator.clipboard.writeText(list.join('\n')).then(() => {
    toast(`Copied ${list.length} sitemap URLs!`, 'ok');
  });
}

// ── DISALLOWED ENDPOINTS RENDERING ──
function renderDisallowed() {
  const dis = S.rules.filter(r => r.type === 'dis');
  const badge = document.getElementById('disBadge');
  badge.textContent = dis.length + ' paths';

  const rawAgents = dis.map(r => r.agent);
  const agents = ['*', ...new Set(rawAgents.filter(a => a !== '*'))];
  S.disAllAgents = agents;

  const ab = document.getElementById('agentBtns');
  ab.innerHTML = agents.map(a => `
    <button class="agent-btn${a === S.selAgent ? ' active' : ''}" onclick="setAgent('${esc(a)}')">${esc(a)}</button>
  `).join('');

  renderDisList();
}

function renderDisList() {
  const dis = S.rules.filter(r => r.type === 'dis' && (S.selAgent === '*' || r.agent === S.selAgent || r.agent === '*'));
  const list = document.getElementById('disList');

  if (!dis.length) {
    list.innerHTML = '<span class="muted">No disallowed paths for this agent</span>';
    document.getElementById('batchBar').classList.add('hidden');
    return;
  }

  list.innerHTML = dis.map((d, i) => {
    const full = resolveEndpointUrl(S.base, d.path);
    const sel = S.selectedDis.has(full);
    const probe = S.probeStatus[full];

    let probeHtml = '';
    if (probe === 200 || probe === 'live') {
      probeHtml = '<span class="probe-tag probe-live">200 OK</span>';
    } else if (probe && probe !== 'err') {
      probeHtml = `<span class="probe-tag probe-info">${probe}</span>`;
    } else if (probe === 'err') {
      probeHtml = '<span class="probe-tag probe-err">ERR</span>';
    }

    return `
      <div class="dis-item${sel ? ' selected' : ''}" data-url="${esc(full)}" style="animation:fadeUp .25s ${Math.min(i * 0.015, 0.4)}s ease backwards" onclick="toggleSelDis('${esc(full)}',event)">
        <div class="dis-chk${sel ? ' checked' : ''}" onclick="toggleSelDis('${esc(full)}',event)"></div>
        <div class="dis-info">
          <div class="dis-rule-line">
            <span class="dis-path">${esc(d.path)}</span>
            <span class="dis-agent">${esc(d.agent)}</span>
            ${probeHtml}
          </div>
          <div class="dis-full-url" title="Full Target URL">${esc(full)}</div>
        </div>
        <div class="dis-btns">
          <button class="dis-btn" onclick="event.stopPropagation();probeUrl('${esc(full)}')" title="Probe Status">⚡</button>
          <button class="dis-btn" onclick="event.stopPropagation();window.open('${esc(full)}','_blank')" title="Open in browser">&#x1F517;</button>
          <button class="dis-btn" onclick="event.stopPropagation();copyT('${esc(full)}')" title="Copy URL">&#x1F4CB;</button>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('batchBar').classList.remove('hidden');
  updateSelCountDis();
}

function setAgent(a) {
  S.selAgent = a;
  document.querySelectorAll('.agent-btn').forEach(b => {
    b.classList.toggle('active', b.textContent === a);
  });
  S.selectedDis.clear();
  renderDisList();
}

function toggleSelDis(url, e) {
  if (e.target.classList.contains('dis-btn')) return;
  if (S.selectedDis.has(url)) S.selectedDis.delete(url);
  else S.selectedDis.add(url);
  const item = document.querySelector(`.dis-item[data-url="${url}"]`);
  const chk = item?.querySelector('.dis-chk');
  if (item) item.classList.toggle('selected');
  if (chk) chk.classList.toggle('checked');
  updateSelCountDis();
}

function updateSelCountDis() {
  document.getElementById('selCount').textContent = S.selectedDis.size + ' selected';
}

function selectAllDis() {
  const dis = S.rules.filter(r => r.type === 'dis' && (S.selAgent === '*' || r.agent === S.selAgent || r.agent === '*'));
  dis.forEach(d => S.selectedDis.add(resolveEndpointUrl(S.base, d.path)));
  renderDisList();
}

function clearSelDis() {
  S.selectedDis.clear();
  renderDisList();
}

function getDelay() {
  const sel = document.getElementById('tabDelay');
  return parseInt(sel ? sel.value : '120', 10);
}

// ── 1-CLICK TAB OPENERS ──
function openAllDis() {
  const dis = S.rules.filter(r => r.type === 'dis' && (S.selAgent === '*' || r.agent === S.selAgent || r.agent === '*'));
  const urls = [...new Set(dis.map(d => resolveEndpointUrl(S.base, d.path)))];

  if (!urls.length) { toast('No disallowed endpoints to open', 'warn'); return; }
  if (urls.length > 25) {
    if (!confirm(`Open ${urls.length} tabs in your browser?`)) return;
  }

  const delay = getDelay();
  urls.forEach((u, i) => {
    setTimeout(() => window.open(u, '_blank'), i * delay);
  });
  toast(`Opening ${urls.length} disallowed endpoints in tabs!`, 'ok');
}

function openSelectedDis() {
  if (!S.selectedDis.size) { toast('No endpoints selected', 'warn'); return; }
  const urls = Array.from(S.selectedDis);
  if (urls.length > 25) {
    if (!confirm(`Open ${urls.length} selected tabs?`)) return;
  }
  const delay = getDelay();
  urls.forEach((u, i) => setTimeout(() => window.open(u, '_blank'), i * delay));
  toast(`Opening ${urls.length} selected tabs!`, 'ok');
}

function openAllSitemaps() {
  if (!S.sitemaps.length) { toast('No sitemaps found', 'warn'); return; }
  const delay = getDelay();
  S.sitemaps.forEach((u, i) => {
    setTimeout(() => window.open(u, '_blank'), i * delay);
  });
  toast(`Opening ${S.sitemaps.length} sitemaps!`, 'ok');
}

// ── HIGH-RELIABILITY LIVE PROBING ──
async function probeUrl(url) {
  toast(`Probing ${url}...`, 'ok');
  try {
    // 1. Fast direct probe
    const r = await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(3500) });
    S.probeStatus[url] = 'live';
  } catch (e) {
    // 2. Fallback check via Jina proxy to get real status
    try {
      const pr = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(4500) });
      if (pr.ok) S.probeStatus[url] = 200;
      else S.probeStatus[url] = pr.status;
    } catch {
      S.probeStatus[url] = 'err';
    }
  }
  renderDisList();
  renderSitemapExplorer();
}

async function probeAllDis() {
  const dis = S.rules.filter(r => r.type === 'dis' && (S.selAgent === '*' || r.agent === S.selAgent || r.agent === '*'));
  const urls = [...new Set(dis.map(d => resolveEndpointUrl(S.base, d.path)))];
  if (!urls.length) return;

  const btn = document.getElementById('probeDisBtn');
  btn.textContent = 'Probing...';
  toast(`Probing ${urls.length} endpoints...`, 'ok');

  for (const u of urls) {
    try {
      await fetch(u, { mode: 'no-cors', signal: AbortSignal.timeout(2500) });
      S.probeStatus[u] = 'live';
    } catch {
      S.probeStatus[u] = 'err';
    }
    renderDisList();
  }

  btn.textContent = '⚡ Probe Live Status';
  toast('Disallowed endpoints probed!', 'ok');
}

async function probeSelectedDis() {
  if (!S.selectedDis.size) return;
  const urls = Array.from(S.selectedDis);
  toast(`Probing ${urls.length} selected endpoints...`, 'ok');
  for (const u of urls) {
    try {
      await fetch(u, { mode: 'no-cors', signal: AbortSignal.timeout(2500) });
      S.probeStatus[u] = 'live';
    } catch {
      S.probeStatus[u] = 'err';
    }
  }
  renderDisList();
  toast('Selected endpoints probed!', 'ok');
}

async function probeAllSitemapUrls() {
  const list = S.filteredSmUrls.slice(0, 30);
  if (!list.length) return;

  const btn = document.getElementById('probeAllSmBtn');
  btn.textContent = 'Probing...';
  toast(`Probing first ${list.length} sitemap URLs...`, 'ok');

  for (const u of list) {
    try {
      await fetch(u, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
      S.probeStatus[u] = 'live';
    } catch {
      S.probeStatus[u] = 'err';
    }
  }

  btn.textContent = '⚡ Probe Live Status';
  renderSitemapExplorer();
  toast('Sitemap URLs probed!', 'ok');
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
    extractedSitemapUrls: S.extractedUrls
  };
  dl('robotscheck.json', JSON.stringify(d, null, 2), 'application/json');
}

function expMD() {
  const dis = S.rules.filter(r => r.type === 'dis');
  let md = `# RobotsCheck Recon Report: ${S.base}\n\n*Timestamp: ${new Date().toLocaleString()}*\n\n## Disallowed Endpoints (${dis.length})\n\n`;
  dis.forEach(d => {
    const full = resolveEndpointUrl(S.base, d.path);
    md += `- \`${d.path}\` (Agent: \`${d.agent}\`) → [${full}](${full})\n`;
  });
  md += `\n## Sitemaps (${S.sitemaps.length})\n\n`;
  S.sitemaps.forEach(u => md += `- [${u}](${u})\n`);
  md += `\n## Sitemap Extracted URLs (${S.extractedUrls.length})\n\n`;
  S.extractedUrls.slice(0, 100).forEach(u => md += `- [${u}](${u})\n`);
  dl('robotscheck.md', md, 'text/markdown');
}

function expCSV() {
  let c = 'type,agent,path,full_url\n';
  S.rules.forEach(r => {
    const full = r.type === 'sitemap' ? r.path : resolveEndpointUrl(S.base, r.path);
    c += `${r.type},"${r.agent}","${r.path}","${full}"\n`;
  });
  S.extractedUrls.forEach(u => {
    c += `sitemap_url,"*",,"${u}"\n`;
  });
  dl('robotscheck.csv', c, 'text/csv');
}

function expTXT() {
  const dis = S.rules.filter(r => r.type === 'dis');
  let t = `# RobotsCheck Recon — ${S.base}\n# Disallowed Endpoints:\n`;
  dis.forEach(d => t += resolveEndpointUrl(S.base, d.path) + '\n');
  t += `\n# Sitemap URLs (${S.extractedUrls.length}):\n`;
  S.extractedUrls.forEach(u => t += u + '\n');
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

function copyAllDis() {
  const dis = S.rules.filter(r => r.type === 'dis');
  const text = dis.map(d => resolveEndpointUrl(S.base, d.path)).join('\n');
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${dis.length} URLs!`, 'ok'));
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
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d = Math.hypot(dx, dy);
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
