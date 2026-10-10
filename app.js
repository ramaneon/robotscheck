'use strict';

// ── CORS PROXIES ──
const PROXIES = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];

// ── STATE ──
let S = {
  base:'', raw:'', rules:[], sitemaps:[], disAllAgents:[], selAgent:'*',
  selected: new Set(), aborted: false
};

// ── FETCH HELPERS ──
async function proxyFetch(url, idx=0){
  if(idx>=PROXIES.length) throw new Error('all proxies failed');
  try{
    const r = await fetch(PROXIES[idx](url),{signal:AbortSignal.timeout(12000)});
    if(r.ok) return r;
    if(r.status===404) return null;
    return proxyFetch(url, idx+1);
  }catch(e){
    return proxyFetch(url, idx+1);
  }
}

async function fetchText(url){
  const r = await proxyFetch(url);
  if(!r) return {ok:false,text:''};
  return {ok:true, text: await r.text()};
}

// ── ROBOTS PARSER ──
function parseRobots(txt){
  const lines = txt.split(/\r?\n/);
  const rules = [];
  let agents = [];
  let inBlock = false;

  for(let raw of lines){
    const line = raw.trim();
    if(!line || line.startsWith('#')) continue;
    const lo = line.toLowerCase();

    if(lo.startsWith('user-agent:')){
      const ag = line.slice(11).trim();
      if(!inBlock){ agents=[ag]; inBlock=true; }
      else agents.push(ag);
    } else if(lo.startsWith('disallow:')){
      const path=line.slice(9).trim();
      if(path) agents.forEach(a=>rules.push({type:'dis',agent:a,path}));
      inBlock=true;
    } else if(lo.startsWith('allow:')){
      const path=line.slice(6).trim();
      if(path) agents.forEach(a=>rules.push({type:'all',agent:a,path}));
    } else if(lo.startsWith('sitemap:')){
      const sm=line.slice(8).trim();
      if(sm) rules.push({type:'sitemap',agent:'*',path:sm});
    } else if(lo.startsWith('crawl-delay:')){
      inBlock=true; // stay in block
    } else {
      inBlock=false; agents=[];
    }
  }
  return rules;
}

function highlightRobots(txt){
  return txt
    .replace(/^(#.*)$/gm,'<span class="r-cmt">$1</span>')
    .replace(/^(User-agent:)(.*)$/gim,'<span class="r-ua">$1</span>$2')
    .replace(/^(Disallow:)(.*)$/gim,'<span class="r-dis">$1</span>$2')
    .replace(/^(Allow:)(.*)$/gim,'<span class="r-all">$1</span>$2')
    .replace(/^(Sitemap:)(.*)$/gim,'<span class="r-sm">$1</span>$2');
}

// ── URL RULE TESTER ──
function robotsMatch(path, rulePath){
  // Google-style longest-match with $ and * support
  const rp = rulePath.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\\\\[\\$]/g,'$');
  const re = new RegExp('^'+rp);
  return re.test(path);
}

function checkUrlAgainst(testPath, agentFilter){
  const dis = S.rules.filter(r=>r.type==='dis'&&(r.agent==='*'||r.agent.toLowerCase()===agentFilter.toLowerCase()));
  const all = S.rules.filter(r=>r.type==='all'&&(r.agent==='*'||r.agent.toLowerCase()===agentFilter.toLowerCase()));
  let bestDis=null, bestAll=null;
  for(const r of dis){ if(robotsMatch(testPath,r.path)&&(!bestDis||r.path.length>bestDis.path.length)) bestDis=r; }
  for(const r of all){ if(robotsMatch(testPath,r.path)&&(!bestAll||r.path.length>bestAll.path.length)) bestAll=r; }
  if(!bestDis&&!bestAll) return {allowed:true, reason:'No matching rule — allowed by default'};
  if(bestDis&&!bestAll) return {allowed:false, reason:`Blocked by Disallow: ${bestDis.path} (agent: ${bestDis.agent})`};
  if(!bestDis&&bestAll) return {allowed:true, reason:`Allowed by Allow: ${bestAll.path} (agent: ${bestAll.agent})`};
  // both matched — longer wins
  if(bestAll.path.length>bestDis.path.length) return {allowed:true, reason:`Allow wins (longer): ${bestAll.path}`};
  return {allowed:false, reason:`Disallow wins (longer): ${bestDis.path}`};
}

// ── MAIN SCAN ──
async function go(){
  let raw = document.getElementById('inp').value.trim();
  if(!raw){ toast('Enter a domain first','err'); return; }
  if(!/^https?:\/\//i.test(raw)) raw='https://'+raw;
  let base;
  try{ base=new URL(raw).origin; }catch{ toast('Invalid URL','err'); return; }

  S = {base, raw:'', rules:[], sitemaps:[], disAllAgents:[], selAgent:'*', selected:new Set(), aborted:false};
  document.getElementById('scanBtn').textContent='SCANNING...';
  document.getElementById('scanBtn').classList.add('active');
  show('statusBar'); hide('results');
  setStatus('Fetching robots.txt from '+base, 5);

  // 1. Fetch robots.txt
  const robotsUrl = base+'/robots.txt';
  const res = await fetchText(robotsUrl);
  if(S.aborted) return;

  if(res.ok && res.text){
    S.raw = res.text;
    S.rules = parseRobots(res.text);
    S.sitemaps = S.rules.filter(r=>r.type==='sitemap').map(r=>r.path);
  } else {
    S.raw = '';
    toast('robots.txt not found or blocked by CORS','warn');
  }
  setStatus('Discovering sitemaps...', 40);

  // 2. Try default sitemaps
  const defaultSMs = ['/sitemap.xml','/sitemap_index.xml','/sitemap-index.xml','/news-sitemap.xml'];
  for(const sm of defaultSMs){
    const full = base+sm;
    if(!S.sitemaps.includes(full)) S.sitemaps.push(full);
  }
  setStatus('Done!', 100);

  setTimeout(()=>{
    hide('statusBar');
    renderAll();
    document.getElementById('scanBtn').textContent='SCAN';
    document.getElementById('scanBtn').classList.remove('active');
  }, 500);
}

function qs(d){ document.getElementById('inp').value=d; go(); }

// ── RENDER ──
function renderAll(){
  renderStats();
  renderRaw();
  renderSitemaps();
  renderDisallowed();
  show('results');
  document.getElementById('results').scrollIntoView({behavior:'smooth'});
  toast(`Scan complete — ${S.rules.filter(r=>r.type==='dis').length} disallowed paths found`,'ok');
}

function renderStats(){
  const dis = S.rules.filter(r=>r.type==='dis');
  const all = S.rules.filter(r=>r.type==='all');
  const agents = [...new Set(S.rules.map(r=>r.agent))];
  const data=[
    {n:dis.length,l:'Disallowed',c:'#ff4757'},
    {n:all.length,l:'Allowed',c:'#00f5a0'},
    {n:S.sitemaps.length,l:'Sitemaps',c:'#00d9f5'},
    {n:agents.length,l:'User Agents',c:'#ffd700'},
    {n:S.rules.length,l:'Total Rules',c:'#7a9db0'},
  ];
  document.getElementById('statsRow').innerHTML = data.map((d,i)=>`
    <div class="stat" style="--sc:${d.c};animation:fadeUp .4s ${i*.06}s ease backwards">
      <span class="stat-n">${d.n}</span>
      <span class="stat-l">${d.l}</span>
    </div>
  `).join('');
  // inject keyframe if missing
  if(!document.getElementById('fadeUpKF')){
    const s=document.createElement('style');
    s.id='fadeUpKF';
    s.textContent='@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }
}

function renderRaw(){
  const badge = document.getElementById('rawBadge');
  const pre = document.getElementById('rawPre');
  if(S.raw){
    badge.textContent='FOUND';
    badge.style.cssText='background:rgba(0,245,160,.1);border-color:rgba(0,245,160,.3);color:#00f5a0';
    pre.innerHTML = highlightRobots(esc(S.raw));
  } else {
    badge.textContent='NOT FOUND';
    badge.style.cssText='background:rgba(255,71,87,.1);border-color:rgba(255,71,87,.3);color:#ff4757';
    pre.innerHTML='<span class="muted">robots.txt not accessible (CORS or 404)</span>';
  }
}

function renderSitemaps(){
  const list = document.getElementById('smList');
  const badge = document.getElementById('smBadge');
  badge.textContent = S.sitemaps.length + ' found';
  if(!S.sitemaps.length){ list.innerHTML='<span class="muted">No sitemaps discovered</span>'; return; }
  list.innerHTML = S.sitemaps.map(u=>`
    <div class="url-row">
      <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>
      <span class="url-tag" style="background:rgba(255,215,0,.08);color:#ffd700;border:1px solid rgba(255,215,0,.2)">SITEMAP</span>
      <button class="dis-btn" onclick="copyT('${esc(u)}')" title="Copy">&#x1F4CB;</button>
    </div>
  `).join('');
}

function renderDisallowed(){
  const dis = S.rules.filter(r=>r.type==='dis');
  const badge = document.getElementById('disBadge');
  badge.textContent = dis.length + ' paths';

  // Build unique agents list
  const agents = ['*',...new Set(dis.map(r=>r.agent))];
  S.disAllAgents = agents;

  // Agent filter buttons
  const af = document.getElementById('agentFilter');
  const ab = document.getElementById('agentBtns');
  if(agents.length>1){
    af.classList.remove('hidden');
    ab.innerHTML = agents.map(a=>`
      <button class="agent-btn${a===S.selAgent?' active':''}" onclick="setAgent('${esc(a)}')">${esc(a)}</button>
    `).join('');
  } else {
    af.classList.add('hidden');
  }

  renderDisList();
}

function renderDisList(){
  const dis = S.rules.filter(r=>r.type==='dis' && (S.selAgent==='*' || r.agent===S.selAgent || r.agent==='*'));
  const list = document.getElementById('disList');

  if(!dis.length){
    list.innerHTML='<span class="muted">No disallowed paths for this agent</span>';
    document.getElementById('batchBar').classList.add('hidden');
    return;
  }

  list.innerHTML = dis.map((d,i)=>{
    const full = S.base+d.path;
    const sel = S.selected.has(full);
    return `
      <div class="dis-item${sel?' selected':''}" data-url="${esc(full)}" style="animation:fadeUp .3s ${i*.02}s ease backwards" onclick="toggleSel('${esc(full)}',event)">
        <div class="dis-chk${sel?' checked':''}" onclick="toggleSel('${esc(full)}',event)"></div>
        <span class="dis-path">${esc(d.path)}</span>
        <span class="dis-agent">${esc(d.agent)}</span>
        <div class="dis-btns">
          <button class="dis-btn" onclick="event.stopPropagation();window.open('${esc(full)}','_blank')" title="Open in browser">&#x1F517;</button>
          <button class="dis-btn" onclick="event.stopPropagation();copyT('${esc(full)}')" title="Copy URL">&#x1F4CB;</button>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('batchBar').classList.remove('hidden');
  updateSelCount();
}

function setAgent(a){
  S.selAgent=a;
  document.querySelectorAll('.agent-btn').forEach(b=>{
    b.classList.toggle('active', b.textContent===a);
  });
  S.selected.clear();
  renderDisList();
}

function toggleSel(url, e){
  if(e.target.classList.contains('dis-btn')) return;
  if(S.selected.has(url)) S.selected.delete(url);
  else S.selected.add(url);
  const item = document.querySelector(`.dis-item[data-url="${url}"]`);
  const chk = item?.querySelector('.dis-chk');
  if(item) item.classList.toggle('selected');
  if(chk) chk.classList.toggle('checked');
  updateSelCount();
}

function updateSelCount(){
  document.getElementById('selCount').textContent = S.selected.size+' selected';
}

function selectAll(){
  const dis = S.rules.filter(r=>r.type==='dis'&&(S.selAgent==='*'||r.agent===S.selAgent||r.agent==='*'));
  dis.forEach(d=>S.selected.add(S.base+d.path));
  renderDisList();
}

function clearSel(){
  S.selected.clear();
  renderDisList();
}

// ── THE MAIN FEATURE: OPEN ALL ──
function openAll(){
  const dis = S.rules.filter(r=>r.type==='dis'&&(S.selAgent==='*'||r.agent===S.selAgent||r.agent==='*'));
  const urls = dis.map(d=>S.base+d.path);
  if(!urls.length){ toast('No disallowed paths to open','warn'); return; }
  if(urls.length>20){
    if(!confirm(`Open ${urls.length} tabs? Browsers may block popups after the first few. Proceed?`)) return;
  }
  urls.forEach((u,i)=>setTimeout(()=>window.open(u,'_blank'),i*80));
  toast(`Opening ${urls.length} tabs...`,'ok');
}

function openSelected(){
  if(!S.selected.size){ toast('No paths selected','warn'); return; }
  const urls=[...S.selected];
  if(urls.length>20){
    if(!confirm(`Open ${urls.length} tabs?`)) return;
  }
  urls.forEach((u,i)=>setTimeout(()=>window.open(u,'_blank'),i*80));
  toast(`Opening ${urls.length} tabs...`,'ok');
}

function openAllSitemaps(){
  if(!S.sitemaps.length){ toast('No sitemaps found','warn'); return; }
  S.sitemaps.forEach((u,i)=>setTimeout(()=>window.open(u,'_blank'),i*80));
  toast(`Opening ${S.sitemaps.length} sitemaps...`,'ok');
}

// ── URL TESTER ──
function testUrl(){
  const path = document.getElementById('testUrl').value.trim();
  const agent = document.getElementById('testAgent').value;
  if(!path){ toast('Enter a path to test','warn'); return; }
  if(!S.rules.length){ toast('Run a scan first','warn'); return; }
  const result = checkUrlAgainst(path, agent);
  const el = document.getElementById('testResult');
  el.className = 'test-result '+(result.allowed?'allowed':'blocked');
  el.innerHTML = `<b>${result.allowed?'✅ ALLOWED':'🚫 BLOCKED'}</b><br><span style="opacity:.8;font-size:11px">${esc(result.reason)}</span>`;
  el.classList.remove('hidden');
}

// ── COPY/OPEN ──
function copyAllDis(){
  const dis=S.rules.filter(r=>r.type==='dis');
  navigator.clipboard.writeText(dis.map(d=>S.base+d.path).join('\n'))
    .then(()=>toast('Copied '+dis.length+' URLs','ok'));
}

function copyEl(id){
  const el=document.getElementById(id);
  navigator.clipboard.writeText(el.innerText||el.textContent).then(()=>toast('Copied!','ok'));
}

function copyT(t){
  navigator.clipboard.writeText(t).then(()=>toast('Copied!','ok'));
}

// ── EXPORT ──
function expJSON(){
  const d={target:S.base,scannedAt:new Date().toISOString(),
    robotsTxt:{found:!!S.raw,raw:S.raw},
    rules:S.rules, sitemaps:S.sitemaps};
  dl('robotscheck.json',JSON.stringify(d,null,2),'application/json');
}
function expMD(){
  const dis=S.rules.filter(r=>r.type==='dis');
  let md=`# RobotsCheck: ${S.base}\n\n*Scanned: ${new Date().toLocaleString()}*\n\n## Disallowed Paths (${dis.length})\n\n`;
  dis.forEach(d=>md+=`- \`${d.path}\` — agent: \`${d.agent}\` → [${S.base+d.path}](${S.base+d.path})\n`);
  md+=`\n## Sitemaps\n\n`;
  S.sitemaps.forEach(u=>md+=`- [${u}](${u})\n`);
  dl('robotscheck.md',md,'text/markdown');
}
function expCSV(){
  let c='type,agent,path,full_url\n';
  S.rules.forEach(r=>c+=`${r.type},"${r.agent}","${r.path}","${r.type==='sitemap'?r.path:S.base+r.path}"\n`);
  dl('robotscheck.csv',c,'text/csv');
}
function expTXT(){
  const dis=S.rules.filter(r=>r.type==='dis');
  let t=`# RobotsCheck — ${S.base}\n# Disallowed paths:\n`;
  dis.forEach(d=>t+=S.base+d.path+'\n');
  t+=`\n# Sitemaps:\n`;
  S.sitemaps.forEach(u=>t+=u+'\n');
  dl('robotscheck.txt',t,'text/plain');
}

function dl(name,content,type){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name; a.click();
  toast('Exported '+name,'ok');
}

// ── UI HELPERS ──
function setStatus(msg,pct){
  document.getElementById('statusMsg').textContent=msg;
  document.getElementById('prog').style.width=pct+'%';
  document.getElementById('progPct').textContent=pct+'%';
}

function toggleCard(id){
  const el=document.getElementById(id);
  el.style.display=el.style.display==='none'?'':'none';
}

function resetUI(){
  hide('results'); hide('statusBar');
  document.getElementById('inp').value='';
  document.getElementById('scanBtn').textContent='SCAN';
  document.getElementById('scanBtn').classList.remove('active');
  document.getElementById('rawPre').innerHTML='<span class="muted">Run a scan first</span>';
  document.getElementById('disList').innerHTML='<span class="muted">Run a scan first</span>';
  window.scrollTo({top:0,behavior:'smooth'});
}

function show(id){document.getElementById(id).classList.remove('hidden')}
function hide(id){document.getElementById(id).classList.add('hidden')}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function toast(msg,type='ok'){
  const c=document.getElementById('toast');
  const d=document.createElement('div');
  d.className='toast-item';
  const ico={ok:'✓',err:'✗',warn:'!'};
  d.textContent=(ico[type]||'•')+' '+msg;
  if(type==='err') d.style.borderColor='rgba(255,71,87,.4)';
  if(type==='warn') d.style.borderColor='rgba(255,165,0,.4)';
  c.appendChild(d);
  setTimeout(()=>{d.style.opacity='0';d.style.transition='opacity .3s';setTimeout(()=>d.remove(),300);},3000);
}

// ── BG CANVAS (network nodes) ──
(function(){
  const cv=document.getElementById('bg'),ctx=cv.getContext('2d');
  let W,H,nodes=[];
  function rsz(){W=cv.width=innerWidth;H=cv.height=innerHeight}
  function init(){
    nodes=[];
    const n=Math.min(70,Math.floor(W*H/12000));
    for(let i=0;i<n;i++) nodes.push({
      x:Math.random()*W,y:Math.random()*H,
      vx:(Math.random()-.5)*.35,vy:(Math.random()-.5)*.35,
      r:Math.random()*1.8+.8,
      c:Math.random()>.55?'#00f5a0':Math.random()>.5?'#00d9f5':'#ffffff',
      a:Math.random()*.5+.1
    });
  }
  function draw(){
    ctx.clearRect(0,0,W,H);
    for(let i=0;i<nodes.length;i++){
      for(let j=i+1;j<nodes.length;j++){
        const dx=nodes[i].x-nodes[j].x,dy=nodes[i].y-nodes[j].y,d=Math.hypot(dx,dy);
        if(d<130){ctx.beginPath();ctx.moveTo(nodes[i].x,nodes[i].y);ctx.lineTo(nodes[j].x,nodes[j].y);
          ctx.strokeStyle=`rgba(0,245,160,${(1-d/130)*.1})`;ctx.lineWidth=.4;ctx.stroke()}
      }
    }
    nodes.forEach(n=>{
      ctx.beginPath();ctx.arc(n.x,n.y,n.r,0,6.28);
      ctx.fillStyle=n.c;ctx.globalAlpha=n.a;ctx.fill();ctx.globalAlpha=1;
      n.x+=n.vx;n.y+=n.vy;
      if(n.x<0||n.x>W)n.vx*=-1;if(n.y<0||n.y>H)n.vy*=-1;
    });
    requestAnimationFrame(draw);
  }
  rsz();init();draw();
  window.addEventListener('resize',()=>{rsz();init()});
})();

// ── 3D SPHERE ──
(function(){
  const cv=document.getElementById('sphere');
  if(!cv)return;
  const ctx=cv.getContext('2d');
  const W=420,H=420,cx=W/2,cy=H/2,R=155;
  cv.width=W;cv.height=H;
  const N=220;
  const pts=[];
  for(let i=0;i<N;i++){
    const phi=Math.acos(-1+(2*i)/N),th=Math.sqrt(N*Math.PI)*phi;
    pts.push({phi,th});
  }
  let ang=0;
  function draw(){
    ctx.clearRect(0,0,W,H);ang+=.004;
    const cos=Math.cos(ang),sin=Math.sin(ang);
    const proj=pts.map(p=>{
      const x0=R*Math.sin(p.phi)*Math.cos(p.th);
      const y0=R*Math.sin(p.phi)*Math.sin(p.th);
      const z0=R*Math.cos(p.phi);
      const x1=x0*cos-z0*sin,z1=x0*sin+z0*cos;
      const fov=500,sc=fov/(fov+z1);
      return{px:cx+x1*sc,py:cy+y0*sc,z:z1,sc};
    }).sort((a,b)=>a.z-b.z);

    // glow
    const g=ctx.createRadialGradient(cx,cy,R*.5,cx,cy,R*1.3);
    g.addColorStop(0,'rgba(0,245,160,.05)');g.addColorStop(1,'rgba(0,245,160,0)');
    ctx.beginPath();ctx.arc(cx,cy,R*1.3,0,6.28);ctx.fillStyle=g;ctx.fill();

    proj.forEach(p=>{
      const dep=(p.z+R)/(2*R);
      ctx.beginPath();ctx.arc(p.px,p.py,dep*2.2+.4,0,6.28);
      ctx.fillStyle=dep>.5?'#00f5a0':'#00d9f5';
      ctx.globalAlpha=dep*.75+.05;ctx.fill();ctx.globalAlpha=1;
    });

    ctx.beginPath();ctx.ellipse(cx,cy,R,R*Math.abs(Math.sin(ang*.25+.8)),0,0,6.28);
    ctx.strokeStyle='rgba(0,245,160,.12)';ctx.lineWidth=1;ctx.stroke();
    requestAnimationFrame(draw);
  }
  draw();
})();

document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&document.activeElement.id==='inp') go();
  if(e.key==='Enter'&&document.activeElement.id==='testUrl') testUrl();
});

console.log('%c RobotsCheck v2.0 ', 'background:#00f5a0;color:#06090f;font-size:14px;font-weight:bold;padding:3px 8px;border-radius:4px;');
