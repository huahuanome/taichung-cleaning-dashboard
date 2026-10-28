(() => {
  'use strict';
  const API = 'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=c923ad20-2ec6-43b9-b3ab-54527e99f7bc';
  const INTERVAL = 600000, RECENT = 1800000;
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['status','countdown','refresh','dataTime','fetchTime','warning','total','moving','overspeed','avg','bars','trend','trendCaption','search','filter','resultCount','vehicles','listEmpty'].map(id => [id, $(id)]));
  let records = [], history = [], nextAt = Date.now(), fetching = false, hasData = false;
  let latestTime = null, latestChangedAt = null, lastFetch = null, lastError = false;

  function parseTime(value) {
    const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    const [, y, m, d, h, min, s] = match;
    const date = new Date(`${y}-${m}-${d}T${h}:${min}:${s}+08:00`);
    if (!Number.isFinite(date.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    if (parts.year !== y || parts.month !== m || parts.day !== d || parts.hour !== h || parts.minute !== min || parts.second !== s) return null;
    return date.getTime();
  }
  function formatTime(value) {
    if (value === null) return '尚無資料';
    return new Intl.DateTimeFormat('zh-TW', {timeZone:'Asia/Taipei', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).format(new Date(value));
  }
  function normalize(row) {
    const car = String(row.car ?? '').trim();
    const time = parseTime(row.time);
    const rawSpeed = String(row.SpeedValue ?? '').trim();
    const speed = rawSpeed === '' ? null : Number(rawSpeed);
    return { car, time, location: String(row.location ?? '').trim(), speed: Number.isFinite(speed) && speed >= 0 ? speed : null, over: String(row.OverSpeed ?? '').trim().toUpperCase() === 'Y' };
  }
  function renderWarning() {
    const old = latestTime !== null && Date.now() - latestTime > RECENT;
    const unchanged = latestChangedAt !== null && Date.now() - latestChangedAt > RECENT;
    ui.warning.hidden = !(old || unchanged);
    if (old || unchanged) ui.warning.textContent = '資料可能延遲：最新車輛回報時間超過 30 分鐘，或回報時間已超過 30 分鐘沒有變化。';
  }
  function node(tag, cls, content) {
    const el = document.createElement(tag); if (cls) el.className = cls; if (content != null) el.textContent = content; return el;
  }
  function renderBars() {
    const bins = [0,0,0,0,0];
    records.forEach(r => { if (r.speed === null) bins[4]++; else if (r.speed === 0) bins[0]++; else if (r.speed <= 20) bins[1]++; else if (r.speed <= 40) bins[2]++; else bins[3]++; });
    const labels = ['0 km/h','大於 0–20 km/h','大於 20–40 km/h','40 km/h 以上','未提供'];
    const max = Math.max(1,...bins);
    ui.bars.replaceChildren();
    labels.forEach((label,i) => {
      const row = node('div','speed-bar-row');
      const track = node('div','speed-bar-track'); const fill = node('div','speed-bar-fill');
      fill.style.width = `${bins[i] / max * 100}%`; track.append(fill);
      row.append(node('span','speed-bar-label',label),track,node('span','speed-bar-count',String(bins[i]))); ui.bars.append(row);
    });
  }
  function svgNode(tag, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [key,val] of Object.entries(attrs)) el.setAttribute(key,val);
    if (text != null) el.textContent = text; return el;
  }
  function renderTrend() {
    const svg = ui.trend; svg.replaceChildren(); svg.setAttribute('viewBox','0 0 620 190');
    svg.setAttribute('role','img'); svg.setAttribute('aria-label', `開啟頁面後的近期回報車輛數，已記錄 ${history.length} 次`);
    const left=40,right=600,top=18,bottom=150, max=Math.max(1,...history.map(h=>h.value));
    for (let i=0;i<=2;i++) {
      const y=top+(bottom-top)*i/2;
      svg.append(svgNode('line',{x1:left,y1:y,x2:right,y2:y,stroke:'#e2e8e5','stroke-width':'1'}));
      svg.append(svgNode('text',{x:30,y:y+4,'text-anchor':'end',fill:'#74847e','font-size':'11'},String(Math.round(max*(1-i/2)))));
    }
    if (history.length) {
      const points = history.map((p,i) => ({x: history.length===1 ? left : left+(right-left)*i/(history.length-1), y: bottom-(bottom-top)*p.value/max, ...p}));
      if (points.length>1) svg.append(svgNode('polyline',{points:points.map(p=>`${p.x},${p.y}`).join(' '),fill:'none',stroke:'#16816a','stroke-width':'3','stroke-linejoin':'round','stroke-linecap':'round'}));
      points.forEach(p=>svg.append(svgNode('circle',{cx:p.x,cy:p.y,r:'4',fill:'#16816a'})));
      svg.append(svgNode('text',{x:left,y:177,fill:'#74847e','font-size':'11'},formatTime(points[0].at)));
      if (points.length>1) svg.append(svgNode('text',{x:right,y:177,'text-anchor':'end',fill:'#74847e','font-size':'11'},formatTime(points.at(-1).at)));
    }
    ui.trendCaption.textContent = history.length < 2 ? '目前只有一次成功更新；下次更新後即可看見變化。' : `本次開啟期間已記錄 ${history.length} 次成功更新；重新開啟頁面會重新記錄。`;
  }
  function renderVehicles() {
    const term=ui.search.value.trim().toLocaleLowerCase(); const mode=ui.filter.value;
    const filtered=records.filter(r => (!term || `${r.car} ${r.location}`.toLocaleLowerCase().includes(term)) && (mode !== 'moving' || r.speed > 0) && (mode !== 'overspeed' || r.over));
    filtered.sort((a,b) => Number(b.over)-Number(a.over) || b.time-a.time || a.car.localeCompare(b.car));
    ui.resultCount.textContent = `${filtered.length} 輛`;
    ui.vehicles.replaceChildren();
    ui.listEmpty.hidden = filtered.length !== 0;
    if (!filtered.length) ui.listEmpty.textContent = hasData ? (records.length ? '找不到符合條件的車輛，請試試其他搜尋條件。' : '目前沒有近 30 分鐘內的車輛回報。') : '等待資料載入。';
    const frag=document.createDocumentFragment();
    filtered.forEach(r=>{
      const card=node('article','vehicle-card'+(r.over?' is-over':''));
      const main=node('div','vehicle-main');
      const title=node('div','vehicle-title'); title.append(node('strong','vehicle-plate',r.car));
      if(r.over) title.append(node('span','vehicle-flag','超速回報'));
      main.append(title,node('div','vehicle-location',r.location || '未提供地點'),node('div','vehicle-meta',`回報 ${formatTime(r.time)}`));
      const right=node('div','vehicle-speed');
      right.append(node('strong','vehicle-speed-value',r.speed===null?'—':`${r.speed}`),node('span','vehicle-speed-unit',r.speed===null?'車速未提供':'km/h'));
      card.append(main,right); frag.append(card);
    });
    ui.vehicles.append(frag);
  }
  function render() {
    const valid=records.filter(r=>r.speed!==null);
    ui.total.textContent=String(records.length);
    ui.moving.textContent=String(records.filter(r=>r.speed>0).length);
    ui.overspeed.textContent=String(records.filter(r=>r.over).length);
    ui.avg.textContent=valid.length ? (valid.reduce((a,r)=>a+r.speed,0)/valid.length).toFixed(1) : '—';
    ui.dataTime.textContent=formatTime(latestTime); ui.fetchTime.textContent=formatTime(lastFetch);
    renderWarning(); renderBars(); renderTrend(); renderVehicles();
  }
  async function refreshData() {
    if (fetching) return;
    fetching = true; nextAt=Date.now()+INTERVAL; ui.refresh.disabled=true; ui.status.textContent='更新中';
    try {
      const response=await fetch(API,{cache:'no-store'});
      if(!response.ok) throw new Error('HTTP '+response.status);
      const payload=await response.json();
      if(!Array.isArray(payload)) throw new Error('資料格式不正確');
      const parsed=payload.map(normalize);
      if(payload.length && !parsed.some(r=>r.car && r.time!==null)) throw new Error('沒有有效的車號與時間');
      const now=Date.now();
      const times=parsed.map(r=>r.time).filter(t=>t!==null && t<=now+300000);
      const newLatest=times.length ? Math.max(...times) : null;
      if(newLatest !== latestTime) latestChangedAt=now;
      latestTime=newLatest;
      const unique=new Map();
      parsed.forEach(r=>{
        if(!r.car || r.time===null || r.time<now-RECENT || r.time>now+300000) return;
        const previous=unique.get(r.car); if(!previous || r.time>previous.time) unique.set(r.car,r);
      });
      records=[...unique.values()]; lastFetch=now; hasData=true; lastError=false;
      history.push({at:now,value:records.length}); if(history.length>72) history.shift();
      ui.status.textContent='資料已更新'; render();
    } catch(err) {
      lastError=true; ui.status.textContent='更新失敗，稍後自動重試';
      if(!hasData) { ui.listEmpty.hidden=false; ui.listEmpty.textContent='目前無法取得資料，請稍後再試。'; }
      console.error('更新資料失敗',err);
    } finally { fetching=false; ui.refresh.disabled=false; }
  }
  function tick() {
    const seconds=Math.max(0,Math.ceil((nextAt-Date.now())/1000));
    ui.countdown.textContent=`${seconds} 秒`;
    if(Date.now()>=nextAt && !fetching) refreshData();
    renderWarning();
  }
  ui.refresh.addEventListener('click',refreshData);
  ui.search.addEventListener('input',renderVehicles);
  ui.filter.addEventListener('change',renderVehicles);
  renderBars(); renderTrend(); tick(); setInterval(tick,1000);
})();



