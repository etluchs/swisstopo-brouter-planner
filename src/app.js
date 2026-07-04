/* swisstopo raster base (native LV95 / EPSG:2056) + BRouter router.
   The map renders in the true Swiss projection so it matches the printed
   Landeskarte grid with no Mercator distortion (proj4 + proj4leaflet).
   State: ordered waypoints; each carries `mode` for the leg leading INTO it
   ('route'|'direct'). Route is built per-leg, so direct legs never hit the
   router — that's how a path missing from OSM but visible on topo enters the track.
   Leaflet uses [lat,lng]; BRouter/GPX use [lng,lat]. Conversions are explicit. */

// LV95 / EPSG:2056 (Swiss oblique Mercator on Bessel). resolutions + origin are
// swisstopo's WMTS tile grid; verified against a live central-Zürich tile.
proj4.defs('EPSG:2056','+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 '
  +'+k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel '
  +'+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');
const LV95_RES=[4000,3750,3500,3250,3000,2750,2500,2250,2000,1750,1500,1250,1000,750,650,
  500,250,100,50,20,10,5,2.5,2,1.5,1,0.5,0.25,0.1];   // zoom 0..28 → metres/px
const swissCRS=new L.Proj.CRS('EPSG:2056',proj4.defs('EPSG:2056'),{
  resolutions:LV95_RES, origin:[2420000,1350000],
  bounds:L.bounds([2420000,1030000],[2900000,1350000])});

const TILE = id => `https://wmts.geo.admin.ch/1.0.0/${id}/default/current/2056/{z}/{x}/{y}.jpeg`;
const topo   = L.tileLayer(TILE('ch.swisstopo.pixelkarte-farbe'),{maxZoom:28,maxNativeZoom:27,attribution:'© swisstopo'});
const aerial = L.tileLayer(TILE('ch.swisstopo.swissimage'),      {maxZoom:28,maxNativeZoom:28,attribution:'© swisstopo'});

const map = L.map('map',{crs:swissCRS,center:[47.376,8.541],zoom:19,minZoom:8,maxZoom:28,layers:[topo]});

// Optional swisstopo thematic overlays (transparent PNG, same LV95 grid). Higher
// zIndex than the base but still in tilePane, so they sit above the map yet below
// the route (overlayPane) and markers (markerPane). Add a layer = one line here.
const OVERLAYS=[
  {id:'ch.astra.veloland',         label:'Cycling routes (Veloland)'},
  {id:'ch.astra.mountainbikeland', label:'Mountain-bike routes'},
  {id:'ch.bav.haltestellen-oev',   label:'Public transport stops'},
];
const overlayLayers=new Map();   // id -> L.tileLayer (created lazily on first enable)
function toggleOverlay(id,on){
  if(on){
    if(!overlayLayers.has(id))
      overlayLayers.set(id,L.tileLayer(
        `https://wmts.geo.admin.ch/1.0.0/${id}/default/current/2056/{z}/{x}/{y}.png`,
        {maxZoom:28,maxNativeZoom:27,zIndex:10,attribution:'© swisstopo'}));
    overlayLayers.get(id).addTo(map);
  }else if(overlayLayers.has(id)){
    map.removeLayer(overlayLayers.get(id));
  }
}
function renderOverlayList(){
  const box=document.getElementById('overlayList');
  OVERLAYS.forEach(o=>{
    const lab=document.createElement('label');
    const cb=document.createElement('input');cb.type='checkbox';
    cb.addEventListener('change',()=>toggleOverlay(o.id,cb.checked));
    const span=document.createElement('span');span.textContent=o.label;
    lab.append(cb,span); box.append(lab);
  });
}

// ---- feature identify (right-click / long-press) ----
// Left-click adds waypoints, so identify rides on contextmenu (fired by both
// right-click and touch long-press). Queries the enabled overlays plus place
// names, so it always returns something useful. swisstopo identify is LV95-native.
const IDENTIFY_API='https://api3.geo.admin.ch/rest/services/all/MapServer/identify';
const IDENTIFY_EXTRA=['ch.swisstopo.swissnames3d'];   // place-name context, always on
map.on('contextmenu',e=>{L.DomEvent.preventDefault(e.originalEvent);identifyAt(e.latlng);});
async function identifyAt(latlng){
  const active=OVERLAYS.filter(o=>overlayLayers.has(o.id)&&map.hasLayer(overlayLayers.get(o.id))).map(o=>o.id);
  const layers=[...active,...IDENTIFY_EXTRA];
  const pop=L.popup({className:'id-pop',maxWidth:260,autoPan:false})
    .setLatLng(latlng).setContent('Identifying…').openOn(map);
  try{
    const [E,N]=wgs84ToLv95(latlng.lng,latlng.lat);
    const b=map.getBounds();
    const sw=wgs84ToLv95(b.getWest(),b.getSouth()), ne=wgs84ToLv95(b.getEast(),b.getNorth());
    const sz=map.getSize();
    const url=`${IDENTIFY_API}?geometry=${E.toFixed(1)},${N.toFixed(1)}&geometryType=esriGeometryPoint`
      +`&layers=all:${layers.join(',')}`
      +`&mapExtent=${sw[0].toFixed(1)},${sw[1].toFixed(1)},${ne[0].toFixed(1)},${ne[1].toFixed(1)}`
      +`&imageDisplay=${sz.x},${sz.y},96&tolerance=8&sr=2056&lang=en`;
    const res=await fetch(url);
    if(!res.ok) throw new Error('identify '+res.status);
    const data=await res.json();
    pop.setContent(identifyHtml(data.results||[]));
  }catch(_){ pop.setContent('Couldn’t reach the swisstopo identify service.'); }
}
const featLabel=a=>(a&&(a.name||a.label||a.bezeichnung||a.gemname))||'';
const escapeHtml=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function identifyHtml(results){
  if(!results.length) return 'Nothing to identify here.';
  const seen=new Set(), rows=[];
  for(const r of results){
    const name=featLabel(r.attributes)||'(unnamed)';
    const key=(r.layerBodId||'')+'|'+name;
    if(seen.has(key)) continue; seen.add(key);
    rows.push(`<div class="id-row"><span class="id-layer">${escapeHtml(r.layerName||r.layerBodId||'')}</span>`
      +`${escapeHtml(name)}</div>`);
    if(rows.length>=6) break;
  }
  return `<div class="id-list">${rows.join('')}</div>`;
}
const routeGroup = L.layerGroup().addTo(map);
setTimeout(()=>map.invalidateSize(),200);

// Safety net: if swisstopo tiles are blocked in this context (referrer/hotlink
// protection on a sandboxed origin), warn once. There's no raster fallback now
// that the map renders in native LV95 — OpenTopoMap is Web-Mercator-only, and
// mixed projections can't align — but a real deployment loads swisstopo fine.
let swissBlocked=false, topoErrs=0;
topo.on('tileerror',()=>{
  if(swissBlocked || ++topoErrs<3) return;
  swissBlocked=true;
  showWarn('swisstopo tiles didn\u2019t load in this preview \u2014 almost certainly referrer/hotlink protection on the sandbox origin, not a bug in the endpoint. In a normal browser or your own deployment the swisstopo Landeskarte loads fine.');
});

// ---- state ----
let waypoints=[];            // {id,lng,lat,mode}
let markers=new Map();       // id -> L.marker
let legLayers=new Map();     // leg index -> L.polyline (for list<->map highlight)
let addMode='route', profile='trekking', endpoint='https://brouter.de/brouter';
const legCache=new Map();    // key -> {coords:[[lng,lat]...], ascend}
let gen=0;
const uid=()=>Math.random().toString(36).slice(2,9);
const getCss=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const toLatLng=c=>[c[1],c[0]];
function haversine(a,b){const R=6371000,r=Math.PI/180,dLat=(b[1]-a[1])*r,dLon=(b[0]-a[0])*r;
  const s=Math.sin(dLat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));}
const pinColor=i=>i===0?getCss('--start'):i===waypoints.length-1?getCss('--end'):getCss('--via');
const wpIcon=c=>L.divIcon({className:'',html:`<div class="wp" style="background:${c}"></div>`,iconSize:[16,16],iconAnchor:[8,8]});

// ---- map interaction ----
map.on('click',e=>addPoint(e.latlng.lng,e.latlng.lat));

// ---- waypoint ops ----
function addPoint(lng,lat){waypoints.push({id:uid(),lng,lat,mode:addMode});syncMarkers();recompute();}
function insertOnLeg(toIdx,latlng){
  const mode=waypoints[toIdx].mode;
  waypoints.splice(toIdx,0,{id:uid(),lng:latlng.lng,lat:latlng.lat,mode});
  syncMarkers();recompute();
}
function removePoint(id){waypoints=waypoints.filter(w=>w.id!==id);syncMarkers();recompute();}
function setLegMode(id,mode){const w=waypoints.find(w=>w.id===id);if(w){w.mode=mode;recompute();}}

function syncMarkers(){
  for(const m of markers.values()) map.removeLayer(m);
  markers.clear();
  waypoints.forEach((w,i)=>{
    const mk=L.marker([w.lat,w.lng],{draggable:true,icon:wpIcon(pinColor(i))}).addTo(map);
    mk.on('dragend',()=>{const p=mk.getLatLng();w.lng=p.lng;w.lat=p.lat;recompute();});
    markers.set(w.id,mk);
  });
}

// ---- routing ----
const legKey=(a,b)=>`${profile}|${a.lng.toFixed(6)},${a.lat.toFixed(6)}|${b.lng.toFixed(6)},${b.lat.toFixed(6)}`;
async function fetchLeg(a,b){
  const key=legKey(a,b);
  if(legCache.has(key)) return legCache.get(key);
  const url=`${endpoint.replace(/\/$/,'')}?lonlats=${a.lng},${a.lat}|${b.lng},${b.lat}`
    +`&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;
  const res=await fetch(url);
  if(!res.ok) throw new Error('BRouter '+res.status);
  const gj=await res.json(); const f=gj.features&&gj.features[0];
  if(!f) throw new Error('empty route');
  const out={coords:f.geometry.coordinates.map(c=>[c[0],c[1]]),
             ascend:parseInt((f.properties||{})['filtered ascend'],10)||0};
  legCache.set(key,out); return out;
}

// ---- elevation for direct legs ----
// Routed legs get ascent from BRouter; hand-drawn direct legs sample the
// swisstopo swissAlti3D DEM via the profile service. WGS84->LV95 uses swisstopo's
// approximate formula (sub-metre over CH, so no proj4 dependency).
const heightApi='https://api3.geo.admin.ch/rest/services/profile.json';
const directCache=new Map();   // directKey -> ascend metres
function wgs84ToLv95(lng,lat){
  const p=(lat*3600-169028.66)/10000, l=(lng*3600-26782.5)/10000;
  const E=2600072.37+211455.93*l-10938.51*l*p-0.36*l*p*p-44.54*l*l*l;
  const N=1200147.07+308807.95*p+3745.25*l*l+76.63*p*p-194.56*l*l*p+119.79*p*p*p;
  return [E,N];
}
const directKey=(a,b)=>`${a.lng.toFixed(6)},${a.lat.toFixed(6)}|${b.lng.toFixed(6)},${b.lat.toFixed(6)}`;
async function fetchDirectAscend(a,b){
  const key=directKey(a,b);
  if(directCache.has(key)) return directCache.get(key);
  const dist=haversine([a.lng,a.lat],[b.lng,b.lat]);
  const n=Math.max(2,Math.min(200,Math.round(dist/50)));   // ~1 sample / 50 m
  const geom=JSON.stringify({type:'LineString',
    coordinates:[wgs84ToLv95(a.lng,a.lat),wgs84ToLv95(b.lng,b.lat)]});
  const res=await fetch(`${heightApi}?geom=${encodeURIComponent(geom)}&sr=2056&nbPoints=${n}`);
  if(!res.ok) throw new Error('height '+res.status);   // don't cache failures — let a later pass retry
  const pts=await res.json();
  let asc=0;
  for(let k=1;k<pts.length;k++){const d=pts[k].alts.COMB-pts[k-1].alts.COMB;if(d>0)asc+=d;}
  directCache.set(key,asc); return asc;
}

async function recompute(){
  const my=++gen;
  renderLegList();
  if(waypoints.length<2){setRoute([]);setStats(0,0);showWarn('');return;}
  // Kick every routed leg's BRouter fetch off at once (they were sequential),
  // keeping one polyline per leg so the per-leg toggle/highlight/elevation model
  // stays intact. `plan` preserves leg order; routed entries carry a settled
  // promise so one failed leg can't reject the whole batch.
  const directLegs=[]; const plan=[];
  for(let i=1;i<waypoints.length;i++){
    const a=waypoints[i-1],b=waypoints[i];
    if(b.mode==='direct'){ plan.push({mode:'direct',leg:i,a,b}); directLegs.push({a,b}); }
    else plan.push({mode:'route',leg:i,a,b,p:fetchLeg(a,b).then(r=>({r}),err=>({err}))});
  }
  await Promise.all(plan.map(x=>x.p).filter(Boolean));
  if(my!==gen)return;
  const legs=[]; let dist=0,asc=0,failed=false;
  for(const x of plan){
    if(x.mode==='direct'){
      legs.push({mode:'direct',leg:x.leg,latlngs:[[x.a.lat,x.a.lng],[x.b.lat,x.b.lng]]});
      dist+=haversine([x.a.lng,x.a.lat],[x.b.lng,x.b.lat]);
      continue;
    }
    const {r,err}=await x.p;                       // already settled by Promise.all above
    if(err){
      failed=true;
      legs.push({mode:'error',leg:x.leg,latlngs:[[x.a.lat,x.a.lng],[x.b.lat,x.b.lng]]});
      dist+=haversine([x.a.lng,x.a.lat],[x.b.lng,x.b.lat]);
    }else{
      legs.push({mode:'route',leg:x.leg,latlngs:r.coords.map(toLatLng)});
      asc+=r.ascend;
      for(let k=1;k<r.coords.length;k++) dist+=haversine(r.coords[k-1],r.coords[k]);
    }
  }
  setRoute(legs); setStats(dist,asc);
  showWarn(failed
    ? 'A routed leg failed — shown dashed red. On the public endpoint this is usually CORS; point the field at your own BRouter instance. Direct legs still work.'
    : '');
  // Direct-leg elevation is best-effort and independent of the drawn geometry:
  // fetch it after the path is on screen, then fold it into the ascent stat.
  if(directLegs.length){
    const adds=await Promise.all(directLegs.map(({a,b})=>fetchDirectAscend(a,b).catch(()=>0)));
    if(my!==gen)return;
    setStats(dist,asc+adds.reduce((s,v)=>s+v,0));
  }
}

const HIT_WEIGHT=28;   // invisible finger-friendly tap band around each leg
function setRoute(legs){
  routeGroup.clearLayers();
  legLayers.clear();
  legs.forEach(o=>{
    const base = o.mode==='route'  ? {color:getCss('--route'),weight:4.5,opacity:.9}
              : o.mode==='direct' ? {color:getCss('--direct'),weight:4,opacity:.95,dashArray:'6,7'}
              :                      {color:getCss('--error'),weight:3,opacity:.9,dashArray:'4,6'};
    // thin visible line (display only) …
    const pl=L.polyline(o.latlngs,{...base,interactive:false}).addTo(routeGroup);
    pl._baseWeight=base.weight;
    legLayers.set(o.leg,pl);
    // … plus a wide transparent line that actually catches taps/hover, so you
    // don't have to hit the ~4px stroke exactly to insert a waypoint. A coloured
    // stroke with opacity 0 still counts as "painted" for SVG pointer-events.
    const hit=L.polyline(o.latlngs,{weight:HIT_WEIGHT,opacity:0,lineCap:'round'}).addTo(routeGroup);
    hit.bindTooltip('+ insert waypoint',{sticky:true,direction:'top',opacity:1,className:'insert-tip'});
    hit.on('click',e=>{L.DomEvent.stopPropagation(e);insertOnLeg(o.leg,e.latlng);});
    hit.on('mouseover',()=>emphasizeLeg(o.leg,true));
    hit.on('mouseout',()=>emphasizeLeg(o.leg,false));
  });
}

// Two views of one leg: the polyline (map) and its list row. Hovering either
// lights both, so the user sees which path a Routed/Direct toggle will change.
function emphasizeLeg(i,on){
  const pl=legLayers.get(i);
  if(pl){pl.setStyle({weight:pl._baseWeight+(on?2.5:0)});if(on)pl.bringToFront();}
  const li=document.querySelector(`#legList li[data-leg="${i}"]`);
  if(li) li.classList.toggle('hot',on);
}

// ---- panel ----
function setStats(distM,asc){
  document.getElementById('statDist').textContent=(distM/1000).toFixed(1);
  document.getElementById('statAsc').textContent=Math.round(asc);
}
function renderLegList(){
  const ol=document.getElementById('legList');
  document.getElementById('legEmpty').style.display=waypoints.length?'none':'block';
  ol.innerHTML='';
  waypoints.forEach((w,i)=>{
    const li=document.createElement('li');
    li.dataset.leg=i;
    if(i>0){                            // row i owns the incoming leg i; light it on hover
      li.addEventListener('mouseenter',()=>emphasizeLeg(i,true));
      li.addEventListener('mouseleave',()=>emphasizeLeg(i,false));
    }
    const pin=document.createElement('span');pin.className='pin';pin.style.background=pinColor(i);
    const meta=document.createElement('div');meta.className='legmeta';
    const label=i===0?'Start':i===waypoints.length-1?'Finish':'Via '+i;
    meta.innerHTML=`<div class="n">${label}</div><div class="d">${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}</div>`;
    li.append(pin,meta);
    if(i>0){
      const t=document.createElement('button');
      const isDirect=w.mode==='direct';
      t.className='mini '+(isDirect?'direct':'route');
      t.innerHTML=`<span class="dash ${isDirect?'d':''}"></span>${isDirect?'Direct':'Routed'}`;
      t.title='Toggle how the leg into this point is drawn';
      t.onclick=()=>setLegMode(w.id,isDirect?'route':'direct');
      li.append(t);
    }
    const x=document.createElement('button');x.className='x';x.textContent='×';x.title='Remove point';
    x.onclick=()=>removePoint(w.id);
    li.append(x); ol.append(li);
  });
}
function showWarn(msg){const w=document.getElementById('warn');w.textContent=msg;w.classList.toggle('show',!!msg);}

// ---- GPX ----
function buildGpx(){
  const pts=[];
  for(let i=1;i<waypoints.length;i++){
    const a=waypoints[i-1],b=waypoints[i];
    if(b.mode==='direct'){pts.push([a.lng,a.lat],[b.lng,b.lat]);}
    else{const c=legCache.get(legKey(a,b));
         if(c)c.coords.forEach(p=>pts.push(p));else pts.push([a.lng,a.lat],[b.lng,b.lat]);}
  }
  if(pts.length<2) return null;
  const seg=pts.map(p=>`<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    +`<gpx version="1.1" creator="Topo Route Planner" xmlns="http://www.topografix.com/GPX/1/1">`
    +`<trk><name>topo-route</name><trkseg>${seg}</trkseg></trk></gpx>`;
}
const GPX_TYPE='application/gpx+xml';
function exportGpx(){
  const gpx=buildGpx();
  if(!gpx){showWarn('Nothing to export yet.');return;}
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([gpx],{type:GPX_TYPE}));
  a.download='topo-route.gpx';a.click();URL.revokeObjectURL(a.href);
}
// Web Share (mobile): hand the .gpx file to the OS share sheet so it can go
// straight to Garmin Connect / any app — no download→upload. Two things matter
// on iOS: (1) the standard application/gpx+xml MIME, which resolves to the GPX
// UTI (com.topografix.gpx) that Garmin's share extension activates for — a
// generic MIME like octet-stream resolves to public.data and Garmin won't show;
// (2) share ONLY the file — a title/text payload becomes a second shared item
// and hides file-only targets like Garmin. Falls back to a download if unsupported.
async function shareGpx(){
  const gpx=buildGpx();
  if(!gpx){showWarn('Nothing to share yet.');return;}
  const file=new File([gpx],'topo-route.gpx',{type:GPX_TYPE});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file]}); }
    catch(err){ if(err && err.name!=='AbortError') exportGpx(); }   // ignore user-cancel; else download
  }else exportGpx();
}

// ---- wiring ----
document.getElementById('modeSeg').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  addMode=b.dataset.mode;
  [...e.currentTarget.children].forEach(c=>c.classList.toggle('on',c===b));
  document.getElementById('modeflag').innerHTML=
    addMode==='route'?'Adding <b class="r">routed</b> points':'Adding <b class="d">direct</b> points';
});
document.getElementById('basesw').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  map.removeLayer(topo);map.removeLayer(aerial);
  (b.dataset.base==='topo'?topo:aerial).addTo(map);
  [...e.currentTarget.children].forEach(c=>c.classList.toggle('on',c===b));
});
document.getElementById('profile').addEventListener('change',e=>{profile=e.target.value;legCache.clear();recompute();});
document.getElementById('endpoint').addEventListener('change',e=>{endpoint=e.target.value.trim();legCache.clear();recompute();});
document.getElementById('btnUndo').onclick=()=>{if(waypoints.length){waypoints.pop();syncMarkers();recompute();}};
document.getElementById('btnClear').onclick=()=>{waypoints=[];legCache.clear();syncMarkers();recompute();};
document.getElementById('btnGpx').onclick=exportGpx;
const btnShare=document.getElementById('btnShare');
btnShare.onclick=shareGpx;
// reveal "Send to phone" only where the browser can share files (mostly mobile)
try{
  const probe=new File(['x'],'probe.gpx',{type:GPX_TYPE});
  if(navigator.canShare && navigator.canShare({files:[probe]})) btnShare.hidden=false;
}catch(_){/* unsupported → stays hidden, Export GPX still works */}
renderOverlayList();
