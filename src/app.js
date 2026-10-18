/* Official national topo raster + BRouter router, for more than one country.
   A *region* bundles everything country-specific: the CRS the map renders in,
   its base/overlay rasters, its point-identify service and its DEM. Switzerland
   renders in the true Swiss projection (LV95, via proj4) so it matches the
   printed Landeskarte grid; Austria's BEV/basemap.at rasters are published on
   the standard Web-Mercator XYZ grid, so that region uses Leaflet's default CRS.
   Leaflet can't change CRS on a live map, so switching region tears the map down
   and rebuilds it — the waypoints (plain WGS84) survive untouched.
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

// --- raster sources -------------------------------------------------------
// swisstopo WMTS, LV95 tile grid.
const swissRaster=(id,ext,opts)=>L.tileLayer(
  `https://wmts.geo.admin.ch/1.0.0/${id}/default/current/2056/{z}/{x}/{y}.${ext}`,
  {maxZoom:28,maxNativeZoom:27,attribution:'© swisstopo',...opts});
// BEV "Austrian Map" (ÖK) raster — plain XYZ, published up to z16.
const bevRaster=()=>L.tileLayer('https://maps.bev.gv.at/tiles/karte/{z}/{x}/{y}.png',
  {maxZoom:19,maxNativeZoom:16,attribution:'© BEV'});
// basemap.at (Verwaltungsgrundkarte). Same Web-Mercator grid but the WMTS
// template is {TileMatrix}/{TileRow}/{TileCol} — i.e. z/y/x, not z/x/y. Three
// interchangeable hosts, so spread the load with Leaflet's {s} placeholder.
const basemapAt=(layer,style,ext,opts)=>L.tileLayer(
  `https://maps{s}.wien.gv.at/basemap/${layer}/${style}/google3857/{z}/{y}/{x}.${ext}`,
  {subdomains:['','1','2'],maxZoom:19,maxNativeZoom:19,
   attribution:'© <a href="https://basemap.at">basemap.at</a> (CC BY 4.0)',...opts});

// --- regions --------------------------------------------------------------
// One entry per country. Adding another national topo service is one object:
// give it a CRS, its rasters, and DEM/identify adapters with these signatures.
//   ascent(a,b)    -> Promise<metres climbed on the straight line a→b>
//   profile(flat)  -> Promise<[{d,e}]>  (d = metres along route, e = altitude)
//   identify(ll)   -> Promise<HTML string for the popup>
const REGIONS={
  ch:{
    id:'ch', label:'Switzerland',
    crs:swissCRS, center:[47.376,8.541], zoom:19, minZoom:8, maxZoom:28,
    bases:[
      {key:'topo',   label:'Topo',   make:()=>swissRaster('ch.swisstopo.pixelkarte-farbe','jpeg')},
      {key:'aerial', label:'Aerial', make:()=>swissRaster('ch.swisstopo.swissimage','jpeg',{maxNativeZoom:28})},
    ],
    // Thematic overlays (transparent PNG on the same grid). Higher zIndex than
    // the base but still in tilePane, so they sit above the map yet below the
    // route (overlayPane) and markers (markerPane). Add a layer = one line here.
    overlays:[
      {id:'ch.astra.veloland',         label:'Cycling routes (Veloland)'},
      {id:'ch.astra.mountainbikeland', label:'Mountain-bike routes'},
      {id:'ch.bav.haltestellen-oev',   label:'Public transport stops'},
    ],
    makeOverlay:id=>swissRaster(id,'png',{zIndex:10}),
    overlayTitle:'swisstopo overlays',
    subtitle:'Swiss topo base (swisstopo)',
    note:'Landeskarte + swissAlti3D elevation from swisstopo, in the native Swiss grid (LV95). '
        +'BRouter needs the E5_N45 segment file for Switzerland.',
    identifyHint:'identify what’s on the map', demLabel:'swisstopo swissAlti3D DEM',
    tileWarn:'swisstopo tiles didn’t load in this preview — almost certainly referrer/hotlink protection on the sandbox origin, not a bug in the endpoint. In a normal browser or your own deployment the swisstopo Landeskarte loads fine.',
    identifyError:'Couldn’t reach the swisstopo identify service.',
    ascent:swissAscent, profile:swissProfile, identify:swissIdentify,
  },
  at:{
    id:'at', label:'Austria',
    crs:L.CRS.EPSG3857, center:[47.241,14.1525], zoom:14, minZoom:7, maxZoom:19,
    bases:[
      {key:'topo',    label:'Topo',    make:bevRaster},
      {key:'aerial',  label:'Aerial',  make:()=>basemapAt('bmaporthofoto30cm','normal','jpeg')},
      {key:'terrain', label:'Terrain', make:()=>basemapAt('bmapgelaende','grau','jpeg')},
    ],
    overlays:[
      {id:'bmapoverlay', label:'Labels & boundaries'},
    ],
    makeOverlay:id=>basemapAt(id,'normal','png',{zIndex:10}),
    overlayTitle:'basemap.at overlays',
    subtitle:'Austrian topo base (BEV)',
    note:'Austrian Map (ÖK) raster + DEM elevation from BEV, orthophoto and relief from basemap.at. '
        +'The ÖK raster is published to zoom 16 and is upscaled beyond that. '
        +'BRouter needs the E5_N45, E10_N45 and E15_N45 segment files for Austria.',
    identifyHint:'read the BEV terrain height', demLabel:'BEV DEM',
    tileWarn:'BEV / basemap.at tiles didn’t load in this preview — almost certainly a sandboxed origin blocking third-party images, not a bug in the endpoint. In a normal browser or your own deployment the Austrian Map loads fine.',
    identifyError:'Couldn’t reach the BEV height service.',
    ascent:austrianAscent, profile:austrianProfile, identify:austrianIdentify,
  },
};
const DEFAULT_REGION='ch';

// --- map lifecycle --------------------------------------------------------
let region, map, routeGroup;
const baseLayers=new Map();      // base key -> L.tileLayer for the current region
const overlayLayers=new Map();   // overlay id -> L.tileLayer (created lazily on first enable)

// Ground metres per pixel at `center`, for any CRS at an integer zoom. Zoom
// numbers mean nothing across regions — the Swiss grid's resolutions aren't
// powers of two — so scale is compared in metres/px, which is CRS-agnostic.
function resolutionAt(crs,center,zoom){
  const east=L.latLng(center.lat,center.lng+0.01);
  const px=crs.latLngToPoint(center,zoom).distanceTo(crs.latLngToPoint(east,zoom));
  return px>0?haversine([center.lng,center.lat],[east.lng,east.lat])/px:Infinity;
}
// The zoom level of `crs` whose scale sits closest to `res` — compared as a
// ratio (log), so being 30% too coarse loses to being 20% too fine regardless
// of how big the numbers are.
function zoomMatchingResolution(crs,center,res,minZoom,maxZoom){
  let best=minZoom,bestErr=Infinity;
  for(let z=minZoom;z<=maxZoom;z++){
    const err=Math.abs(Math.log(resolutionAt(crs,center,z)/res));
    if(err<bestErr){bestErr=err;best=z;}
  }
  return best;
}

// `view` (optional) carries the previous map's centre and scale, so a region
// switch lands on the same ground instead of jumping to the new region's home.
function buildMap(view){
  const center=view?view.center:L.latLng(region.center);
  const zoom=view
    ? zoomMatchingResolution(region.crs,center,view.res,region.minZoom,region.maxZoom)
    : region.zoom;
  map=L.map('map',{crs:region.crs,center,zoom,
    minZoom:region.minZoom,maxZoom:region.maxZoom});
  baseLayers.clear(); overlayLayers.clear();
  region.bases.forEach((b,i)=>{
    const layer=b.make();
    baseLayers.set(b.key,layer);
    if(i===0) layer.addTo(map);
  });
  // Safety net: if the national tiles are blocked in this context (referrer /
  // hotlink protection on a sandboxed origin), warn once. There's no raster
  // fallback — a Web-Mercator substitute couldn't align with the Swiss grid —
  // but a real deployment loads the official rasters fine.
  let blocked=false, errs=0;
  baseLayers.get(region.bases[0].key).on('tileerror',()=>{
    if(blocked || ++errs<3) return;
    blocked=true; showWarn(region.tileWarn);
  });
  routeGroup=L.layerGroup().addTo(map);
  map.on('click',e=>addPoint(e.latlng.lng,e.latlng.lat));
  // Left-click adds waypoints, so identify rides on contextmenu (fired by both
  // right-click and touch long-press).
  map.on('contextmenu',e=>{L.DomEvent.preventDefault(e.originalEvent);identifyAt(e.latlng);});
}

// Rebuild the map in another country's projection. Waypoints are WGS84 and stay
// as they are; anything derived from the old country's DEM is dropped. The view
// carries over — swapping the projection under the same patch of ground is the
// point (comparing the two national maps over one valley), so it must not jump.
function setRegion(id){
  if(!REGIONS[id] || (region && region.id===id)) return;
  const view=map&&{center:map.getCenter(),
                   res:resolutionAt(map.options.crs,map.getCenter(),map.getZoom())};
  region=REGIONS[id];
  gen++;                                        // strand any in-flight elevation work
  directCache.clear(); profileCache.clear();    // a different national DEM answers now
  markers.clear(); legLayers.clear();
  profileMarker=null;                           // lived on the map we're about to destroy
  if(map) map.remove();
  buildMap(view);
  renderBaseSwitch(); renderOverlayList(); renderRegionSwitch(); applyRegionChrome();
  try{ localStorage.setItem('region',id); }catch(_){}
  syncMarkers(); recompute();
  requestAnimationFrame(()=>map.invalidateSize());
}

function toggleOverlay(id,on){
  if(on){
    if(!overlayLayers.has(id)) overlayLayers.set(id,region.makeOverlay(id));
    overlayLayers.get(id).addTo(map);
  }else if(overlayLayers.has(id)){
    map.removeLayer(overlayLayers.get(id));
  }
}
function renderOverlayList(){
  const box=document.getElementById('overlayList');
  box.innerHTML='';
  region.overlays.forEach(o=>{
    const lab=document.createElement('label');
    const cb=document.createElement('input');cb.type='checkbox';
    cb.addEventListener('change',()=>toggleOverlay(o.id,cb.checked));
    const span=document.createElement('span');span.textContent=o.label;
    lab.append(cb,span); box.append(lab);
  });
}
function renderBaseSwitch(){
  const box=document.getElementById('basesw');
  box.innerHTML='';
  region.bases.forEach((b,i)=>{
    const btn=document.createElement('button');
    btn.dataset.base=b.key; btn.textContent=b.label;
    if(i===0) btn.classList.add('on');
    box.append(btn);
  });
}
function renderRegionSwitch(){
  const box=document.getElementById('regionSeg');
  box.innerHTML='';
  for(const r of Object.values(REGIONS)){
    const btn=document.createElement('button');
    btn.dataset.region=r.id; btn.textContent=r.label;
    if(r.id===region.id) btn.classList.add('on');
    box.append(btn);
  }
}
function applyRegionChrome(){
  document.getElementById('subtitle').innerHTML=
    `${region.subtitle} · <b>routed</b> legs follow OSM via BRouter · <i>direct</i> legs `
    +`trace paths by hand for trails OSM is missing.`;
  document.getElementById('regionNote').textContent=region.note;
  document.getElementById('overlayTitle').textContent=region.overlayTitle;
  document.getElementById('identifyHint').textContent=region.identifyHint;
  document.getElementById('ascentNote').textContent=region.demLabel;
}

// ---- feature identify (right-click / long-press) ----
// What a point can tell you differs per country: Switzerland has a real
// multi-layer identify service, Austria publishes a DEM point query. Both
// resolve to popup HTML, so the interaction is identical either way.
async function identifyAt(latlng){
  const pop=L.popup({className:'id-pop',maxWidth:260,autoPan:false})
    .setLatLng(latlng).setContent('Identifying…').openOn(map);
  const target=region;
  try{
    const html=await target.identify(latlng);
    if(region===target) pop.setContent(html);
  }catch(_){ pop.setContent(target.identifyError); }
}
const featLabel=a=>(a&&(a.name||a.label||a.bezeichnung||a.gemname))||'';
const escapeHtml=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const idRow=(layer,value)=>`<div class="id-row"><span class="id-layer">${escapeHtml(layer)}</span>${value}</div>`;

// Switzerland: queries the enabled overlays plus place names, so it always
// returns something useful. swisstopo identify is LV95-native.
const IDENTIFY_API='https://api3.geo.admin.ch/rest/services/all/MapServer/identify';
const IDENTIFY_EXTRA=['ch.swisstopo.swissnames3d'];   // place-name context, always on
async function swissIdentify(latlng){
  const active=region.overlays.filter(o=>overlayLayers.has(o.id)&&map.hasLayer(overlayLayers.get(o.id))).map(o=>o.id);
  const layers=[...active,...IDENTIFY_EXTRA];
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
  return identifyHtml(data.results||[]);
}
// SchweizMobil route pages, buildable from the identify attribute chmobil_route_number.
const SCHWEIZMOBIL={'ch.astra.veloland':'cycling-in-switzerland',
                    'ch.astra.mountainbikeland':'mountainbiking-in-switzerland'};
function schweizmobilUrl(r){
  const path=SCHWEIZMOBIL[r.layerBodId];
  const n=r.attributes&&Number(r.attributes.chmobil_route_number);   // numeric → safe href
  return (path&&Number.isFinite(n))?`https://schweizmobil.ch/en/${path}/route-${n}`:null;
}
function identifyHtml(results){
  if(!results.length) return 'Nothing to identify here.';
  const seen=new Set(), rows=[];
  for(const r of results){
    const name=featLabel(r.attributes)||'(unnamed)';
    const key=(r.layerBodId||'')+'|'+name;
    if(seen.has(key)) continue; seen.add(key);
    const url=schweizmobilUrl(r);
    const nameHtml=url
      ? `<a class="id-link" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)} ↗</a>`
      : escapeHtml(name);
    rows.push(idRow(r.layerName||r.layerBodId||'',nameHtml));
    if(rows.length>=6) break;
  }
  return `<div class="id-list">${rows.join('')}</div>`;
}

// Austria: BEV publishes no multi-layer identify, but it does expose a DEM
// point query — so a long-press answers "how high am I here?" instead.
async function austrianIdentify(latlng){
  const url=`${BEV_HEIGHT}singleHeight?`
    +new URLSearchParams({point:`${latlng.lng.toFixed(6)},${latlng.lat.toFixed(6)}`});
  const res=await fetch(url,{headers:{Accept:'application/json'}});
  if(!res.ok) throw new Error('singleHeight '+res.status);
  const d=await res.json();
  // The service answers 0 rather than erroring outside its coverage.
  const h=Number(d&&d.height);
  return `<div class="id-list">`
    +idRow('Elevation (BEV DEM)',Number.isFinite(h)&&h!==0?escapeHtml(h.toFixed(1))+' m':'no data here')
    +idRow('Coordinates',escapeHtml(`${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`))
    +`</div>`;
}

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

// ---- URL bookmarking ----
// The whole route reduces to region + waypoints (lat,lng,mode) + routing profile;
// every other bit of state recomputes from those. We keep that in the URL *hash*
// (not query params) so it never hits a server — no length ceiling for bookmarks,
// and coordinates stay out of request logs. 5 decimals ≈ 1 m, finer than the map
// needs. The hash is rewritten (replaceState, no history spam) on every recompute,
// so the address bar / any bookmark always reflects the current route. The default
// region is left implicit, which keeps links made before regions existed valid.
function serializeState(){
  if(!waypoints.length) return '';
  const w=waypoints.map(p=>`${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.mode==='direct'?'d':'r'}`).join(';');
  const r=region.id===DEFAULT_REGION?'':`r=${region.id}&`;
  return `#${r}p=${encodeURIComponent(profile)}&w=${w}`;
}
function syncUrl(){
  const h=serializeState();
  history.replaceState(null,'',h||location.pathname+location.search);
}
function parseState(hash){
  const h=(hash||'').replace(/^#/,'');
  if(!h) return null;
  const params=new URLSearchParams(h);
  const wps=[];
  // `w` is optional: `#r=at` alone is a valid "open the Austrian map" link.
  for(const tok of (params.get('w')||'').split(';')){
    const [lat,lng,m]=tok.split(',');
    const la=parseFloat(lat),ln=parseFloat(lng);
    if(!Number.isFinite(la)||!Number.isFinite(ln)) continue;
    wps.push({id:uid(),lat:la,lng:ln,mode:m==='d'?'direct':'route'});
  }
  return {region:params.get('r'),profile:params.get('p'),waypoints:wps};
}
// Booting recomputes an empty route, and that rewrites the hash — so the link
// we were opened with has to be captured before anything touches it.
const INITIAL_HASH=location.hash;
// The region decides the map's CRS, so it has to be known *before* the map is
// built — read it straight from the hash, else the last one used.
function initialRegionId(){
  const st=parseState(INITIAL_HASH);
  if(st&&st.region&&REGIONS[st.region]) return st.region;
  if(st&&st.waypoints.length) return DEFAULT_REGION;   // pre-region link
  try{ const s=localStorage.getItem('region'); if(s&&REGIONS[s]) return s; }catch(_){}
  return DEFAULT_REGION;
}
function loadFromUrl(){
  const st=parseState(INITIAL_HASH);
  if(!st||!st.waypoints.length) return;
  if(st.profile){                                  // only adopt a profile the UI offers
    const sel=document.getElementById('profile');
    if([...sel.options].some(o=>o.value===st.profile)){ sel.value=st.profile; profile=st.profile; }
  }
  waypoints=st.waypoints;
  syncMarkers();
  recompute();
  try{ map.fitBounds(L.latLngBounds(waypoints.map(w=>[w.lat,w.lng])),{padding:[40,40],maxZoom:18}); }
  catch(_){/* degenerate bounds (single point / not yet sized) — leave the view as-is */}
}

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

// ---- elevation ----
// Routed legs get ascent from BRouter; hand-drawn direct legs and the whole-route
// profile are sampled from the region's national DEM. Both caches are keyed by
// region, because the same line has a different answer in each country's model.
const directCache=new Map();    // region|directKey -> ascend metres
const profileCache=new Map();   // region|route signature -> [{d,e}]
const directKey=(a,b)=>`${a.lng.toFixed(6)},${a.lat.toFixed(6)}|${b.lng.toFixed(6)},${b.lat.toFixed(6)}`;
async function fetchDirectAscend(a,b){
  const key=`${region.id}|${directKey(a,b)}`;
  if(directCache.has(key)) return directCache.get(key);
  const asc=await region.ascent(a,b);   // failures throw, so they're never cached
  directCache.set(key,asc); return asc;
}
function downsample(arr,max){
  if(arr.length<=max) return arr.slice();
  const step=(arr.length-1)/(max-1), out=[];
  for(let i=0;i<max;i++) out.push(arr[Math.round(i*step)]);
  return out;
}

// Switzerland — swissAlti3D via the swisstopo profile service. WGS84->LV95 uses
// swisstopo's approximate formula (sub-metre over CH, so no proj4 dependency).
const SWISS_PROFILE_API='https://api3.geo.admin.ch/rest/services/profile.json';
function wgs84ToLv95(lng,lat){
  const p=(lat*3600-169028.66)/10000, l=(lng*3600-26782.5)/10000;
  const E=2600072.37+211455.93*l-10938.51*l*p-0.36*l*p*p-44.54*l*l*l;
  const N=1200147.07+308807.95*p+3745.25*l*l+76.63*p*p-194.56*l*l*p+119.79*p*p*p;
  return [E,N];
}
async function swissAscent(a,b){
  const dist=haversine([a.lng,a.lat],[b.lng,b.lat]);
  const n=Math.max(2,Math.min(200,Math.round(dist/50)));   // ~1 sample / 50 m
  const geom=JSON.stringify({type:'LineString',
    coordinates:[wgs84ToLv95(a.lng,a.lat),wgs84ToLv95(b.lng,b.lat)]});
  const res=await fetch(`${SWISS_PROFILE_API}?geom=${encodeURIComponent(geom)}&sr=2056&nbPoints=${n}`);
  if(!res.ok) throw new Error('height '+res.status);
  const pts=await res.json();
  let asc=0;
  for(let k=1;k<pts.length;k++){const d=pts[k].alts.COMB-pts[k-1].alts.COMB;if(d>0)asc+=d;}
  return asc;
}
// POSTed so the full route geometry fits in the request.
async function swissProfile(flat){   // flat: [[lat,lng]...]
  const coords=downsample(flat,350).map(([lat,lng])=>wgs84ToLv95(lng,lat));
  const body=new URLSearchParams({
    geom:JSON.stringify({type:'LineString',coordinates:coords}), sr:'2056', nbPoints:'150'});
  const res=await fetch(SWISS_PROFILE_API,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!res.ok) throw new Error('profile '+res.status);
  return (await res.json()).map(p=>({d:p.dist,e:p.alts.COMB}));
}

// Austria — BEV's transformator height API. It takes WGS84 lon/lat directly,
// resamples the polyline into `steps` even intervals, and hands back both the
// altitudes and the points it used (but no per-point distance).
const BEV_HEIGHT='https://transformator.bev.gv.at/at.gv.bev.transformator/api/height/';
async function bevHeightProfile(lonlats,steps){
  const res=await fetch(`${BEV_HEIGHT}heightProfile`,{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({point_list:lonlats,steps,concrete:true})});
  if(!res.ok) throw new Error('BEV height '+res.status);
  const d=await res.json();
  if(!d||!Array.isArray(d.heights)||d.heights.length<2) throw new Error('BEV height: empty');
  // Outside the Austrian DEM every sample comes back as 0 instead of an error —
  // treat that as "no data" so a route abroad can't report a confident flat 0 m.
  if(d.heights.every(h=>h===0)) throw new Error('BEV height: outside coverage');
  return d;
}
async function austrianAscent(a,b){
  const dist=haversine([a.lng,a.lat],[b.lng,b.lat]);
  const steps=Math.max(2,Math.min(200,Math.round(dist/50)));   // ~1 sample / 50 m
  const d=await bevHeightProfile([[a.lng,a.lat],[b.lng,b.lat]],steps);
  return Math.max(0,Number((d.stats||{}).sumUps)||0);
}
async function austrianProfile(flat){   // flat: [[lat,lng]...]
  const pts=downsample(flat,120).map(([lat,lng])=>[lng,lat]);
  const d=await bevHeightProfile(pts,150);
  // No per-point distance in the response, so the chart's x axis is cumulative
  // haversine over the points it echoed back; if it echoed none, fall back to
  // spreading the reported total length evenly (the samples are equidistant).
  const echoed=Array.isArray(d.point_list)&&d.point_list.length===d.heights.length?d.point_list:null;
  const total=Number((d.stats||{}).dist)||0;
  let acc=0;
  return d.heights.map((e,i)=>{
    if(echoed&&i>0) acc+=haversine(echoed[i-1],echoed[i]);
    return {d:echoed?acc:(total*i)/(d.heights.length-1), e};
  });
}

// ---- whole-route elevation profile ----
// One national-DEM profile for the entire route (routed + direct legs).
// Best-effort and cached; the ascent stat is unchanged.
const STEEP_GRADE=0.18;         // rise/run above which an *ascent* is flagged on the profile
let profileMarker=null;
// The profile is keyed by the line actually drawn, not by the waypoints: the same
// waypoints give a different line under another BRouter profile or endpoint, and
// a leg that failed (straight fallback) and later routes changes it too. A short
// FNV-1a hash of the 5-decimal coordinates keeps the key compact for long routes.
function lineSig(flat){
  let h=0x811c9dc5;
  for(const [lat,lng] of flat){
    const s=`${lat.toFixed(5)},${lng.toFixed(5)};`;
    for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193); }
  }
  return `${flat.length}:${(h>>>0).toString(36)}`;
}
async function updateProfile(legs,my){
  const flat=[];                         // one deduped line through all legs
  for(const o of legs) for(const ll of o.latlngs){
    const last=flat[flat.length-1];
    if(!last||last[0]!==ll[0]||last[1]!==ll[1]) flat.push(ll);
  }
  if(flat.length<2){renderProfile(null);return;}
  const sig=`${region.id}|${lineSig(flat)}`;
  let prof=profileCache.get(sig);
  if(!prof){
    try{ prof=await region.profile(flat); }
    catch(_){ if(my===gen) renderProfile(null); return; }   // don't leave the previous route's chart up
    if(my!==gen)return;
    profileCache.set(sig,prof);
  }
  if(my!==gen)return;
  renderProfile(prof,flat);
}
function renderProfile(prof,flat){
  const grp=document.getElementById('profileGrp'), box=document.getElementById('profChart');
  if(!prof||prof.length<2){grp.style.display='none';box.innerHTML='';clearProfileMarker();return;}
  grp.style.display='';
  const W=300,H=88, dMax=prof[prof.length-1].d||1;
  const es=prof.map(p=>p.e), eMin=Math.min(...es), eMax=Math.max(...es), eRange=Math.max(1,eMax-eMin);
  const X=d=>(d/dMax)*W, Y=e=>H-3-((e-eMin)/eRange)*(H-6);
  const line=prof.map(p=>`${X(p.d).toFixed(1)},${Y(p.e).toFixed(1)}`).join(' ');
  // Flag ascents steeper than STEEP_GRADE: collect contiguous runs of segments
  // whose rise/run exceeds the threshold and overlay them in the warning colour,
  // and tally their length so the meta line can call out how much steep climbing
  // the route holds. Descents never count — this marks *ascents*.
  const steepRuns=[]; let run=null, steepDist=0;
  for(let i=1;i<prof.length;i++){
    const dd=prof[i].d-prof[i-1].d;
    const grade=dd>0?(prof[i].e-prof[i-1].e)/dd:0;
    if(grade>STEEP_GRADE){
      steepDist+=dd;
      if(!run) run=[`${X(prof[i-1].d).toFixed(1)},${Y(prof[i-1].e).toFixed(1)}`];
      run.push(`${X(prof[i].d).toFixed(1)},${Y(prof[i].e).toFixed(1)}`);
    }else if(run){steepRuns.push(run);run=null;}
  }
  if(run) steepRuns.push(run);
  const steepOverlay=steepRuns.map(r=>`<polyline class="prof-steep" points="${r.join(' ')}"/>`).join('');
  const steepBadge = steepDist>0
    ? `<span class="prof-steep-lbl" title="ascent steeper than ${Math.round(STEEP_GRADE*100)}%">`
      +`⚠ ${steepDist<1000?Math.round(steepDist)+' m':(steepDist/1000).toFixed(1)+' km'} ≥${Math.round(STEEP_GRADE*100)}%</span>`
    : '';
  box.innerHTML=
    `<svg id="profSvg" class="prof" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    +`<polygon class="prof-area" points="0,${H} ${line} ${W},${H}"/>`
    +`<polyline class="prof-line" points="${line}"/>`
    +steepOverlay
    +`<line id="profCross" class="prof-cross" x1="0" y1="0" x2="0" y2="${H}" style="display:none"/></svg>`
    +`<div class="prof-meta"><span id="profRead">${Math.round(eMin)}–${Math.round(eMax)} m</span>`
    +steepBadge
    +`<span>${(dMax/1000).toFixed(1)} km</span></div>`;
  // hover the chart → readout + a marker on the map at that distance
  const svg=document.getElementById('profSvg'),cross=document.getElementById('profCross'),read=document.getElementById('profRead');
  const cum=[0];
  for(let i=1;i<flat.length;i++) cum.push(cum[i-1]+haversine([flat[i-1][1],flat[i-1][0]],[flat[i][1],flat[i][0]]));
  const total=cum[cum.length-1]||1;
  svg.addEventListener('mousemove',ev=>{
    const r=svg.getBoundingClientRect(), fx=Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width));
    const p=prof[Math.round(fx*(prof.length-1))];
    cross.style.display=''; cross.setAttribute('x1',(fx*W).toFixed(1)); cross.setAttribute('x2',(fx*W).toFixed(1));
    read.textContent=`${Math.round(p.e)} m · ${(p.d/1000).toFixed(1)} km`;
    const dd=fx*total; let i=1; while(i<cum.length&&cum[i]<dd) i++;
    const t=(dd-cum[i-1])/Math.max(1e-6,cum[i]-cum[i-1]), a=flat[i-1], b=flat[Math.min(i,flat.length-1)];
    setProfileMarker(a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t);
  });
  svg.addEventListener('mouseleave',()=>{cross.style.display='none';
    read.textContent=`${Math.round(eMin)}–${Math.round(eMax)} m`;clearProfileMarker();});
}
function setProfileMarker(lat,lng){
  if(!profileMarker) profileMarker=L.circleMarker([lat,lng],
    {radius:6,color:'#fff',weight:2,fillColor:getCss('--alpine'),fillOpacity:1,interactive:false}).addTo(map);
  else profileMarker.setLatLng([lat,lng]);
}
function clearProfileMarker(){ if(profileMarker){map.removeLayer(profileMarker);profileMarker=null;} }

async function recompute(){
  const my=++gen;
  renderLegList();
  syncUrl();                 // keep the bookmarkable hash in step with every edit
  if(waypoints.length<2){setRoute([]);setStats(0,0);showWarn('');renderProfile(null);return;}
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
  updateProfile(legs,my);   // best-effort, gen-guarded; renders once elevation arrives
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
  const km=(distM/1000).toFixed(1), m=String(Math.round(asc));
  document.getElementById('statDist').textContent=km;
  document.getElementById('statAsc').textContent=m;
  document.getElementById('statDistMin').textContent=km;   // mirror into the minimized readout
  document.getElementById('statAscMin').textContent=m;
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
document.getElementById('regionSeg').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  setRegion(b.dataset.region);
});
document.getElementById('modeSeg').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  addMode=b.dataset.mode;
  [...e.currentTarget.children].forEach(c=>c.classList.toggle('on',c===b));
  document.getElementById('modeflag').innerHTML=
    addMode==='route'?'Adding <b class="r">routed</b> points':'Adding <b class="d">direct</b> points';
});
document.getElementById('basesw').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  for(const l of baseLayers.values()) map.removeLayer(l);
  baseLayers.get(b.dataset.base).addTo(map);
  [...e.currentTarget.children].forEach(c=>c.classList.toggle('on',c===b));
});
document.getElementById('profile').addEventListener('change',e=>{profile=e.target.value;legCache.clear();recompute();});
document.getElementById('endpoint').addEventListener('change',e=>{endpoint=e.target.value.trim();legCache.clear();recompute();});
function undoPoint(){if(waypoints.length){waypoints.pop();syncMarkers();recompute();}}
document.getElementById('btnUndo').onclick=undoPoint;
document.getElementById('btnUndoMin').onclick=undoPoint;

// ---- panel minimize ----
// Collapse the sidebar to a small floating card (dist/ascent/undo) so the map
// gets the full width while drawing. The map is a flex sibling, so its size
// changes the instant the panel leaves the flow — tell Leaflet to re-measure.
function setMinimized(on){
  document.getElementById('app').classList.toggle('min',on);
  const b=document.getElementById('btnMin'), lbl=on?'Expand panel':'Minimize panel';
  b.innerHTML=on?'»':'«';
  b.title=lbl; b.setAttribute('aria-label',lbl);
  try{ localStorage.setItem('panelMin',on?'1':'0'); }catch(_){}
  requestAnimationFrame(()=>map.invalidateSize());
}
document.getElementById('btnMin').onclick=()=>
  setMinimized(!document.getElementById('app').classList.contains('min'));
try{ if(localStorage.getItem('panelMin')==='1') setMinimized(true); }catch(_){}
document.getElementById('btnClear').onclick=()=>{waypoints=[];legCache.clear();syncMarkers();recompute();};
document.getElementById('btnGpx').onclick=exportGpx;
const btnShare=document.getElementById('btnShare');
btnShare.onclick=shareGpx;
document.getElementById('btnCopyLink').onclick=async()=>{
  if(waypoints.length<1){showWarn('Add a point first — there’s no route to link yet.');return;}
  syncUrl();                         // make sure the address bar is current, then copy it
  const btn=document.getElementById('btnCopyLink');
  try{
    await navigator.clipboard.writeText(location.href);
    const t=btn.textContent; btn.textContent='Copied ✓'; setTimeout(()=>btn.textContent=t,1200);
  }catch(_){ showWarn('Couldn’t copy automatically — the link is in your address bar.'); }
};
// reveal "Send to phone" only where the browser can share files (mostly mobile)
try{
  const probe=new File(['x'],'probe.gpx',{type:GPX_TYPE});
  if(navigator.canShare && navigator.canShare({files:[probe]})) btnShare.hidden=false;
}catch(_){/* unsupported → stays hidden, Export GPX still works */}

// ---- boot ----
// The region fixes the CRS, so resolve it before the map exists.
setRegion(initialRegionId());
// Size the map, then restore any route encoded in the URL hash (fitBounds needs
// a known map size to pick the right zoom, so both wait for the same tick).
setTimeout(()=>{map.invalidateSize();loadFromUrl();},200);
