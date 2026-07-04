/* swisstopo raster (EPSG:3857 XYZ) base + BRouter router.
   State: ordered waypoints; each carries `mode` for the leg leading INTO it
   ('route'|'direct'). Route is built per-leg, so direct legs never hit the
   router — that's how a path missing from OSM but visible on topo enters the track.
   Leaflet uses [lat,lng]; BRouter/GPX use [lng,lat]. Conversions are explicit. */

const TILE = id => `https://wmts.geo.admin.ch/1.0.0/${id}/default/current/3857/{z}/{x}/{y}.jpeg`;
const topo   = L.tileLayer(TILE('ch.swisstopo.pixelkarte-farbe'),{maxZoom:19,maxNativeZoom:18,attribution:'© swisstopo'});
const aerial = L.tileLayer(TILE('ch.swisstopo.swissimage'),      {maxZoom:19,maxNativeZoom:19,attribution:'© swisstopo'});

const map = L.map('map',{center:[47.376,8.541],zoom:13,maxZoom:19,layers:[topo]});
const routeGroup = L.layerGroup().addTo(map);
setTimeout(()=>map.invalidateSize(),200);

// Safety net: if swisstopo tiles are blocked in this context (referrer/hotlink
// protection on a sandboxed origin), swap the base to OpenTopoMap once, with a note.
const fallback=L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  {maxZoom:17,attribution:'© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors'});
let swissBlocked=false, topoErrs=0;
topo.on('tileerror',()=>{
  if(swissBlocked || ++topoErrs<3) return;
  swissBlocked=true;
  if(map.hasLayer(topo)) map.removeLayer(topo);
  fallback.addTo(map);
  showWarn('swisstopo tiles didn\u2019t load in this preview \u2014 almost certainly referrer/hotlink protection on the sandbox origin, not a bug in the endpoint. Showing OpenTopoMap as a stand-in. In a normal browser or your own deployment the swisstopo Landeskarte loads fine.');
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

async function recompute(){
  const my=++gen;
  renderLegList();
  if(waypoints.length<2){setRoute([]);setStats(0,0);showWarn('');return;}
  const legs=[]; let dist=0,asc=0,failed=false;
  for(let i=1;i<waypoints.length;i++){
    const a=waypoints[i-1],b=waypoints[i],mode=b.mode;
    if(mode==='direct'){
      legs.push({mode:'direct',leg:i,latlngs:[[a.lat,a.lng],[b.lat,b.lng]]});
      dist+=haversine([a.lng,a.lat],[b.lng,b.lat]);
    }else{
      try{
        const r=await fetchLeg(a,b); if(my!==gen)return;
        legs.push({mode:'route',leg:i,latlngs:r.coords.map(toLatLng)});
        asc+=r.ascend;
        for(let k=1;k<r.coords.length;k++) dist+=haversine(r.coords[k-1],r.coords[k]);
      }catch(err){
        failed=true;
        legs.push({mode:'error',leg:i,latlngs:[[a.lat,a.lng],[b.lat,b.lng]]});
        dist+=haversine([a.lng,a.lat],[b.lng,b.lat]);
      }
    }
  }
  if(my!==gen)return;
  setRoute(legs); setStats(dist,asc);
  showWarn(failed
    ? 'A routed leg failed — shown dashed red. On the public endpoint this is usually CORS; point the field at your own BRouter instance. Direct legs still work.'
    : '');
}

function setRoute(legs){
  routeGroup.clearLayers();
  legLayers.clear();
  legs.forEach(o=>{
    const base = o.mode==='route'  ? {color:getCss('--route'),weight:4.5,opacity:.9}
              : o.mode==='direct' ? {color:getCss('--direct'),weight:4,opacity:.95,dashArray:'6,7'}
              :                      {color:getCss('--error'),weight:3,opacity:.9,dashArray:'4,6'};
    const pl=L.polyline(o.latlngs,base).addTo(routeGroup);
    pl._baseWeight=base.weight;
    legLayers.set(o.leg,pl);
    pl.bindTooltip('+ insert waypoint',{sticky:true,direction:'top',opacity:1,className:'insert-tip'});
    pl.on('click',e=>{L.DomEvent.stopPropagation(e);insertOnLeg(o.leg,e.latlng);});
    pl.on('mouseover',()=>emphasizeLeg(o.leg,true));
    pl.on('mouseout',()=>emphasizeLeg(o.leg,false));
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
function exportGpx(){
  const pts=[];
  for(let i=1;i<waypoints.length;i++){
    const a=waypoints[i-1],b=waypoints[i];
    if(b.mode==='direct'){pts.push([a.lng,a.lat],[b.lng,b.lat]);}
    else{const c=legCache.get(legKey(a,b));
         if(c)c.coords.forEach(p=>pts.push(p));else pts.push([a.lng,a.lat],[b.lng,b.lat]);}
  }
  if(pts.length<2){showWarn('Nothing to export yet.');return;}
  const seg=pts.map(p=>`<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"/>`).join('');
  const gpx=`<?xml version="1.0" encoding="UTF-8"?>\n`
    +`<gpx version="1.1" creator="Topo Route Planner" xmlns="http://www.topografix.com/GPX/1/1">`
    +`<trk><name>topo-route</name><trkseg>${seg}</trkseg></trk></gpx>`;
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([gpx],{type:'application/gpx+xml'}));
  a.download='topo-route.gpx';a.click();URL.revokeObjectURL(a.href);
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
  map.removeLayer(topo);map.removeLayer(aerial);map.removeLayer(fallback);
  if(b.dataset.base==='topo'){(swissBlocked?fallback:topo).addTo(map);}
  else{aerial.addTo(map);}
  [...e.currentTarget.children].forEach(c=>c.classList.toggle('on',c===b));
});
document.getElementById('profile').addEventListener('change',e=>{profile=e.target.value;legCache.clear();recompute();});
document.getElementById('endpoint').addEventListener('change',e=>{endpoint=e.target.value.trim();legCache.clear();recompute();});
document.getElementById('btnUndo').onclick=()=>{if(waypoints.length){waypoints.pop();syncMarkers();recompute();}};
document.getElementById('btnClear').onclick=()=>{waypoints=[];legCache.clear();syncMarkers();recompute();};
document.getElementById('btnGpx').onclick=exportGpx;
