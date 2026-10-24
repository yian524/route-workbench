/* Route inspection geometry only. Never infer Google's live panorama or GPS. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.StreetGuideGeometry=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const R=6371008.8,D=Math.PI/180;
  const valid=p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
  const wrap=x=>((x+540)%360)-180;
  function distance(a,b){const x=(b.lat-a.lat)*D,y=wrap(b.lng-a.lng)*D;return 2*R*Math.asin(Math.min(1,Math.sqrt(Math.sin(x/2)**2+Math.cos(a.lat*D)*Math.cos(b.lat*D)*Math.sin(y/2)**2)));}
  function bearing(a,b){if(distance(a,b)<.05)return null;const y=Math.sin(wrap(b.lng-a.lng)*D)*Math.cos(b.lat*D),x=Math.cos(a.lat*D)*Math.sin(b.lat*D)-Math.sin(a.lat*D)*Math.cos(b.lat*D)*Math.cos(wrap(b.lng-a.lng)*D);return (Math.atan2(y,x)/D+360)%360;}
  function build(road){if(!Array.isArray(road?.path)||road.path.length<2||!road.path.every(valid))return null;const cumulative=[0];for(let i=1;i<road.path.length;i++)cumulative.push(cumulative[i-1]+distance(road.path[i-1],road.path[i]));if(cumulative.at(-1)<.1)return null;return {path:road.path,steps:(road.steps||[]).filter(s=>Number.isInteger(s.shapeIndex)&&s.shapeIndex>=0&&s.shapeIndex<road.path.length),cumulative,total:cumulative.at(-1)};}
  function at(model,meters){meters=Math.min(model.total,Math.max(0,meters));let i=1;while(i<model.cumulative.length-1&&model.cumulative[i]<=meters)i++;const a=model.path[i-1],b=model.path[i],len=model.cumulative[i]-model.cumulative[i-1],t=len?(meters-model.cumulative[i-1])/len:0;return {lat:a.lat+(b.lat-a.lat)*t,lng:wrap(a.lng+wrap(b.lng-a.lng)*t),along:meters,pos:i-1+t};}
  function nearest(model,p){if(!model||!valid(p))return null;const hits=[];for(let i=1;i<model.path.length;i++){const a=model.path[i-1],b=model.path[i],scale=Math.cos(p.lat*D),bx=wrap(b.lng-a.lng)*scale,by=b.lat-a.lat,px=wrap(p.lng-a.lng)*scale,py=p.lat-a.lat,den=bx*bx+by*by,t=den?Math.max(0,Math.min(1,(px*bx+py*by)/den)):0;const along=model.cumulative[i-1]+(model.cumulative[i]-model.cumulative[i-1])*t,q=at(model,along);hits.push({...q,distance:distance(p,q)});}hits.sort((a,b)=>a.distance-b.distance);const best=hits[0];return {...best,ambiguous:hits.some(h=>h.distance<=best.distance+3&&Math.abs(h.along-best.along)>80)};}
  function context(model,hit){if(!model||!hit)return null;const pos=hit.pos;let index=-1;model.steps.forEach((s,i)=>{if(s.shapeIndex<=pos+.02)index=i;});const step=model.steps[index]||null,next=model.steps[index+1]||null;const ahead=at(model,Math.min(model.total,hit.along+12)),behind=at(model,Math.max(0,hit.along-12));const heading=bearing(hit.along>=model.total-.1?behind:hit,ahead);return {index,step,next,heading,remaining:Math.max(0,model.total-hit.along),toNext:next?Math.max(0,model.cumulative[next.shapeIndex]-hit.along):0};}
  function stepTarget(model,along,delta){const indices=model.steps.map(s=>model.cumulative[s.shapeIndex]);return delta>0?(indices.find(n=>n>along+.8)??model.total):([...indices].reverse().find(n=>n<along-.8)??0);}
  function compass(h){return Number.isFinite(h)?['北','東北','東','東南','南','西南','西','西北'][Math.round(h/45)%8]:'未定';}
  return {valid,distance,bearing,build,at,nearest,context,stepTarget,compass};
});

/* Pure route-edit geometry. Geometry is selection evidence, never a routed path. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RouteEditGeometry=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const EARTH=6371008.8,DEG=Math.PI/180,MAX_POINTS=50,EPS=.5;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  function fail(message){throw new Error(message);}
  function coordinate(p,name='位置'){if(!p||!finite(p.lat)||!finite(p.lng)||Math.abs(p.lat)>90||Math.abs(p.lng)>180)fail(name+'不是有效經緯度。');return p;}
  function longitudeDifference(a,b){return ((a-b+540)%360)-180;}
  function distance(a,b){coordinate(a);coordinate(b);const dLat=(b.lat-a.lat)*DEG,dLng=longitudeDifference(b.lng,a.lng)*DEG;const x=Math.sin(dLat/2)**2+Math.cos(a.lat*DEG)*Math.cos(b.lat*DEG)*Math.sin(dLng/2)**2;return 2*EARTH*Math.asin(Math.sqrt(Math.min(1,Math.max(0,x))));}
  function pathOf(road){const p=Array.isArray(road)?road:road&&road.path;if(!Array.isArray(p)||p.length<2||p.length>100000)fail('道路線形必須包含 2～100000 個座標。');p.forEach((v,i)=>coordinate(v,'道路點 '+i));return p;}
  function indexValue(v,length,name,integer=true){if(!finite(v)||(integer&&!Number.isInteger(v))||v<0||v>length-1)fail(name+'超出道路線形範圍。');return v;}
  function cumulative(path){const list=[0];for(let i=1;i<path.length;i++)list.push(list[i-1]+distance(path[i-1],path[i]));return list;}
  function pointAt(path,pos){indexValue(pos,path.length,'沿程位置',false);const i=Math.min(path.length-2,Math.floor(pos)),t=pos-i;let lng=path[i].lng+longitudeDifference(path[i+1].lng,path[i].lng)*t;lng=((lng+540)%360)-180;return {lat:path[i].lat+(path[i+1].lat-path[i].lat)*t,lng};}
  function alongAt(list,pos){const i=Math.min(list.length-2,Math.floor(pos));return list[i]+(list[i+1]-list[i])*(pos-i);}
  function projectSegment(a,b,p,i,list){const lat0=(a.lat+b.lat+p.lat)/3*DEG,scale=Math.max(1e-9,Math.cos(lat0));const bx=longitudeDifference(b.lng,a.lng)*DEG*EARTH*scale,by=(b.lat-a.lat)*DEG*EARTH,px=longitudeDifference(p.lng,a.lng)*DEG*EARTH*scale,py=(p.lat-a.lat)*DEG*EARTH,den=bx*bx+by*by,t=den?Math.max(0,Math.min(1,(px*bx+py*by)/den)):0;const q=pointAt([a,b],t);return {...q,segmentIndex:i,t,pos:i+t,index:t<=.5?i:i+1,distanceMeters:distance(q,p),alongMeters:list[i]+(list[i+1]-list[i])*t};}
  function rawProjections(path,p){const list=cumulative(path);return path.slice(0,-1).map((v,i)=>projectSegment(v,path[i+1],p,i,list));}
  function projectCandidates(road,p,options={}){
    const path=pathOf(road);coordinate(p);const max=options.maxDistanceMeters??60,ambiguity=options.ambiguityMeters??8,limit=options.maxCandidates??12;
    if(!finite(max)||max<0||max>100000||!finite(ambiguity)||ambiguity<0||ambiguity>10000||!Number.isInteger(limit)||limit<1||limit>1000)fail('選線容許範圍無效。');
    const raw=rawProjections(path,p),best=raw.reduce((n,x)=>Math.min(n,x.distanceMeters),Infinity);if(best>max)return [];
    const local=raw.filter((x,i)=>x.distanceMeters<=Math.min(max,best+ambiguity)&&(!i||x.distanceMeters<=raw[i-1].distanceMeters+1e-6)&&(i===raw.length-1||x.distanceMeters<=raw[i+1].distanceMeters+1e-6));
    const result=[];for(const hit of local.sort((a,b)=>a.distanceMeters-b.distanceMeters||a.pos-b.pos)){if(!result.some(x=>Math.abs(x.alongMeters-hit.alongMeters)<=1))result.push(hit);}
    return result.slice(0,limit).sort((a,b)=>a.pos-b.pos).map(x=>({...x,ambiguous:result.length>1,truncated:result.length>limit}));
  }
  function suggestRange({road,controls=[],hitIndex,minLegMeters=25,maxLegMeters=700}={}){
    const path=pathOf(road);indexValue(hitIndex,path.length,'選取位置',false);if(!finite(minLegMeters)||minLegMeters<0||!finite(maxLegMeters)||maxLegMeters<minLegMeters)fail('替換範圍長度無效。');
    const list=cumulative(path),at=alongAt(list,hitIndex);const anchors=new Set([0,path.length-1]);for(const p of [...(road.steps||[]),...controls])if(Number.isInteger(p.shapeIndex)&&p.shapeIndex>=0&&p.shapeIndex<path.length)anchors.add(p.shapeIndex);
    const ordered=[...anchors].sort((a,b)=>a-b);let start=ordered.filter(i=>i<hitIndex&&at-list[i]>=minLegMeters).pop(),end=ordered.find(i=>i>hitIndex&&list[i]-at>=minLegMeters);
    if(start===undefined)start=Math.max(0,Math.floor(hitIndex)-1);if(end===undefined)end=Math.min(path.length-1,Math.ceil(hitIndex)+1);
    if(at-list[start]>maxLegMeters){for(let i=Math.floor(hitIndex);i>=0;i--)if(at-list[i]>=Math.max(minLegMeters,100)){start=i;break;}}
    if(list[end]-at>maxLegMeters){for(let i=Math.ceil(hitIndex);i<path.length;i++)if(list[i]-at>=Math.max(minLegMeters,100)){end=i;break;}}
    if(start>=end){start=Math.max(0,Math.min(path.length-2,Math.floor(hitIndex)));end=start+1;}
    return {startIndex:start,endIndex:end,hitIndex,start:clone(path[start]),end:clone(path[end]),reason:'依轉彎、既有途經點與沿程距離提出範圍；仍須在地圖確認起點與接回點。'};
  }
  function validateControls(controls,path){if(!Array.isArray(controls)||controls.length<2||controls.length>200)fail('控制點數量無效。');const ids=new Set();let previous=-1;controls.forEach((p,i)=>{coordinate(p,'控制點 '+i);indexValue(p.shapeIndex,path.length,'控制點 '+i+' 的線形索引');if(p.shapeIndex<previous)fail('控制點順序與道路線形不一致。');previous=p.shapeIndex;if(typeof p.controlId!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(p.controlId)||ids.has(p.controlId))fail('控制點識別碼缺少、重複或格式無效。');ids.add(p.controlId);if(!['shaping','stop','locked','legacy','endpoint'].includes(p.controlRole))fail('控制點用途無效。');if(p.controlSource!==undefined&&(typeof p.controlSource!=='string'||p.controlSource.length>80))fail('控制點來源格式無效。');});if(controls[0].shapeIndex!==0||controls[controls.length-1].shapeIndex!==path.length-1)fail('起終點必須對應道路線形兩端。');return ids;}
  function hash(text){let n=2166136261;for(let i=0;i<text.length;i++){n^=text.charCodeAt(i);n=Math.imul(n,16777619);}return (n>>>0).toString(36);}
  function protectedPoint(p){return p.controlRole!=='shaping'||p._endpoint;}
  function mergeEqual(a,b){if(protectedPoint(a)&&protectedPoint(b)&&a.controlId!==b.controlId)fail('兩個受保護的途經點重疊，請先整理該位置的必經點。');const priority=p=>p._endpoint?100:protectedPoint(p)?5:p._existing?2:1;const out=clone(priority(a)>=priority(b)?a:b);out._focus=!!(a._focus||b._focus);return out;}
  function buildReplacement({road,controls,startIndex,endIndex,hitIndex,target,releaseIds=[]}={}){
    const path=pathOf(road);indexValue(startIndex,path.length,'開始索引');indexValue(endIndex,path.length,'接回索引');indexValue(hitIndex,path.length,'選取索引',false);if(startIndex>=endIndex||hitIndex<startIndex||hitIndex>endIndex)fail('替換範圍必須由開始點往接回點，並包含選取路段。');coordinate(target,'新道路位置');const known=validateControls(controls,path);if(!Array.isArray(releaseIds)||releaseIds.some(x=>typeof x!=='string'))fail('解除必經點清單無效。');for(const id of releaseIds)if(!known.has(id))fail('解除清單包含不存在的控制點。');const released=new Set(releaseIds),endIds=new Set([controls[0].controlId,controls[controls.length-1].controlId]);if(releaseIds.some(id=>endIds.has(id)))fail('不能解除起點或終點。');
    const removed=[],retainedProtected=[],points=[];controls.forEach((p,i)=>{const endpoint=i===0||i===controls.length-1,inside=p.shapeIndex>startIndex&&p.shapeIndex<endIndex,canRelease=released.has(p.controlId);if(inside&&!endpoint&&(!protectedPoint(p)||canRelease)){removed.push(clone(p));return;}if(inside&&protectedPoint(p))retainedProtected.push(clone(p));points.push({...clone(p),_position:p.shapeIndex,_existing:true,_endpoint:endpoint,_order:i===0?-10:i===controls.length-1?10:0});});
    const key=startIndex+':'+endIndex+':'+controls[0].controlId+':'+controls[controls.length-1].controlId;function make(kind,p,pos,label){let id='map17-'+kind+'-'+hash(key+':'+p.lat.toFixed(7)+','+p.lng.toFixed(7));let salt=0;while(known.has(id))id='map17-'+kind+'-'+hash(key+':'+p.lat+','+p.lng+':'+(++salt));known.add(id);return {...clone(p),label,controlId:id,controlRole:'shaping',shapeIndex:Math.round(pos),controlSource:'map_section_replacement',_position:pos,_order:kind==='start'?-2:kind==='end'?2:0,_existing:false,_endpoint:false};}
    const begin=make('start',path[startIndex],startIndex,'改道開始位置'),finish=make('end',path[endIndex],endIndex,'接回原路位置'),via=make('target',target,hitIndex,target.label||'改走這裡');via._focus=true;via._order=hitIndex===startIndex?1:hitIndex===endIndex?-1:1;points.push(begin,via,finish);points.sort((a,b)=>a._position-b._position||a._order-b._order);
    const dedup=[];for(const p of points){const last=dedup[dedup.length-1];if(last&&distance(last,p)<=EPS)dedup[dedup.length-1]=mergeEqual(last,p);else dedup.push(p);}if(dedup.length>MAX_POINTS)fail('調整後超過免費道路計算的 50 個控制點；請先整理途經點。');const focusIndex=dedup.findIndex(p=>p._focus);for(const p of dedup){delete p._existing;delete p._endpoint;delete p._order;delete p._position;delete p._focus;}return {points:dedup,focusIndex,removed,retainedProtected,startIndex,endIndex,hitIndex,targetId:dedup[focusIndex].controlId,method:'僅更新控制點；整條道路須由道路服務重新計算。'};
  }
  function pathSlice(path,from,to){const values=[pointAt(path,from)];for(let i=Math.floor(from)+1;i<to;i++)values.push(path[i]);values.push(pointAt(path,to));return values;}
  function sampleCount(path,step=20){let total=1;for(let i=1;i<path.length;i++)total+=Math.max(1,Math.ceil(distance(path[i-1],path[i])/step));return total;}
  function samplePath(path,step=20){const out=[path[0]];for(let i=1;i<path.length;i++){const n=Math.max(1,Math.ceil(distance(path[i-1],path[i])/step));for(let j=1;j<=n;j++)out.push(pointAt([path[i-1],path[i]],j/n));}return out;}
  function closestDistance(p,path){const list=cumulative(path);let best=Infinity;for(let i=0;i<path.length-1;i++)best=Math.min(best,projectSegment(path[i],path[i+1],p,i,list).distanceMeters);return best;}
  function symmetricDeviation(a,b){const countA=sampleCount(a),countB=sampleCount(b);if(countA+countB>8000||countA*b.length+countB*a.length>8000000)return {maxDistanceMeters:null,sampleCount:0,over20Meters:null,limited:true};const aa=samplePath(a),bb=samplePath(b);let maximum=0,exceed=0;for(const [source,dest] of [[aa,b],[bb,a]])for(const p of source){const d=closestDistance(p,dest);maximum=Math.max(maximum,d);if(d>20)exceed++;}return {maxDistanceMeters:maximum,sampleCount:aa.length+bb.length,over20Meters:exceed,limited:false};}
  function roadNames(road){const names=[];for(const s of road.steps||[]){const name=typeof s.road==='string'?s.road.trim():'';if(name&&names[names.length-1]!==name)names.push(name);}return names;}
  function assessChanges(oldRoad,newRoad,startIndex,endIndex){
    const oldPath=pathOf(oldRoad),newPath=pathOf(newRoad);indexValue(startIndex,oldPath.length,'開始索引');indexValue(endIndex,oldPath.length,'接回索引');if(startIndex>=endIndex)fail('比對範圍無效。');for(const r of [oldRoad,newRoad])if(!finite(r.distanceMeters)||r.distanceMeters<0||!finite(r.durationSeconds)||r.durationSeconds<0)fail('道路公里或時間資料無效。');
    const starts=projectCandidates(newPath,oldPath[startIndex],{maxDistanceMeters:100,ambiguityMeters:3,maxCandidates:100}),ends=projectCandidates(newPath,oldPath[endIndex],{maxDistanceMeters:100,ambiguityMeters:3,maxCandidates:100}),pairs=[];for(const a of starts)for(const b of ends)if(a.pos<=b.pos)pairs.push({a,b,cost:a.distanceMeters+b.distanceMeters});pairs.sort((a,b)=>a.cost-b.cost);const best=pairs[0],ambiguous=!!best&&pairs.some((p,i)=>i>0&&p.cost<=best.cost+3&&(Math.abs(p.a.alongMeters-best.a.alongMeters)>20||Math.abs(p.b.alongMeters-best.b.alongMeters)>20));let prefix=null,suffix=null;const unavailable=!best||best.a.distanceMeters>30||best.b.distanceMeters>30;
    if(!unavailable){prefix=symmetricDeviation(pathSlice(oldPath,0,startIndex),pathSlice(newPath,0,best.a.pos));suffix=symmetricDeviation(pathSlice(oldPath,endIndex,oldPath.length-1),pathSlice(newPath,best.b.pos,newPath.length-1));}
    const limited=!!(prefix?.limited||suffix?.limited),oldNames=roadNames(oldRoad),newNames=roadNames(newRoad);return {outsideChanged:unavailable||ambiguous||limited||prefix.over20Meters>0||suffix.over20Meters>0,deltaMeters:newRoad.distanceMeters-oldRoad.distanceMeters,deltaSeconds:newRoad.durationSeconds-oldRoad.durationSeconds,roadsAdded:[...new Set(newNames.filter(x=>!oldNames.includes(x)))],roadsRemoved:[...new Set(oldNames.filter(x=>!newNames.includes(x)))],roadSequenceChanged:JSON.stringify(oldNames)!==JSON.stringify(newNames),oldRoadNames:oldNames,newRoadNames:newNames,outsideEvidence:{boundaryUnavailable:unavailable,boundaryAmbiguous:ambiguous,comparisonLimited:limited,newStartPosition:best?.a.pos??null,newEndPosition:best?.b.pos??null,prefix,suffix},method:'於舊範圍兩端找新路線沿程投影，雙向每最多 20 公尺採樣，比對範圍外到對方線段距離；超過 20 公尺、邊界離線超過 30 公尺、重疊圈無法唯一定位或超過比對計算量上限，均提醒範圍外可能改變。不能證明道路名稱、行進方向、合法性或所有細節相同。'};
  }
  return Object.freeze({projectCandidates,suggestRange,buildReplacement,assessChanges,distance,pointAt,MAX_POINTS});
});

/* v17.2: deterministic Google Maps / LINE handoff. No requests or storage. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RouteHandoff=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MAX_PATH_POINTS=1000,MAX_CONTROLS=50,MAX_STEPS=200,MAX_URL_LENGTH=2048;
const TURN_KINDS=new Set(['left','right','uturn','merge','roundabout']);
const TURN_LABELS={left:'左轉後',right:'右轉後',uturn:'迴轉後',merge:'匯入後',roundabout:'圓環後'};
const WARNINGS=[
'Google 會依自己的道路資料與路況重新計算；中途點只能約束經過位置，不能鎖住本工具的每一段線形或保證不改道。',
'手機開啟後，先核對交通工具為機車、每個中途點及橋梁／機慢車道；部分 Google Maps 產品可能忽略中途點。',
'依序導航每一段，到該段終點後才開啟下一段。Google 可能將中途點視為停靠點並要求繼續導航。',
'避開高速公路與收費路段是導航偏好，不代表機車通行合法性已核實；現場標誌、禁轉與兩段式待轉仍須確認。',
'這裡的公里與時間來自目前道路模型；Google 導航顯示的路線、距離與時間可能不同。'
];
function fail(message){throw new Error('無法建立導航轉交：'+message);}
function number(v){return typeof v==='number'&&Number.isFinite(v);}
function coord(p,what){if(!p||!number(p.lat)||!number(p.lng)||p.lat < -90||p.lat > 90||p.lng < -180||p.lng > 180)fail(what+'的座標無效。');return {lat:p.lat,lng:p.lng};}
function distance(a,b){const k=Math.PI/180,dy=(b.lat-a.lat)*k,dx=(b.lng-a.lng)*k,q=Math.sin(dy/2)**2+Math.cos(a.lat*k)*Math.cos(b.lat*k)*Math.sin(dx/2)**2;return 6371000*2*Math.atan2(Math.sqrt(q),Math.sqrt(Math.max(0,1-q)));}
function plain(value,fallback){return typeof value==='string'&&value.trim()?value.replace(/[\u0000-\u001f\u007f]+/g,' ').trim():fallback;}
function at(path,index){if(!number(index)||index<0||index>path.length-1)fail('道路位置超出完整路線。');const i=Math.floor(index),t=index-i;if(!t||i===path.length-1)return {...path[i]};return {lat:path[i].lat+(path[i+1].lat-path[i].lat)*t,lng:path[i].lng+(path[i+1].lng-path[i].lng)*t};}
function positionAfter(path,lengths,start,meters){let remaining=meters;for(let i=start;i<path.length-1;i++){const d=lengths[i];if(d===0)continue;if(remaining<=d)return i+remaining/d;remaining-=d;}return path.length-1;}
function positionIndex(value,path,what){if(!Number.isInteger(value)||value<0||value>=path.length)fail(what+'缺少有效道路索引。');return value;}
function coordinateText(p){const n=v=>v.toFixed(7).replace(/\.?0+$/,'').replace(/^-0$/,'0');return n(p.lat)+','+n(p.lng);}
function makeUrl(anchors){const fields=[['api','1'],['origin',coordinateText(anchors[0])],['destination',coordinateText(anchors[anchors.length-1])],['travelmode','two-wheeler'],['avoid','highways,tolls'],['dir_action','navigate']];if(anchors.length>2)fields.push(['waypoints',anchors.slice(1,-1).map(coordinateText).join('|')]);return 'https://www.google.com/maps/dir/?'+fields.map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');}
function metricText(road){const seconds=Math.round(road.durationSeconds),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),s=seconds%60;return (road.distanceMeters/1000).toFixed(2)+' 公里 · '+(['hybrid_osm_google_v21','hybrid_osm_path_v22'].includes(road.provider)?'分段混合估計 ':'道路模型 ')+(hours?hours+' 小時 ':'')+minutes+' 分 '+s+' 秒';}
function build(options){
if(!options||typeof options!=='object')fail('缺少路線資料。');
const {road,controls,name,roadText,journeyText,routeState,includeTurns=true,maxWaypoints=3}=options;
if(!road||!Array.isArray(road.path)||road.path.length<2||road.path.length>MAX_PATH_POINTS)fail('完整道路線形必須有 2～'+MAX_PATH_POINTS+' 個座標。');
const path=road.path.map((p,i)=>coord(p,'道路第 '+(i+1)+' 點'));
if(!Array.isArray(controls)||controls.length<2||controls.length>MAX_CONTROLS)fail('控制點必須有 2～'+MAX_CONTROLS+' 個。');
if(!Array.isArray(road.points)||road.points.length!==controls.length)fail('控制點與道路計算結果數量不一致，請先重新計算。');
if(!Array.isArray(road.steps)||!road.steps.length||road.steps.length>MAX_STEPS)fail('缺少完整轉彎文字，或超過 '+MAX_STEPS+' 個步驟。');
if(!number(road.distanceMeters)||road.distanceMeters<=0||!number(road.durationSeconds)||road.durationSeconds<0)fail('公里或模型時間不完整。');
if(typeof includeTurns!=='boolean')fail('轉彎點選項必須為布林值。');
if(!Number.isInteger(maxWaypoints)||maxWaypoints<0||maxWaypoints>8)fail('每段中途點數需為 0～8；手機瀏覽器建議 3。');
if(typeof journeyText!=='string'||!journeyText.trim())fail('缺少完整路線文字。');
const lengths=path.slice(1).map((p,i)=>distance(path[i],p)),cumulative=[0];lengths.forEach(d=>cumulative.push(cumulative[cumulative.length-1]+d));
const along=pos=>{const i=Math.floor(pos);return cumulative[i]+(pos-i)*(lengths[i]||0);};
if(!lengths.some(d=>d>0.01))fail('完整道路線形沒有可導航距離。');
const raw=[],mappedPoints=[];let previous=-1;
road.points.forEach((p,i)=>{
 const pp=coord(p,'道路控制點 '+(i+1)),c=controls[i];coord(c,'控制點 '+(i+1));
 const pos=positionIndex(p.shapeIndex,path,'道路控制點 '+(i+1));
 if(pos<previous)fail('控制點在道路上的順序不一致。');previous=pos;
 if(distance(pp,path[pos])>2)fail('道路控制點 '+(i+1)+' 未對齊道路線形，請重新計算。');
 const label=plain(c.label,plain(c.road,i===0?'起點':i===controls.length-1?'終點':'途經點 '+i));
 const role=plain(c.controlRole,i===0||i===controls.length-1?'endpoint':'legacy');
 const anchor={...path[pos],shapePosition:pos,alongMeters:along(pos),labels:[label],sources:[{kind:'control',controlIndex:i,controlId:plain(c.controlId,''),role}],kind:'control'};
 mappedPoints.push(anchor);raw.push(anchor);
});
if(mappedPoints[0].shapePosition!==0||mappedPoints[mappedPoints.length-1].shapePosition!==path.length-1)fail('起點或終點沒有涵蓋完整道路線形。');
previous=-1;
road.steps.forEach((s,i)=>{
 if(!s||typeof s!=='object')fail('步驟 '+(i+1)+' 無效。');
 const pos=positionIndex(s.shapeIndex,path,'步驟 '+(i+1));
 if(pos<previous)fail('轉彎步驟在道路上的順序不一致。');previous=pos;
 if(distance(coord(s.start,'步驟 '+(i+1)),path[pos])>2)fail('轉彎步驟 '+(i+1)+' 未對齊道路線形。');
 if(typeof s.turnKind!=='string'||typeof s.road!=='string')fail('步驟 '+(i+1)+' 缺少轉向或路名。');
 if(!includeTurns||!TURN_KINDS.has(s.turnKind)||pos===path.length-1)return;
 const targetPos=positionAfter(path,lengths,pos,10),point=at(path,targetPos);
 const offsetMeters=along(targetPos)-along(pos);
 raw.push({...point,shapePosition:targetPos,alongMeters:along(targetPos),offsetMeters,labels:[TURN_LABELS[s.turnKind]+'約 '+Math.round(offsetMeters)+' 公尺：'+plain(s.road,'未命名道路')],sources:[{kind:'turn',stepIndex:i,turnKind:s.turnKind}],kind:'turn'});
});
if(road.steps[0].shapeIndex!==0||road.steps[road.steps.length-1].shapeIndex!==path.length-1)fail('轉彎步驟沒有涵蓋起點至終點。');
raw.sort((a,b)=>a.shapePosition-b.shapePosition||(a.kind===b.kind?0:a.kind==='control'?-1:1));
const anchors=[];
raw.forEach(item=>{
 const last=anchors[anchors.length-1];
 // Same place on the same occurrence only: returning to a coordinate later is a distinct stop.
 if(last&&Math.abs(last.alongMeters-item.alongMeters)<0.01&&distance(last,item)<0.01){
  last.labels.push(...item.labels);last.sources.push(...item.sources);if(item.kind==='control')last.kind='control';
 }else anchors.push({...item,labels:[...item.labels],sources:item.sources.map(s=>({...s}))});
});
if(anchors.length<2)fail('至少需要兩個不同的道路位置。');
anchors.forEach((a,i)=>{a.index=i;a.number=i+1;a.label=a.labels.join('／');});
const parts=[];
for(let start=0;start<anchors.length-1;){
 let end=Math.min(anchors.length-1,start+maxWaypoints+1),segment,url;
 do{segment=anchors.slice(start,end+1);url=makeUrl(segment);if(url.length<=MAX_URL_LENGTH)break;end--;}while(end>start);
 if(end===start||!url||url.length>MAX_URL_LENGTH)fail('導航連結超過 Google 長度上限。');
 const labels=segment.map(a=>a.number+'. '+a.label);
 parts.push({index:parts.length+1,startAnchorIndex:start,endAnchorIndex:end,anchors:segment,labels,origin:segment[0],destination:segment[segment.length-1],waypoints:segment.slice(1,-1),url});
 start=end;
}
const warnings=[...WARNINGS];if(maxWaypoints>3)warnings.splice(2,0,'目前每段允許 '+maxWaypoints+' 個中途點，超過手機瀏覽器常見的 3 個限制；請使用 Google Maps App 並逐一核對。');
if(includeTurns)warnings.push('轉彎後的錨點取自目前道路線形，約在轉彎後 10 公尺；這些是導航約束位置，不代表可以在該處停車。');
const title=plain(name,'我的路線'),state=plain(routeState,'目前顯示路線（保存狀態未提供）');
parts.forEach(part=>{part.total=parts.length;part.text=['【'+title+'｜第 '+part.index+'/'+parts.length+' 段】',state,part.labels.join(' → '),part.url,'到本段終點後，才開下一段。Google 可能重算，請核對機車模式與中途點。'].join('\n');});
const sections=['【'+title+'】','路線狀態：'+state,metricText(road)+(road.timeNote?'\n'+road.timeNote:'')];
if(typeof roadText==='string'&&roadText.trim())sections.push('路名順序：\n'+roadText);
sections.push('完整路線：\n'+journeyText,'Google Maps 分段機車導航（共 '+parts.length+' 段）：',...parts.map(p=>p.text),'使用前請確認：\n'+warnings.map((w,i)=>(i+1)+'. '+w).join('\n'));
return {anchors,parts,text:sections.join('\n\n'),warnings};
}
return {build,MAX_PATH_POINTS,MAX_CONTROLS,MAX_STEPS,MAX_URL_LENGTH};
});


/* v18: one complete Google Maps handoff; never mutates the saved road or its stops. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./planner_handoff_engine_v17_2.js'));else root.RouteHandoffSingle=factory(root.RouteHandoff);})(typeof globalThis!=='undefined'?globalThis:this,function(base){
'use strict';
const MAX_WAYPOINTS=8,MAX_URL_LENGTH=2048;
const DISPLAY_KEYS=new Set(['label','road','name','displayName']);
function fail(message){throw new Error('無法建立完整導航：'+message);}
function stable(value){
 if(value===null)return 'null';
 if(typeof value==='number'){if(!Number.isFinite(value))fail('指紋資料包含無效數字。');return JSON.stringify(value);}
 if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(x=>x===undefined?'null':stable(x)).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
 fail('指紋資料格式無效。');
}
function fingerprint(road,controls){
 if(!road||!Array.isArray(controls))fail('缺少指紋所需道路或控制點。');
 // Keep exact canonical content instead of a short noncryptographic hash. Renaming is harmless;
 // any geometry, routing instruction, stop identity, role or protection change invalidates review.
 const controlState=controls.map(c=>{if(!c||typeof c!=='object')fail('控制點資料無效。');const v={};Object.keys(c).filter(k=>!DISPLAY_KEYS.has(k)).forEach(k=>{v[k]=c[k];});return v;});
 return 'route-v18:'+stable({path:road.path,points:road.points,steps:road.steps,distanceMeters:road.distanceMeters,durationSeconds:road.durationSeconds,controls:controlState});
}
function plain(value,fallback){return typeof value==='string'&&value.trim()?value.replace(/[\u0000-\u001f\u007f]+/g,' ').trim():fallback;}
function validPoint(p){return p&&typeof p.lat==='number'&&typeof p.lng==='number'&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;}
function equalPoint(a,b){return !!a&&!!b&&Math.abs(a.lat-b.lat)<=1e-9&&Math.abs(a.lng-b.lng)<=1e-9;}
function sameRoundedControl(a,b){
 if(!validPoint(a)||!validPoint(b))return false;
 const latMeters=(a.lat-b.lat)*111320, lngMeters=(a.lng-b.lng)*111320*Math.cos(a.lat*Math.PI/180);
 return Math.hypot(latMeters,lngMeters)<=1;
}
function required(c){return c.locked===true||c.controlRole==='stop'||c.controlRole==='locked'||c.role==='stop'||c.role==='locked'||c.isStop===true||c.stop===true;}
function coordinateText(p){const n=v=>v.toFixed(7).replace(/\.?0+$/,'').replace(/^-0$/,'0');return n(p.lat)+','+n(p.lng);}
function makeUrl(anchors,originAddress){const fields=[['api','1'],['origin',originAddress||coordinateText(anchors[0])],['destination',coordinateText(anchors[anchors.length-1])],['travelmode','two-wheeler'],['avoid','highways,tolls']];if(anchors.length>2)fields.push(['waypoints',anchors.slice(1,-1).map(coordinateText).join('|')]);return 'https://www.google.com/maps/dir/?'+fields.map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');}
function metricText(road){const s=Math.round(road.durationSeconds),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return (road.distanceMeters/1000).toFixed(2)+' 公里 · '+(['hybrid_osm_google_v21','hybrid_osm_path_v22'].includes(road.provider)?'分段混合估計 ':'道路模型 ')+(h?h+' 小時 ':'')+m+' 分 '+s%60+' 秒';}
function plan(options){
 if(!options||typeof options!=='object')fail('缺少路線資料。');
 if(!base||typeof base.build!=='function')fail('道路資料驗證模組未載入。');
 const {road,controls,candidates=[],selectedIndices,useOriginal=false}=options;
 // Reuse every geometry/instruction/metric integrity check; suppress synthetic turn anchors.
 base.build({...options,includeTurns:false,maxWaypoints:8});
 if(typeof useOriginal!=='boolean')fail('原始點選項必須為布林值。');
 if(!Array.isArray(candidates))fail('已核對候選資料必須為陣列。');
 const fp=fingerprint(road,controls),last=controls.length-1;
 const original=controls.map((c,i)=>{const p=road.path[road.points[i].shapeIndex],label=plain(c.label,plain(c.road,i===0?'起點':i===last?'終點':'途經點 '+i));return {lat:p.lat,lng:p.lng,controlIndex:i,shapePosition:road.points[i].shapeIndex,label,labels:[label],kind:'control',sources:[{kind:'control',controlIndex:i,controlId:plain(c.controlId,''),role:plain(c.controlRole,i===0||i===last?'endpoint':'legacy')}],required:i===0||i===last||required(c)};});
 const choices=original.slice(1,-1).map(a=>({index:a.controlIndex,label:a.label,lat:a.lat,lng:a.lng,required:a.required,selected:false}));
 const mandatory=choices.filter(c=>c.required).map(c=>c.index);
 mandatory.forEach(i=>choices[i-1].selected=true);
 const warnings=[
  'Google 會重新計算道路；一個完整連結可保留選定必經點，但不能鎖住整條線形，也不能保證手機不改道。',
  '請在 Google Maps App 開啟，確認機車模式、起終點與全部中途點。最多使用 8 個中途點；手機瀏覽器可能只接受 3 個，或忽略部分點。',
  'Google 可能把中途點當成停靠點，要求手動繼續。必經位置不代表可停車；仍依現場標誌、禁轉與兩段式待轉規定騎乘。',
  '原路線公里與道路模型時間不是 Google 導航路線的距離或即時 ETA，亦未完整計入早尖峰、紅燈與待轉。'
 ];
 const result={valid:false,blocked:false,reason:'',sourceType:'selection-required',notice:'',anchors:[],choices,selectedIndices:[...mandatory],omitted:[],parts:[],text:'',url:'',warnings,metrics:{distanceMeters:road.distanceMeters,durationSeconds:road.durationSeconds,source:'original-road-model',text:metricText(road)},originalControlCount:controls.length,maxWaypoints:MAX_WAYPOINTS,fingerprint:fp};
 function invalid(reason,blocked=false){result.reason=reason;result.notice=reason;result.blocked=blocked;result.sourceType=blocked?'blocked':'selection-required';return result;}
 if(mandatory.length>MAX_WAYPOINTS)return invalid('這條路線有 '+mandatory.length+' 個必須保留的停靠／鎖定點，超過單一 Google Maps App 連結的 8 個中途點；請改用進階分段，不會替你刪除。',true);
 let anchors=null,selected=[],sourceType='',notice='',originAddress=plain(options.originAddress,'');if(originAddress.length>200)fail('導航起點地址過長。');
 const hasManual=selectedIndices!==undefined&&selectedIndices!==null;
 if(hasManual){
  if(!Array.isArray(selectedIndices)||selectedIndices.some(i=>!Number.isInteger(i)||i<0||i>last))fail('手選途經點索引無效。');
  selected=[...new Set(selectedIndices)].filter(i=>i>0&&i<last).sort((a,b)=>a-b);
  selected.forEach(i=>{choices[i-1].selected=true;});result.selectedIndices=[...selected];result.omitted=choices.filter(c=>!c.selected).map(c=>({...c}));
  if(selected.length>MAX_WAYPOINTS)return invalid('目前選了 '+selected.length+' 個中途點；一個連結最多 8 個，請取消部分可調整點。');
  const missing=mandatory.filter(i=>!selected.includes(i));
  if(missing.length)return invalid('停靠／鎖定點不能省略：'+missing.map(i=>original[i].label).join('、')+'。');
  anchors=[original[0],...selected.map(i=>original[i]),original[last]];sourceType='manual';
  notice='依你明確選擇的 '+selected.length+' 個中途點建立完整連結；原路線與未選控制點仍完整保留。未選的道路可能由 Google 改走其他路。';
 }else if(!useOriginal){
  const matching=candidates.find(c=>c&&c.fingerprint===fp);
  if(matching){
   const points=matching.points;
   let acceptable=Array.isArray(points)&&points.length>=2&&points.length<=MAX_WAYPOINTS+2&&points.every(validPoint);
   acceptable=acceptable&&equalPoint(points[0],original[0])&&equalPoint(points[points.length-1],original[last]);
   // Required stops must remain in order, including a repeated visit to the same coordinates.
   let cursor=0;
   if(acceptable)for(const index of mandatory){let found=-1;for(let j=cursor+1;j<points.length-1;j++){if(equalPoint(points[j],original[index])){found=j;break;}}if(found<0){acceptable=false;break;}cursor=found;}
   if(acceptable){
    let originalCursor=0;
    anchors=points.map((p,i)=>{
     let match=i===0?0:i===points.length-1?last:-1;
     // Candidate coordinates are rounded for a shareable URL. Recognize the same
     // original control within one metre, but never relax the exact protected-stop check above.
     if(i>0&&i<points.length-1)for(let j=originalCursor+1;j<last;j++)if(equalPoint(p,original[j])||(!original[j].required&&sameRoundedControl(p,original[j]))){match=j;originalCursor=j;break;}
     if(match>0&&match<last)selected.push(match);
     const label=plain(p.label,match>=0?original[match].label:'導航必經點 '+i);
     return {lat:p.lat,lng:p.lng,label,labels:[label],kind:'candidate',controlIndex:match>=0?match:null,shapePosition:match>=0?original[match].shapePosition:null,required:match>=0?original[match].required:false,sources:match>=0?original[match].sources.map(s=>({...s})):[{kind:'candidate',candidateIndex:i}]};
    });
    sourceType='candidate';originAddress=plain(matching.originAddress,'');if(originAddress.length>200)fail('導航起點地址過長。');notice=plain(matching.notice,'這是已核對的完整導航候選；為符合 8 點上限，使用部分道路內的必經位置。')+' 原路線不會被覆寫；請先核對 Google 顯示的完整路徑。';
   }else notice='既有候選的點數、起終點或受保護停點不符；已停用候選，請使用原始點或手選。';
  }
 }
 if(!anchors){
  if(choices.length<=MAX_WAYPOINTS){anchors=original;selected=choices.map(c=>c.index);sourceType='original';notice=(notice?notice+' ':'')+'完整保留原路線所有 '+choices.length+' 個中途點；不額外把每次轉彎加成停靠點。';}
  else return invalid((notice?notice+' ':'')+'原路線有 '+choices.length+' 個中途點。請明確選擇最多 8 個建立完整連結，或使用進階分段；不會自動刪除你的點。');
 }
 anchors=anchors.map((a,i)=>({...a,index:i,number:i+1,labels:[...a.labels],sources:a.sources.map(s=>({...s}))}));
 choices.forEach(c=>{c.selected=selected.includes(c.index);});
 const url=makeUrl(anchors,originAddress);if(url.length>MAX_URL_LENGTH)return invalid('完整導航網址超過 2,048 字元，請減少中途點或使用進階分段。',true);
 const labels=anchors.map((a,i)=>{const prefix=i===0?'起點':i===anchors.length-1?'終點':'必經 '+i;const label=(i===0||i===anchors.length-1)?a.label.replace(/^(?:起點|終點)[:：]\s*/,''):a.label;return prefix+'：'+label+'（'+coordinateText(a)+'）';});
 const title=plain(options.name,'我的路線'),state=plain(options.routeState,'目前顯示路線（保存狀態未提供）');
 const omitted=choices.filter(c=>!c.selected).map(c=>({...c}));
 const parts=[{index:1,total:1,startAnchorIndex:0,endAnchorIndex:anchors.length-1,anchors,labels,origin:anchors[0],destination:anchors[anchors.length-1],waypoints:anchors.slice(1,-1),url}];
 const sections=['【'+title+'｜完整路線與導航】','路線狀態：'+state,'原路線參考：'+metricText(road)+'\n不是 Google 導航路線距離或即時 ETA。'+(road.timeNote?'\n'+road.timeNote:''),notice];
 if(typeof options.roadText==='string'&&options.roadText.trim())sections.push('原路線完整路名順序：\n'+options.roadText);
 sections.push('原路線完整騎乘文字：\n'+options.journeyText,originAddress?'Google 導航起點地址：'+originAddress+'（與原道路模型起點約 9 公尺，請核對）':'Google 導航起點使用原路線座標。','本次完整導航採用的點（'+(anchors.length-2)+' 個中途點）：\n'+labels.join('\n'));
 if(omitted.length)sections.push('原路線仍保留、但未直接列為此 Google 連結約束點的位置：\n'+omitted.map(c=>c.index+'. '+c.label).join('\n')+'\n不表示 Google 一定略過這些道路；這些位置不再由連結強制約束。');
 sections.push('Google Maps 完整機車路線（單一連結，先預覽再導航）：\n'+url,'使用前請確認：\n'+warnings.map((w,i)=>(i+1)+'. '+w).join('\n'));
 const text=sections.join('\n\n');parts[0].text=text;
 return {...result,valid:true,blocked:false,reason:'',sourceType,notice,anchors,choices,selectedIndices:selected,omitted,parts,text,url};
}
return {plan,fingerprint,MAX_WAYPOINTS,MAX_URL_LENGTH};
});

/* Route workspace. No API keys are persisted or exported. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = JSON.parse($('planner-data').textContent);
  const engine = window.PlannerEngine || {};
  const clone = value => JSON.parse(JSON.stringify(value));
  const coord = value => {
    if (!value) return null;
    const lat = typeof value.lat === 'function' ? value.lat() : value.lat;
    const lng = typeof value.lng === 'function' ? value.lng() : (value.lng ?? value.lon);
    return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180 ? {lat,lng} : null;
  };
  const pathOf = route => (route.path || route.geometry || route.points || []).map(coord).filter(Boolean);
  const pointsOf = route => (route.points || route.waypoints || pathOf(route)).filter(coord).map(p => ({...p,...coord(p)}));
  const validName = value => String(value || '').replace(/[\u0000-\u001f]/g,'').slice(0,160);
  const cleanError = error => String(error?.message || error || '服務暫時無法使用').replace(/AIza[A-Za-z0-9_-]+/g,'[已遮罩]').replace(/[?&]key=[^\s&]+/gi,'key=[已遮罩]').slice(0,250);
  function distance(a,b) {
    if (engine.distanceMeters) return engine.distanceMeters([a,b]);
    const r=6371000,rad=x=>x*Math.PI/180;
    const h=Math.sin(rad(b.lat-a.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(b.lng-a.lng)/2)**2;
    return 2*r*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
  }
  const stations=(data.stations||[]).filter(coord).map(s=>({...s,...coord(s)}));
  const embedRows=Array.isArray(data.embeds)?data.embeds:Object.values(data.embeds||{});
  const embedById=new Map(embedRows.map(e=>[e.id,e]));
  const presets=(data.presets||data.planner_routes_v5?.presets||[]).map(r=>({...clone(r),custom:false}));
  let saved=[];try{saved=JSON.parse(data.publicEdition?'[]':localStorage.getItem('commute-planner-routes-v5')||'[]').filter(validSavedRoute).map(exportRoute);}catch(_){}
  const state={home:clone(data.home||{}),office:clone(data.office||data.destination||{}),routes:presets,customRoutes:saved,routeId:presets[0]?.id||null,mode:'view',mobile:'map',selection:null,viewer:null,anchor:null,photoMode:false,selectedStep:-1,editIndex:null,showStations:true,googleReady:false,streetProvider:'none',requestSeq:0,routeSeq:0,undo:[],layout:{left:270,right:window.innerWidth<1100?300:350,street:42,collapsed:window.innerWidth<1100},maps:{leaflet:null,google:null},layers:[],photoLayers:[],viewMarkers:[],googlePanorama:null,googleStreetService:null};
  try{const prefs=JSON.parse(localStorage.getItem('commute-planner-ui-v5')||'{}');for(const k of ['left','right','street'])if(Number.isFinite(prefs[k]))state.layout[k]=prefs[k];if(typeof prefs.collapsed==='boolean')state.layout.collapsed=prefs.collapsed;}catch(_){}
  state.layout.left=Math.max(210,Math.min(430,state.layout.left));state.layout.right=Math.max(260,Math.min(600,state.layout.right));state.layout.street=Math.max(25,Math.min(100,state.layout.street));
  let toastTimer,googleLoaderPromise;
  const allRoutes=()=>orderedRoutes([...state.routes,...state.customRoutes]);
  const currentRoute=()=>allRoutes().find(r=>r.id===state.routeId)||null;
  const isDrawing=()=>state.mode==='draw';
  function status(message){$('status-text').textContent=message;}
  function toast(message){$('toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').textContent='';},4200);status(message);}
  function setLink(element,url){try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.google.com','maps.google.com','console.cloud.google.com'].includes(u.hostname))throw 0;element.href=u.href;element.hidden=false;}catch(_){element.removeAttribute('href');element.hidden=true;}}
  const mapsStreetURL=p=>'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint='+encodeURIComponent(p.lat+','+p.lng);

  // Google consumer compatibility endpoint, not Maps Embed v1 or a paid SDK.
  // It redirects on Google's own host to /maps/embed. Coverage and future support vary.
  function legacyStreetURL(value,heading=0){const p=coord(value);if(!p)return null;const u=new URL('https://www.google.com/maps');u.searchParams.set('layer','c');u.searchParams.set('cbll',p.lat+','+p.lng);u.searchParams.set('cbp','11,'+(Number.isFinite(heading)?((heading%360)+360)%360:0)+',0,0,0');u.searchParams.set('output','svembed');return u.href;}
  function updateNearbyButton(){const near=state.selection&&nearbyStation(state.selection);$('nearby-street').disabled=!near||near.distance>1000;$('nearby-street').title=near&&near.distance<=1000?'查看相距約 '+Math.round(near.distance)+' 公尺的已收錄拍點':'1 公里內沒有已收錄拍點';}
  function showLegacyStreetV9(value,options={}){const p=coord(value);if(!p)return;guideRequested(p,Number.isFinite(options.heading)?options.heading:guideHeading(p));clearStreet();state.streetProvider='legacy';state.anchor=null;state.photoMode=false;$('photo-mode').setAttribute('aria-pressed','false');$('street-title').textContent='Google 街景';$('street-subtitle').textContent=p.lat.toFixed(5)+', '+p.lng.toFixed(5)+' · 要求位置（拍點未驗證）';updateNearbyButton();if(!measureStreetLayout()){smallStreetFallback();return;}state.smallStreetFallback=false;const frame=$('share-street');uxQueueStreetFrame(frame,legacyStreetURL(p,guide.heading));$('street-empty').hidden=true;state.viewer=null;state.streetRequestPending=false;$('street-status').textContent='已向 Google 請求此處街景，可在本框轉向、縮放與前進。若沒有影像，按「重載街景」或「附近拍點」。嵌入內移動無法回傳；加入路線採地圖選點。';renderSelection();drawViewerMarker();}
  function safeEmbed(row){try{const u=new URL(row?.embed_url||row?.url||'');return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname==='www.google.com'&&u.pathname==='/maps/embed'&&!u.hash&&u.searchParams.has('pb')&&row?.source==='google_share_embed_ui'?u.href:null;}catch(_){return null;}}
  function node(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e;}
  function showDialog(id){const d=$(id);if(typeof d.showModal==='function')d.showModal();else d.setAttribute('open','');}
  function closeDialog(id){const d=$(id);if(typeof d.close==='function')d.close();else d.removeAttribute('open');}
  function storeRoutesV9(){try{localStorage.setItem('commute-planner-routes-v5',JSON.stringify(state.customRoutes.map(exportRoute)));}catch(_){toast('瀏覽器未允許儲存；可改用匯出 JSON。');}}
  function saveLayout(){try{localStorage.setItem('commute-planner-ui-v5',JSON.stringify(state.layout));}catch(_){} }
  function applyLayout(){const root=document.documentElement;root.style.setProperty('--left',state.layout.left+'px');root.style.setProperty('--right',state.layout.right+'px');root.style.setProperty('--street',state.layout.street+'%');$('app').classList.toggle('collapsed-left',state.layout.collapsed);$('split-left').setAttribute('aria-valuenow',Math.round(state.layout.left));$('split-right').setAttribute('aria-valuenow',Math.round(state.layout.right));$('split-street').setAttribute('aria-valuenow',Math.round(state.layout.street));resizeMaps();}
  function measureStreetLayout(){const panel=$('right-panel'),display=$('street-display'),street=$('street-panel');const rect=panel.getBoundingClientRect();const height=Math.max(0,Math.floor(rect.height)),width=display.clientWidth||Math.max(0,Math.floor(rect.width));const chrome=(document.querySelector('.street-head')?.offsetHeight??42)+($('street-status').offsetHeight??34)+(document.querySelector('.street-tools')?.offsetHeight??64)+($('street-trouble-note').offsetHeight??32)+2;const guideChrome=($('street-guide')?.offsetHeight||0)+(document.querySelector('.guide-static-note')?.offsetHeight||0);const minPanelHeight=200+chrome+guideChrome;const possible=width>=200&&height>=minPanelHeight;const minPercent=height>0?Math.min(100,Math.ceil(minPanelHeight/height*100)):100;if(possible)state.layout.street=Math.min(100,Math.max(state.layout.street,minPercent));const full=document.fullscreenElement===panel||$('app').classList.contains('fullscreen-street')||(window.innerWidth<=760&&state.mobile==='street');const panelHeight=possible?(full?height:Math.min(height,Math.max(minPanelHeight,Math.ceil(height*state.layout.street/100)))):Math.max(0,Math.min(height,Math.ceil(height*state.layout.street/100)));street.style.height=panelHeight+'px';street.classList.toggle('viewport-small',!possible);$('split-street').setAttribute('aria-valuemin',minPercent);$('split-street').setAttribute('aria-valuemax',100);$('split-street').setAttribute('aria-valuenow',full?100:Math.round(state.layout.street));state.streetViewport={possible,width,availableHeight:height,chrome,minPanelHeight,minPercent,panelHeight,displayHeight:Math.max(0,panelHeight-chrome-guideChrome),minimumDisplayHeight:200};return possible;}
  function smallStreetFallback(){state.smallStreetFallback=true;for(const id of ['google-street','share-street','reference-photo'])$(id).hidden=true;uxCancelStreetFrame();state.viewer=coord(state.anchor)||null;$('street-empty').hidden=false;if(state.anchor)showReference(state.anchor);else $('street-empty').replaceChildren(node('strong',null,'請放大街景區'),node('p',null,'拖曳分隔線或按右上角放大，會在同頁重新載入選點街景。'));$('street-status').textContent='街景需要至少 200 × 200 像素；放大街景區後會恢復。';renderSelection();}
  function resizeMaps(){const wasSmall=state.smallStreetFallback;const enough=measureStreetLayout();if(!enough&&state.selection)smallStreetFallback();else if(enough&&wasSmall){state.smallStreetFallback=false;if(state.streetProvider==='legacy'&&state.selection)showLegacyStreet(state.selection);else if(state.anchor)showStation(state.anchor);else if(state.selection)showLegacyStreet(state.selection);}state.maps.leaflet?.invalidateSize({pan:false});}
  function resizeHandle(id,kind){const handle=$(id);let active=null;
    handle.addEventListener('pointerdown',ev=>{if(ev.button!==0)return;ev.preventDefault();active={x:ev.clientX,y:ev.clientY,start:state.layout[kind]};handle.setPointerCapture?.(ev.pointerId);});
    handle.addEventListener('pointermove',ev=>{if(!active)return;const bodyWidth=document.documentElement.clientWidth;const upperRight=Math.max(260,Math.min(600,bodyWidth-state.layout.left-240));if(kind==='left')state.layout.left=Math.max(210,Math.min(430,active.start+ev.clientX-active.x));if(kind==='right')state.layout.right=Math.max(260,Math.min(upperRight,active.start+active.x-ev.clientX));if(kind==='street'){const height=document.querySelector('.right-panel').getBoundingClientRect().height;state.layout.street=Math.max(25,Math.min(100,active.start+(ev.clientY-active.y)/height*100));}applyLayout();});
    const stop=()=>{if(active){active=null;saveLayout();}};for(const event of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(event,stop);
    handle.addEventListener('keydown',ev=>{const increase=(kind==='street'?['ArrowDown']:kind==='right'?['ArrowLeft']:['ArrowRight']).includes(ev.key);const decrease=(kind==='street'?['ArrowUp']:kind==='right'?['ArrowRight']:['ArrowLeft']).includes(ev.key);if(!increase&&!decrease)return;ev.preventDefault();state.layout[kind]+=(increase?1:-1)*(kind==='street'?3:15);state.layout.left=Math.max(210,Math.min(430,state.layout.left));state.layout.right=Math.max(260,Math.min(600,state.layout.right));state.layout.street=Math.max(25,Math.min(100,state.layout.street));applyLayout();saveLayout();});
  }
  function validSavedRoute(r){return !!(r&&typeof r.id==='string'&&typeof r.name==='string'&&Array.isArray(r.points)&&r.points.length<=200&&r.points.every(p=>coord(p))&&!('key'in r)&&!('apiKey'in r));}
  function exportRouteV9(r){const points=pointsOf(r).map(p=>({lat:p.lat,lng:p.lng,label:validName(p.label),road:validName(p.road),turnKind:validName(p.turnKind||'unknown'),...cleanAnnotation(p)}));const modelInputs={};for(const key of ['cruiseKph','trafficDelayMinutes','signalCount','redWaitSeconds','twoStageTurns','twoStageSeconds'])modelInputs[key]=typeof r.modelInputs?.[key]==='number'&&Number.isFinite(r.modelInputs[key])?r.modelInputs[key]:null;return {id:r.id,name:validName(r.name||r.label),label:validName(r.name||r.label),custom:true,points,path:points.map(coord),steps:[],source:'drawn_draft',status:'draft',distance:null,duration:null,distanceMeters:null,durationSeconds:null,computedAt:null,warnings:['已保存使用者畫點；畫點尚未貼齊道路；時間採人工假設。'],modelInputs,departure:r.departure||null,keepDestination:r.keepDestination===true};}
  function cleanAnnotation(p){const seconds=(v,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;return {signal:['yes','no'].includes(p.signal)?p.signal:'unknown',redWaitSeconds:seconds(p.redWaitSeconds,600),extraTurnSeconds:seconds(p.extraTurnSeconds,1200)};}
  function pointLedger(r){const result={markedSignals:0,unknownSignalPoints:0,twoStageTurns:0,unknownTurnPoints:0,recordedRedSeconds:0,recordedExtraTurnSeconds:0,missingRedWaits:0,missingTurnWaits:0};for(const p of pointsOf(r)){const a=cleanAnnotation(p);if(a.signal==='yes'){result.markedSignals++;if(a.redWaitSeconds==null)result.missingRedWaits++;else result.recordedRedSeconds+=a.redWaitSeconds;}else if(a.signal==='unknown')result.unknownSignalPoints++;if(p.turnKind==='two_stage'){result.twoStageTurns++;if(a.extraTurnSeconds==null)result.missingTurnWaits++;else result.recordedExtraTurnSeconds+=a.extraTurnSeconds;}else if(!['straight','right','left','start','arrival'].includes(p.turnKind))result.unknownTurnPoints++;}return result;}
  function toggleAllRoutesV12Legacy(){state.showAllRoutes=state.showAllRoutes===false;$('show-all-routes').setAttribute('aria-pressed',state.showAllRoutes);drawMap();}
  function newCommute(){const id='C'+Date.now().toString(36)+'-'+state.customRoutes.length;const r={id,name:'我的通勤方案 '+(state.customRoutes.length+1),custom:true,keepDestination:true,points:[{...coord(state.home),label:'住家',turnKind:'start',signal:'no'},{...coord(state.office),label:'公司',turnKind:'arrival',signal:'no'}],modelInputs:{}};state.customRoutes.push(r);state.routeId=id;state.undo=[];invalidateRoute(r);setModelInputs(r);setMode('draw');render();fitRoute();storeRoutes();toast('已放入住家與公司。看街景後加入的點會放在公司前面；連線仍是草稿。');}
  function renderPointLedgerV24(r){const box=$('point-ledger');box.replaceChildren();if(!r.custom){box.append(node('p','muted','複製此路線後，可逐點標註號誌與待轉。候選控制器數不等於必經號誌數。'));return;}const l=pointLedger(r);box.append(node('p',null,'已標號誌 '+l.markedSignals+' 處 · 號誌未知 '+l.unknownSignalPoints+' 點'),node('p',null,'已標待轉 '+l.twoStageTurns+' 次 · 轉法未知 '+l.unknownTurnPoints+' 點'),node('p',null,'已填停等 '+l.recordedRedSeconds+' 秒；額外待轉 '+l.recordedExtraTurnSeconds+' 秒'),node('p','muted','缺少等待數值：號誌 '+l.missingRedWaits+' 處／待轉 '+l.missingTurnWaits+' 處。僅統計已畫的點，不自動視為全程盤點，也不重加到 Google ETA。'));}
  function layoutPreset(kind){state.layout.left=kind==='map'?235:270;state.layout.right=kind==='street'?470:310;state.layout.street=kind==='street'?64:42;state.layout.collapsed=window.innerWidth<1100;applyLayout();saveLayout();}
  function openGoogleRouteBeforeHandoffV172(){const r=currentRoute();if(!r)return;const p=pointsOf(r);if(p.length<2){toast('先放入起點與終點。');return;}const box=$('google-route-parts');box.replaceChildren();for(let i=0;i<p.length-1;i+=4){const chunk=p.slice(i,i+5),u=new URL('https://www.google.com/maps/dir/');u.searchParams.set('api','1');u.searchParams.set('origin',chunk[0].lat+','+chunk[0].lng);u.searchParams.set('destination',chunk[chunk.length-1].lat+','+chunk[chunk.length-1].lng);if(chunk.length>2)u.searchParams.set('waypoints',chunk.slice(1,-1).map(x=>x.lat+','+x.lng).join('|'));const a=node('a','btn','第 '+(Math.floor(i/4)+1)+' 段：畫點 '+(i+1)+' → '+(i+chunk.length));a.target='_blank';a.rel='noopener noreferrer';a.href=u.href;box.append(a);}showDialog('google-route-dialog');}
  function fitCity(){const pts=presets.flatMap(r=>(r.segments||[]).filter(s=>!s.id.startsWith('COMMON_')).flatMap(s=>s.path||[])).map(coord).filter(Boolean);if(pts.length&&state.maps.leaflet)state.maps.leaflet.fitBounds(L.latLngBounds(pts),{padding:[35,35],maxZoom:17});return pts.length;}
  function bindV7(){state.showAllRoutes=true;state.showStations=false;$('toggle-stations').setAttribute('aria-pressed','false');$('show-all-routes').setAttribute('aria-pressed','true');$('show-all-routes').addEventListener('click',toggleAllRoutes);$('new-commute').addEventListener('click',newCommute);$('layout-map').addEventListener('click',()=>layoutPreset('map'));$('layout-street').addEventListener('click',()=>layoutPreset('street'));$('google-route-link').addEventListener('click',openGoogleRoute);$('fit-city').addEventListener('click',fitCity);}
  function clearGoogleResults(){state.customRoutes=state.customRoutes.map(r=>r.source==='google_routes'?exportRoute(r):r);}
  function pointForAdd(){return state.googleReady&&state.viewer?coord(state.viewer):coord(state.selection)||coord(state.viewer);}

  function routeCaption(r){return r.name||r.label||r.id;}
  function routeStationIds(r){if(Array.isArray(r.stationIds))return r.stationIds;if(Array.isArray(data.stationRoutes?.[r.id]))return data.stationRoutes[r.id];if(Array.isArray(data.routes?.[r.id]))return data.routes[r.id];return stations.filter(s=>!s.routes||s.routes.includes(r.id)).map(s=>s.id);}
  function nearbyStation(p){let nearest=null,min=Infinity;for(const s of stations){const d=distance(p,s);if(d<min){nearest=s;min=d;}}return nearest?{station:nearest,distance:min}:null;}
  function displayKind(kind,fallback){return ({whole_route_not_measured:'全程尚未計算',historical_google_screenshot_estimate:'Google 舊截圖',provider_prediction:'Google 機車車流預估',google_routes:'Google 機車車流預估',drawn_draft:'畫點連線長度',manual_model:'人工假設模型'})[kind]||fallback;}
  function completeModel(value){return ['cruiseKph','trafficDelayMinutes','signalCount','redWaitSeconds','twoStageTurns','twoStageSeconds'].every(k=>typeof value?.[k]==='number'&&Number.isFinite(value[k]));}
  function routeMetricsV11(r){let dist=r.distanceMeters??r.distance?.meters??null,seconds=r.durationSeconds??r.duration?.seconds??null;const draft=r.custom&&r.source!=='google_routes';if(draft){const path=pathOf(r);dist=engine.distanceMeters?engine.distanceMeters(path):path.slice(1).reduce((a,p,i)=>a+distance(path[i],p),0);seconds=null;if(path.length>=2&&completeModel(r.modelInputs)&&engine.estimateCandidate){try{seconds=engine.estimateCandidate({path,...r.modelInputs}).totalSeconds;}catch(_){seconds=null;}}}return {dist,seconds,draft,distanceKind:draft?'畫點連線長度':displayKind(r.distance?.kind,r.source==='google_routes'?'Google 道路里程':'全程尚未計算'),timeKind:draft?'人工假設模型':displayKind(r.duration?.kind,r.source==='google_routes'?'Google 機車車流預估':'未量測')};}

  const kmLabel=n=>typeof n==='number'&&Number.isFinite(n)?(n/1000).toFixed(2)+' km':'—';
  const minuteLabel=n=>typeof n==='number'&&Number.isFinite(n)?Math.round(n/60)+' 分':'—';
  function renderRouteListV9(){const box=$('route-list');box.replaceChildren();for(const r of state.routes){const b=node('button','route-card');b.style.setProperty('--route',r.color||(r.id==='A'?'#176ac0':'#07846a'));b.setAttribute('aria-pressed',r.id===state.routeId);b.append(node('strong',null,routeCaption(r)));const m=routeMetrics(r);b.append(node('small','muted',kmLabel(m.dist)+' · '+minuteLabel(m.seconds)+(m.seconds!=null?'（'+m.timeKind+'）':'')));b.addEventListener('click',()=>selectRoute(r.id));box.append(b);}const savedBox=$('saved-routes');savedBox.replaceChildren();if(!state.customRoutes.length)savedBox.append(node('p','saved-empty','尚未儲存自訂路線'));for(const r of state.customRoutes){const row=node('div','compact-row'),b=node('button','grow',routeCaption(r));b.setAttribute('aria-pressed',r.id===state.routeId);b.addEventListener('click',()=>selectRoute(r.id));const del=node('button','danger','×');del.setAttribute('aria-label','刪除 '+routeCaption(r));del.addEventListener('click',()=>{if(!window.confirm('刪除「'+routeCaption(r)+'」？'))return;state.customRoutes=state.customRoutes.filter(x=>x.id!==r.id);storeRoutes();if(state.routeId===r.id)state.routeId=state.routes[0]?.id;render();});row.append(b,del);savedBox.append(row);}}
  function getModelInputs(){const value=id=>{const s=String($(id).value??'').trim();return s===''?null:Number(s);};return {cruiseKph:value('cruise-kph'),trafficDelayMinutes:value('traffic-delay'),signalCount:value('signal-count'),redWaitSeconds:value('red-wait'),twoStageTurns:value('two-stage-count'),twoStageSeconds:value('two-stage-seconds')};}
  function setModelInputs(r){const obj=r.modelInputs||{};for(const [id,key,fallback]of [['cruise-kph','cruiseKph',25],['traffic-delay','trafficDelayMinutes',''],['signal-count','signalCount',''],['red-wait','redWaitSeconds',''],['two-stage-count','twoStageTurns',''],['two-stage-seconds','twoStageSeconds','']])$(id).value=obj[key]??fallback;}
  function modelEstimateV12Legacy(r){if(!engine.estimateCandidate)return null;const v=getModelInputs();const safe={cruiseKph:v.cruiseKph??25,trafficDelayMinutes:v.trafficDelayMinutes??0,signalCount:v.signalCount??0,redWaitSeconds:v.redWaitSeconds??0,twoStageTurns:v.twoStageTurns??0,twoStageSeconds:v.twoStageSeconds??0};try{return engine.estimateCandidate({path:pathOf(r),...safe});}catch(err){status('時間模型輸入不正確：'+cleanError(err));return null;}}
  function renderResultsV9(){const r=currentRoute();if(!r)return;const m=routeMetrics(r);$('current-route-name').textContent=routeCaption(r);$('map-route-label').textContent=routeCaption(r);$('custom-name').value=r.custom?routeCaption(r):'';$('distance-value').textContent=kmLabel(m.dist);$('duration-value').textContent=minuteLabel(m.seconds);$('distance-note').textContent=m.distanceKind+(r.distanceScope?' · '+r.distanceScope:'');$('duration-note').textContent=m.seconds==null?'未取得完整機車行程時間':m.timeKind;$('route-badges').replaceChildren(node('span','pill',r.source==='google_routes'?'Google 機車服務':r.custom?'自訂草稿':'通勤候選'),node('span','pill',r.custom?pointsOf(r).length+' 個畫點':'現場轉向待核對'));$('route-warning').textContent=r.source==='google_routes'?'Google 機車預估；待轉與禁行標誌請逐路口核對。':r.custom?'草稿連線未吸附道路，需重算機車路線。':r.id==='B'?'路線資料未完整計算；入口銜接及轉法請核對現場。':'部分路段銜接未確認，全程公里／時間尚未計算。';const detail=$('route-warning-details');if(detail){detail.replaceChildren();for(const warning of r.warnings||[])detail.append(node('p','muted',warning));};$('undo-button').disabled=!state.undo.length;$('clear-points').disabled=!r.custom;$('compute-google').disabled=!state.googleReady||pointsOf(r).length<2;renderModel(r);renderSignalEvidence(r);renderPointLedger(r);}
  function renderModelV12Legacy(r){const box=$('time-components');box.replaceChildren();const model=modelEstimate(r);if(!model)return;const comps=model.components||{};const inputs=getModelInputs();const movement=model.movingSeconds??model.cruiseSeconds??comps.movingSeconds??comps.cruiseSeconds??comps.movementSeconds;const lights=inputs.signalCount==null||inputs.redWaitSeconds==null?null:(model.signalDelaySeconds??comps.signalDelaySeconds??comps.signalSeconds);const turns=inputs.twoStageTurns==null||inputs.twoStageSeconds==null?null:(model.twoStageDelaySeconds??comps.twoStageDelaySeconds??comps.twoStageSeconds);const traffic=inputs.trafficDelayMinutes==null?null:(model.trafficDelaySeconds??comps.trafficDelaySeconds??comps.trafficSeconds);const unresolved=r.segments?.some(s=>String(s.status||'').startsWith('unresolved'));const complete=lights!=null&&turns!=null&&traffic!=null&&!unresolved;const total=complete?(model.totalSeconds??model.durationSeconds):null;for(const [label,value]of [[unresolved?'候選線移動（含缺口）':'人工移動時間',minuteLabel(movement)],['號誌（你輸入的假設）',lights==null?'未知':minuteLabel(lights)],['待轉（你輸入的假設）',turns==null?'未知':minuteLabel(turns)],['壅塞（你輸入的假設）',traffic==null?'未知':minuteLabel(traffic)],['人工模型合計',total==null?(unresolved?'道路未完整':'等待未納入'):minuteLabel(total)]])box.append(node('span',null,label),node('b',null,value));if(!complete)box.append(node('span','muted','完整通勤時間'),node('span','muted','資料不足，無法排名'));if(r.custom&&r.source!=='google_routes')$('duration-note').textContent='人工模型另列；草稿連線不代表可騎道路';}
  function renderSignalEvidence(r){const rows=(data.signalEvidence||[]).filter(x=>(x.routes||[]).includes(r.id));$('signal-summary').textContent='號誌候選 '+rows.length+' 處（未確認經過／等待）';const box=$('signal-evidence');box.replaceChildren();if(!rows.length){box.append(node('p','muted','此路線尚未取得可匹配的號誌資料；不以 0 處代表沒有紅綠燈。'));return;}for(const row of rows){const b=node('button',null,row.name||row.id);b.style.whiteSpace='normal';b.style.textAlign='left';b.style.fontSize='11px';b.addEventListener('click',()=>{const p=coord(row);if(p){selectLocation(p,{label:'號誌候選：'+(row.name||row.id)});panTo(p);}});box.append(b);}}
  function renderEndpointsV14(){$('home-label').textContent=state.home.address||state.home.label||'住家';$('office-label').textContent=state.office.address||state.office.label||'公司';$('home-status').textContent=coord(state.home)?(state.home.confidence||'已定位；入口與車道仍需核對'):'尚未定位；請輸入座標或點地圖指定';$('office-status').textContent=coord(state.office)?(state.office.confidence||'目的地入口以現場確認'):'尚未定位';}
  function renderV9(){renderEndpoints();renderRouteList();renderResults();renderSteps();drawMap();}
  function iconFor(kind){return ({straight:'↑',right:'↱',left:'↰',two_stage:'待',two_stage_left:'待',twoStage:'待',arrival:'●',start:'●',roundabout:'⟳',unknown:'?'})[kind]||'?';}
  function turnTitle(kind){return ({straight:'續行',continue:'續行',right:'右轉',left:'左轉',two_stage:'待轉',two_stage_left:'待轉',arrival:'到達',start:'出發',depart:'出發',roundabout:'圓環',uturn:'迴轉',merge:'匯入'})[kind]||'轉向／續行';}
  function instructionsOf(r){if(!r.custom)return r.steps||[];if(r.source==='google_routes'&&r.steps?.length)return r.steps;return pointsOf(r).map((p,i)=>({road:p.road||p.label||'畫點 '+(i+1),instruction:i===0?'從這個畫點出發':p.instruction||'到此畫點；相鄰連線尚未吸附道路',turnKind:p.turnKind||'unknown',start:p,confirmed:false,warning:'這是自行畫的點；道路銜接與現場轉法尚未確認。'}));}
  function pointEditorV9(r,i,s){
    const p=pointsOf(r)[i]||{},a=cleanAnnotation(p),edit=node('div','step-edit visible'),road=node('input');
    road.value=p.road||s.road||'';road.setAttribute('aria-label','畫點 '+(i+1)+' 道路名稱');road.placeholder='路名／看到的地標';
    const turn=node('select');for(const [v,t]of [['unknown','轉法未知'],['start','起點'],['arrival','終點'],['straight','直行'],['right','右轉'],['left','左轉：現場規定待核對'],['two_stage','已標註兩段式待轉']]){const op=node('option',null,t);op.value=v;turn.append(op);}turn.value=p.turnKind||'unknown';turn.setAttribute('aria-label','畫點 '+(i+1)+' 轉法');
    const signal=node('select');for(const [v,t]of [['unknown','號誌：未知'],['yes','此處有號誌'],['no','此處無號誌']]){const op=node('option',null,t);op.value=v;signal.append(op);}signal.value=a.signal;signal.setAttribute('aria-label','畫點 '+(i+1)+' 號誌');
    const wait=node('input'),extra=node('input');for(const [el,value,max,label]of [[wait,a.redWaitSeconds,600,'這次號誌停等（秒）'],[extra,a.extraTurnSeconds,1200,'額外待轉停等（秒）']]){el.type='number';el.min='0';el.max=String(max);el.step='1';el.value=value==null?'':String(value);el.placeholder=label;el.setAttribute('aria-label','畫點 '+(i+1)+' '+label);}
    road.addEventListener('change',()=>updatePointMeta(i,{road:validName(road.value)}));turn.addEventListener('change',()=>updatePointMeta(i,{turnKind:turn.value}));signal.addEventListener('change',()=>updatePointMeta(i,{signal:signal.value}));
    const setSeconds=(el,key,max)=>{const value=el.value.trim()===''?null:Number(el.value);if(value!==null&&(!Number.isFinite(value)||value<0||value>max)){toast('秒數必須介於 0 與 '+max+'；留白表示未知。');return;}updatePointMeta(i,{[key]:value});};wait.addEventListener('change',()=>setSeconds(wait,'redWaitSeconds',600));extra.addEventListener('change',()=>setSeconds(extra,'extraTurnSeconds',1200));
    const actions=node('div','compact-row full'),insert=node('button',null,'在後方插入'),del=node('button','danger','刪除此點');insert.addEventListener('click',()=>{state.editIndex=i+1;setMode('draw');toast('選位置後按「加入路線」，會插入在第 '+(i+1)+' 點之後。');});del.addEventListener('click',()=>deletePoint(i));actions.append(insert,del);edit.append(road,turn,signal,wait,extra,actions);return edit;
  }
  function renderStepsV11(){const r=currentRoute(),box=$('steps-list');box.replaceChildren();if(!r)return;const steps=instructionsOf(r);$('step-count').textContent=steps.length+' 個步驟';if(!steps.length){box.append(node('p','unsupported','先選路線，或切換「繪製路線」並加入畫點。'));return;}steps.forEach((s,i)=>{const card=node('article','step-card'+(state.selectedStep===i?' active':''));const button=node('button','step-select'),main=node('div','step-main');button.append(node('span','step-icon',iconFor(s.turnKind||s.action)),main);main.append(node('strong',null,s.road?(i+1)+'. '+s.road:'步驟 '+(i+1)+'・'+turnTitle(s.turnKind||s.action)),node('span',null,s.instruction||'轉向與銜接待確認'));if(s.distanceMeters!=null)main.append(node('span',null,Math.round(s.distanceMeters)+' m'));button.addEventListener('click',()=>{state.selectedStep=i;const id=s.stationId||s.photoId;const p=coord(s.start||s.startLocation||s.point)||coord(pointsOf(r)[i]);if(id&&stations.some(st=>st.id===id))selectStation(id);else if(p)selectLocation(p,{label:s.road||'步驟 '+(i+1),fromStep:true});renderSteps();});card.append(button);if(s.warning||!s.confirmed)card.append(node('div','step-warning',s.warning||'待核對現場標誌、車道與待轉方式。'));if(r.custom&&r.source!=='google_routes')card.append(pointEditor(r,i,s));box.append(card);});if(r.custom&&r.source==='google_routes'){box.append(node('h3',null,'編輯機車計算的途經畫點'));pointsOf(r).forEach((p,i)=>{const card=node('article','step-card');card.append(node('p','muted','畫點 '+(i+1)+' · '+(p.label||p.road||p.lat.toFixed(5)+','+p.lng.toFixed(5))),pointEditor(r,i,p));box.append(card);});}}
  function setModeV10(mode){state.mode=mode==='draw'?'draw':'view';$('mode-view').setAttribute('aria-pressed',state.mode==='view');$('mode-draw').setAttribute('aria-pressed',isDrawing());$('mode-note').textContent=isDrawing()?'先看街景，按「加入路線」才加點；可拖曳畫點':'點地圖查看周圍；不會改動路線';$('add-point').hidden=!isDrawing();$('set-origin').hidden=!isDrawing();$('set-destination').hidden=!isDrawing();drawMap();status(isDrawing()?'繪製模式：先選位置與街景，再加入路線。':'查看模式：點選地圖不會變更路線。');}
  function selectRouteV9(id,options={}){if(!allRoutes().some(r=>r.id===id))return;state.routeId=id;state.selectedStep=-1;state.undo=[];state.editIndex=null;state.routeSeq++;setModelInputs(currentRoute());render();if(!options.keepViewport)fitRoute();const ids=routeStationIds(currentRoute());if(!options.skipStation&&ids.length&&stations.some(s=>s.id===ids[0]))selectStation(ids[0]);status('已切換 '+routeCaption(currentRoute()));}
  function pushUndo(){const r=currentRoute();state.undo.push({routeId:r.id,snapshot:clone(r)});if(state.undo.length>60)state.undo.shift();$('undo-button').disabled=false;}
  function ensureCustomV9(){const r=currentRoute();if(r?.custom)return r;const id='C'+Date.now().toString(36)+'-'+state.customRoutes.length;const sourcePoints=r?pointsOf(r):[];const custom={id,name:(r?routeCaption(r):'新路線')+'・自訂',label:'自訂路線',custom:true,points:sourcePoints,path:sourcePoints.map(coord),steps:[],source:'drawn_draft',status:'draft',warnings:['畫點連線尚未吸附道路；修改後需重新計算機車路線。'],modelInputs:r?.modelInputs||{}};state.customRoutes.push(custom);state.routeId=id;state.undo=[];return custom;}
  function invalidateRouteV9(r){r.path=r.points.map(coord).filter(Boolean);r.geometry=r.path;r.steps=[];r.source='drawn_draft';r.status='draft';r.distance=null;r.duration=null;r.distanceMeters=null;r.durationSeconds=null;r.computedAt=null;r.warnings=['畫點連線尚未吸附道路；修改後需重新計算機車路線。'];state.routeSeq++;}
  function newCustomV9(empty=false){const r=ensureCustom();if(empty){r.name='我的新路線';r.points=[];invalidateRoute(r);}setMode('draw');render();storeRoutes();status(empty?'已建立空白路線；先看街景再加入畫點。':'已複製為自訂路線，可拖曳畫點。');}
  function addSelectedPointV9(){if(!isDrawing()){toast('請先切換到「繪製路線」。');return;}const p=pointForAdd();if(!p){toast('先點地圖，或選擇一張街景。');return;}const r=ensureCustom();if(r.points.length>=200){toast('每條路線最多 200 個畫點。');return;}pushUndo();const value={...p,label:state.anchor?.road||state.selection?.label||'畫點 '+(r.points.length+1),road:'',turnKind:'unknown',source:state.googleReady&&state.viewer?'google_streetview_position':'user_map_point'};if(Number.isInteger(state.editIndex))r.points.splice(state.editIndex,0,value);else if(r.keepDestination&&r.points.length>=2)r.points.splice(r.points.length-1,0,value);else r.points.push(value);state.editIndex=null;invalidateRoute(r);state.selectedStep=r.points.indexOf(value);render();storeRoutes();toast('已加入目前'+(state.googleReady&&state.viewer?'街景拍點':'選定位置')+'；路線需重新計算。');}
  function deletePointV9(index){const r=currentRoute();if(!r?.custom||index<0||index>=r.points.length)return;pushUndo();r.points.splice(index,1);invalidateRoute(r);state.selectedStep=-1;render();storeRoutes();}
  function movePointV9(index,p){const r=currentRoute();if(!r?.custom||!coord(p)||index<0||index>=r.points.length)return;pushUndo();r.points[index]={...r.points[index],...coord(p)};invalidateRoute(r);render();storeRoutes();}
  function updatePointMetaV9(index,patch){const r=currentRoute();if(!r?.custom||!r.points[index])return;pushUndo();Object.assign(r.points[index],patch);renderResults();renderSteps();storeRoutes();}
  function undoV10(){const old=state.undo.pop();if(!old)return;const index=state.customRoutes.findIndex(r=>r.id===old.routeId);if(index<0)return;state.customRoutes[index]=old.snapshot;state.routeId=old.routeId;state.routeSeq++;render();storeRoutes();status('已復原上一項路線編輯。');}
  function clearStreet(){state.streetProvider='none';state.streetRequestPending=true;if(state.googlePanorama)state.googlePanorama.setVisible(false);for(const id of ['google-street','share-street','reference-photo'])$(id).hidden=true;uxCancelStreetFrame();$('street-empty').hidden=false;$('street-empty').replaceChildren(node('strong',null,'這裡沒有可顯示的內嵌街景'),node('p',null,'可外開 Google 尋找附近影像，或改點已收錄拍點。'));state.viewer=null;drawViewerMarker();renderSelection();}
  function showNearbyStreet(){const p=coord(state.selection);if(!p)return;const near=nearbyStation(p);if(!near||near.distance>1000){toast('1 公里內沒有已收錄拍點；可在本頁重載所選位置街景。');return;}showStation(near.station,near.distance);drawMap();}
  function showMissingStreet(p){showLegacyStreet(p);}
  function showReference(station){const image=station.image||station.image_data||station.photo;if(typeof image==='string'&&image.startsWith('data:image/')){$('reference-photo').src=image;$('reference-photo').alt=(station.id||'')+' '+(station.road||station.title||'路口')+'參考照片';$('reference-photo').hidden=false;$('street-empty').hidden=true;}else{$('street-empty').hidden=false;$('street-empty').replaceChildren(node('p',null,'此拍點沒有可用參考照片；可改用 Google 街景。'));}}
  function showStation(station,selectedDistance=0){guideRequested(station,null,'station');clearStreet();state.streetProvider='share';state.anchor=station;updateNearbyButton();$('street-title').textContent=station.road||station.title||station.id;$('street-subtitle').textContent=station.id+' · '+(station.date||'歷史街景');if(!measureStreetLayout()){smallStreetFallback();setLink($('open-street-google'),station.url||mapsStreetURL(station));return;}state.smallStreetFallback=false;state.photoMode=false;$('photo-mode').setAttribute('aria-pressed',false);$('street-title').textContent=station.road||station.title||station.id;$('street-subtitle').textContent=station.id+' · '+(selectedDistance>0?'距選點約 '+Math.round(selectedDistance)+' 公尺 · ':'')+(station.date||'歷史街景');const row=embedById.get(station.id)||station.embed;const url=safeEmbed(row||{embed_url:station.embed_url,source:station.embed_source});if(url){uxQueueStreetFrame($('share-street'),url);$('street-empty').hidden=true;}else showReference(station);state.viewer={lat:station.lat,lng:station.lng};state.streetRequestPending=false;$('street-status').textContent=(selectedDistance>0?'附近收錄拍點，距你點的位置約 '+Math.round(selectedDistance)+' m。':'')+(station.caution||station.status||'歷史街景；目前車道與號誌仍須核對。')+' 分享街景移動無法同步；加入路線仍採'+(selectedDistance>0?'你原本選的位置。':'此拍點。');setLink($('open-street-google'),station.url||mapsStreetURL(station));drawViewerMarker();renderSelection();}
  function selectStation(id){const s=stations.find(x=>x.id===id);if(!s)return;state.requestSeq++;state.anchor=s;state.selection={lat:s.lat,lng:s.lng,label:s.road||s.title||s.id,source:'known_station'};renderSelection();if(state.googleReady)queryGoogleStreet(state.selection,{station:s,heading:s.heading});else showStation(s);drawMap();}
  function selectLocationV9(p,options={}){p=coord(p);if(!p)return;state.requestSeq++;state.selection={...p,label:options.label||'地圖點選位置',source:'map_click'};state.anchor=null;state.viewer=null;state.photoMode=false;renderSelection();showLegacyStreet(p,{heading:options.heading});drawMap();}
  function renderSelectionV9(){$('add-viewpoint').textContent=state.googleReady&&state.viewer&&!state.photoMode&&!state.smallStreetFallback?'加入街景位置':'加入點選位置';$('add-viewpoint').title=state.googleReady?'加入目前查到的街景拍點坐標':'分享街景內移動無法同步；加入原始點選坐標';const s=state.selection;if(!s){$('selected-position').classList.remove('visible');return;}$('selected-position').classList.add('visible');$('selected-label').textContent=s.label||'選定位置';const p=pointForAdd()||coord(s);$('selected-coord').textContent=p.lat.toFixed(6)+', '+p.lng.toFixed(6);$('selection-source').textContent=state.googleReady&&state.viewer&&!state.smallStreetFallback?'目前街景真實拍點；「加入路線」會用此位置':state.anchor?'參考街景為附近拍點；加入路線仍採你選的位置，分享街景移動無法同步':'你點選的地圖位置';setLink($('selected-google'),mapsStreetURL(p));$('add-point').hidden=!isDrawing();$('set-origin').hidden=!isDrawing();$('set-destination').hidden=!isDrawing();}
  async function queryGoogleStreet(p,options={}){const seq=++state.requestSeq;clearStreet();if(!measureStreetLayout()){state.anchor=options.station||null;$('street-title').textContent=options.station?.road||'查看點選位置';smallStreetFallback();setLink($('open-street-google'),mapsStreetURL(p));return;}state.smallStreetFallback=false;$('street-title').textContent=options.station?.road||'尋找附近街景';$('street-subtitle').textContent=p.lat.toFixed(5)+', '+p.lng.toFixed(5);$('street-status').textContent='正在尋找 50 公尺內的 Google 戶外街景…';setLink($('open-street-google'),mapsStreetURL(p));try{const sv=await google.maps.importLibrary('streetView');if(seq!==state.requestSeq)return;const service=state.googleStreetService||(state.googleStreetService=new sv.StreetViewService());const response=await service.getPanorama({location:p,radius:50,sources:[sv.StreetViewSource?.OUTDOOR||google.maps.StreetViewSource.OUTDOOR],preference:sv.StreetViewPreference?.NEAREST||google.maps.StreetViewPreference.NEAREST});if(seq!==state.requestSeq)return;if(!measureStreetLayout()){state.anchor=options.station||null;smallStreetFallback();return;}const panorama=response.data||response,real=coord(panorama.location?.latLng);if(!real||!panorama.location?.pano)throw new Error('Google 未回傳可用的拍點。');$('google-street').hidden=false;$('street-empty').hidden=true;if(!state.googlePanorama){state.googlePanorama=new sv.StreetViewPanorama($('google-street'),{addressControl:true,linksControl:true,panControl:true,enableCloseButton:false,fullscreenControl:true,visible:true});state.googlePanorama.addListener('position_changed',()=>{if(!state.googleReady||state.streetRequestPending)return;const current=coord(state.googlePanorama.getPosition());if(!current)return;state.viewer=current;renderSelection();drawViewerMarker();$('street-subtitle').textContent=current.lat.toFixed(5)+', '+current.lng.toFixed(5)+' · 可用目前位置加點';setLink($('open-street-google'),mapsStreetURL(current));});}
      state.googlePanorama.setPano(panorama.location.pano);state.googlePanorama.setPov({heading:Number.isFinite(options.heading)?options.heading:0,pitch:0});state.googlePanorama.setVisible(true);state.viewer=real;state.streetRequestPending=false;state.anchor=options.station||null;const dt=panorama.imageDate||'影像日期未提供';$('street-title').textContent=panorama.location.shortDescription||panorama.location.description||options.station?.road||'Google 街景';$('street-status').textContent='影像 '+dt+'；拍點距你點的位置約 '+Math.round(distance(p,real))+' m。街景視角不代表機車車道；可在街景中前進，再按「加入路線」。';renderSelection();drawViewerMarker();setLink($('open-street-google'),mapsStreetURL(real));resizeMaps();
    }catch(err){if(seq!==state.requestSeq)return;clearStreet();$('street-title').textContent='這裡暫無可用街景';$('street-status').textContent='50 公尺內查不到可用戶外街景，或 API 設定未完成。'+cleanError(err);status('街景未載入；可選附近道路或外開 Google。');}}
  function resetStreet(){if(!state.selection)return;if(state.selection.source==='known_station'&&state.anchor){selectStation(state.anchor.id);return;}showLegacyStreet(state.selection);drawMap();}
  function togglePhoto(){const s=state.anchor;if(!s){toast('此位置沒有收錄參考照片。');return;}state.photoMode=!state.photoMode;$('photo-mode').setAttribute('aria-pressed',state.photoMode);if(state.photoMode){if(state.googlePanorama)state.googlePanorama.setVisible(false);state.viewer=coord(s);renderSelection();drawViewerMarker();$('google-street').hidden=true;$('share-street').hidden=true;showReference(s);$('street-status').textContent=s.caution||s.status||'歷史照片，現況以現場核對。';}else if(state.googleReady)queryGoogleStreet(state.selection,{station:s,heading:s.heading});else showStation(s);}
  function stationDirection(delta){const r=currentRoute();if(!r)return;const ids=routeStationIds(r).filter(id=>stations.some(s=>s.id===id));const i=ids.indexOf(state.anchor?.id),j=i<0?0:Math.max(0,Math.min(ids.length-1,i+delta));if(ids[j])selectStation(ids[j]);}
  function initLeaflet(){initGlobalMapV28();}
  function drawOfflineRoads(){if(!state.maps.leaflet)return;const mapdata=data.map||data.offlineMap||{};const rows=mapdata.roads||mapdata.road_lines||[];const group=L.layerGroup().addTo(state.maps.leaflet);for(const row of rows){let points=Array.isArray(row)?row:(row.points||row.path||row.coords||row.coordinates);if(!Array.isArray(points))continue;const converted=points.map(p=>Array.isArray(p)?(Math.abs(p[0])>90?{lat:p[1],lng:p[0]}:{lat:p[0],lng:p[1]}):coord(p)).filter(coord);if(converted.length>1)L.polyline(converted,{color:'#c2cfca',weight:2.5,interactive:false}).addTo(group);}state.offlineRoadLayer=group;}
  function clearLayers(){for(const layer of state.layers){if(layer.remove)layer.remove();else if(layer.setMap)layer.setMap(null);}state.layers=[];}
  function lineSegmentsV9(route){if(!route.custom&&Array.isArray(route.segments)&&route.segments.length){return route.segments.map(s=>({path:(s.path||s.geometry||s.points||[]).map(coord).filter(Boolean),dashed:String(s.status||'').startsWith('unresolved')||s.uncertain===true,label:s.label||s.road||s.id||'候選路段',status:s.status,warning:s.warning})).filter(s=>s.path.length>1);}return [{path:pathOf(route),dashed:route.source!=='google_routes',label:routeCaption(route)}];}
  function drawMapV9(){clearLayers();const r=currentRoute();if(!r)return;const isGoogle=state.googleReady&&state.maps.google;const routes=allRoutes().filter(x=>(x.id===state.routeId||state.compareOverlay||state.showAllRoutes)&&(state.googleReady||x.source!=='google_routes'));for(const route of routes){const active=route.id===state.routeId,color=route.color||(route.id==='A'?'#176ac0':route.id==='B'?'#07846a':'#a34bb7');for(const seg of lineSegments(route)){const path=seg.path;if(path.length<2)continue;if(isGoogle){const line=new google.maps.Polyline({map:state.maps.google,path,strokeColor:color,strokeWeight:active?6:3,strokeOpacity:active?.9:.45,clickable:true,...(seg.dashed?{strokeOpacity:0,icons:[{icon:{path:'M 0,-1 0,1',strokeOpacity:1,scale:3},offset:'0',repeat:'14px'}]}:{})});line.addListener('click',ev=>{if(route.id!==state.routeId)selectRoute(route.id,{keepViewport:true,skipStation:true});selectLocation(coord(ev.latLng),{label:seg.label+(seg.dashed?'（銜接待確認）':'')});});state.layers.push(line);}else if(state.maps.leaflet){const line=L.polyline(path,{color,weight:active?6:3,opacity:active?.9:.4,dashArray:seg.dashed?'9 7':null});line.on('click',e=>{L.DomEvent.stopPropagation(e);if(route.id!==state.routeId)selectRoute(route.id,{keepViewport:true,skipStation:true});selectLocation(productMapCoord(e.latlng),{label:seg.label+(seg.dashed?'（銜接待確認）':'')});});line.bindTooltip?.(node('span',null,seg.label+(seg.dashed?' · 尚未確認沿道路銜接':'')));line.addTo(state.maps.leaflet);state.layers.push(line);}}}
    for(const [value,label,office]of [[state.home,'起',false],[state.office,'終',true]]){const p=coord(value);if(!p)continue;if(isGoogle){const m=new google.maps.Marker({map:state.maps.google,position:p,label,title:value.label||value.address});m.addListener('click',()=>selectLocation(p,{label:value.label||value.address}));state.layers.push(m);}else if(state.maps.leaflet){const icon=L.divIcon({className:'home-marker'+(office?' office-marker':''),html:label,iconSize:[28,28]});const m=L.marker(p,{icon}).addTo(state.maps.leaflet).on('click',()=>selectLocation(p,{label:value.label||value.address}));state.layers.push(m);}}
    drawPhotoMarkers();drawViewerMarker();}
  function drawPhotoMarkers(){for(const m of state.photoLayers){if(m.remove)m.remove();else if(m.setMap)m.setMap(null);}state.photoLayers=[];if(!state.showStations)return;const ids=routeStationIds(currentRoute()||{});for(const s of stations.filter(s=>ids.includes(s.id))){let marker;if(state.googleReady&&state.maps.google){marker=new google.maps.Marker({map:state.maps.google,position:s,label:{text:s.id,fontSize:'9px'},title:s.road||s.title});marker.addListener('click',()=>selectStation(s.id));}else if(state.maps.leaflet){marker=L.marker(s,{icon:L.divIcon({className:'photo-marker',html:s.id,iconSize:[31,20]}),riseOnHover:true}).addTo(state.maps.leaflet).on('click',()=>selectStation(s.id));marker.bindTooltip(node('span',null,s.id+' '+(s.road||s.title||'')));}if(marker)state.photoLayers.push(marker);}}
  function drawViewerMarkerV22(){for(const m of state.viewMarkers){if(m.remove)m.remove();else if(m.setMap)m.setMap(null);}state.viewMarkers=[];const p=coord(state.viewer)||coord(state.selection);if(!p)return;if(state.googleReady&&state.maps.google){const m=new google.maps.Marker({map:state.maps.google,position:p,title:'目前街景／選定位置',icon:{path:google.maps.SymbolPath.CIRCLE,scale:7,fillColor:'#a34bb7',fillOpacity:1,strokeWeight:2,strokeColor:'#fff'}});state.viewMarkers.push(m);}else if(state.maps.leaflet){state.viewMarkers.push(L.marker(p,{icon:L.divIcon({className:'view-marker',iconSize:[18,18]}),interactive:false}).addTo(state.maps.leaflet));}}
  function fitRouteV12Legacy(){const r=currentRoute();if(!r)return;const pts=[coord(state.home),...pathOf(r),coord(state.office)].filter(Boolean);if(!pts.length)return;if(state.googleReady&&state.maps.google){const b=new google.maps.LatLngBounds();pts.forEach(p=>b.extend(p));state.maps.google.fitBounds(b,55);}else if(state.maps.leaflet)state.maps.leaflet.fitBounds(L.latLngBounds(pts),{padding:[40,40],maxZoom:16});}
  function fitTaiwan(){if(state.googleReady&&state.maps.google)state.maps.google.fitBounds({south:21.8,west:118.0,north:26.5,east:122.1},30);else state.maps.leaflet?.fitBounds([[21.8,118.0],[26.5,122.1]],{padding:[25,25]});}
  function panTo(p){if(!coord(p))return;if(state.googleReady&&state.maps.google){state.maps.google.panTo(p);if(state.maps.google.getZoom()<16)state.maps.google.setZoom(16);}else if(state.maps.leaflet)state.maps.leaflet.setView(p,Math.max(state.maps.leaflet.getZoom(),16));}
  function parseCoord(text){const match=String(text||'').match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);return match?coord({lat:Number(match[1]),lng:Number(match[2])}):null;}
  async function geocodeAddress(){return Promise.reject(new Error('此版本不啟用 Google 付費 API。可用既有內嵌街景、外開 Google 與人工估時。'));}
  async function searchV13(){const input=$('map-search').value.trim();if(!input)return;try{const p=parseCoord(input)||await geocodeAddress(input);selectLocation(p,{label:p.formattedAddress||input});panTo(p);}catch(err){toast(cleanError(err));}}
  function loadGoogleKey(){return Promise.reject(new Error('此版本不啟用 Google 付費 API。可用既有內嵌街景、外開 Google 與人工估時。'));}
  async function activateGoogle(){toast('免費模式不啟用 Google 付費 API；請用人工時間模型或外開 Google。');}
  function forgetGoogle(){$('google-key-input').value='';toast('免費版不接收或保存 Google API 金鑰。');}
  async function computeGoogle(){toast('免費模式不啟用 Google 付費 API；請用人工時間模型或外開 Google。');}
  function compareV11(){
    const box=$('compare-body');box.replaceChildren();const baseline=currentRoute(),base=routeMetrics(baseline);
    for(const r of allRoutes()){const row=node('tr'),m=routeMetrics(r),v=r.modelInputs||{},l=pointLedger(r);const numeric=x=>typeof x==='number'&&Number.isFinite(x);let difference='資料不足／來源不同';
      if(m.draft&&base.draft&&numeric(m.seconds)&&numeric(base.seconds))difference=(m.seconds-base.seconds>=0?'+':'−')+Math.abs(m.seconds-base.seconds).toFixed(0)+' 秒（人工假設差）';
      const signal=r.custom?'已標 '+l.markedSignals+'；未知 '+l.unknownSignalPoints+' 點':'近線候選 '+(r.signals?.candidateCount??'未知')+'；必經數未知';
      const turns=r.custom?'已標待轉 '+l.twoStageTurns+'；轉法未知 '+l.unknownTurnPoints:'待轉未完整核對';
      const waits='模型號誌 '+(v.signalCount??'未知')+' × '+(v.redWaitSeconds??'未知')+' 秒；待轉 '+(v.twoStageTurns??'未知')+' × '+(v.twoStageSeconds??'未知')+' 秒；壅塞 '+(v.trafficDelayMinutes??'未知')+' 分';
      for(const text of [routeCaption(r),kmLabel(m.dist)+' / '+m.distanceKind,minuteLabel(m.seconds)+' / '+m.timeKind,difference,signal,turns,waits])row.append(node('td',null,text));box.append(row);
    }state.compareOverlay=true;drawMap();showDialog('compare-dialog');
  }
  function editEndpointsV14(){$('origin-address').value=state.home.address||state.home.label||'';$('destination-address').value=state.office.address||state.office.label||'';$('origin-coords').value=coord(state.home)?state.home.lat+','+state.home.lng:'';$('destination-coords').value=coord(state.office)?state.office.lat+','+state.office.lng:'';showDialog('endpoints-dialog');}
  function saveEndpoints(){const home=parseCoord($('origin-coords').value),office=parseCoord($('destination-coords').value);if(!home||!office){toast('請提供有效座標；也可關閉設定，從上方搜尋位置後設為目前路線的起終點。');return;}state.home={...state.home,...home,address:validName($('origin-address').value),confidence:'使用者設定位置'};state.office={...state.office,...office,address:validName($('destination-address').value),confidence:'使用者設定位置'};closeDialog('endpoints-dialog');render();fitRoute();toast('已更新起終點位置；現有路線畫點不會自動改動。');}
  async function geocodeEndpoints(){toast('免費模式不啟用 Google 付費 API；請用人工時間模型或外開 Google。');}
  function setEndpointV12Legacy(kind){const p=pointForAdd();if(!p)return;state[kind]={...state[kind],...p,address:state.selection?.label||'使用者選定位置',confidence:'使用者在地圖／街景設定'};const r=ensureCustom();pushUndo();const point={...p,label:kind==='home'?'起點':'終點',turnKind:kind==='home'?'start':'arrival'};if(kind==='home'){if(r.points.length)r.points[0]=point;else r.points.push(point);}else{if(r.points.length>1)r.points[r.points.length-1]=point;else r.points.push(point);}invalidateRoute(r);render();storeRoutes();toast('已設為'+(kind==='home'?'起點':'終點')+'；請重新計算路線。');}
  function saveCustom(){const r=currentRoute();if(!r?.custom){toast('先複製目前路線或繪製自訂路線。');return;}r.name=validName($('custom-name').value)||routeCaption(r);r.label=r.name;r.modelInputs=getModelInputs();storeRoutes();renderRouteList();renderResults();toast('路線已存於此瀏覽器；也可匯出備份。');}
  function exportRoutes(){const body=JSON.stringify({version:5,exportedAt:new Date().toISOString(),routes:state.customRoutes.map(exportRoute)},null,2),url=URL.createObjectURL(new Blob([body],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='我的機車通勤路線.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  async function importRoutes(file){if(!file)return;if(file.size>5*1024*1024){toast('路線檔案太大，請使用 5 MB 以內的 JSON。');return;}try{const parsed=JSON.parse(await file.text());if(parsed.version!==5||!Array.isArray(parsed.routes)||parsed.routes.length>100||!parsed.routes.every(validSavedRoute))throw new Error('路線檔格式不正確。');for(const r of parsed.routes){const imported=exportRoute(r);imported.id='I'+Date.now().toString(36)+'-'+state.customRoutes.length;state.customRoutes.push(imported);}storeRoutes();render();toast('已匯入 '+parsed.routes.length+' 條路線。');}catch(err){toast(cleanError(err));}$('import-file').value='';}
  function mobileTab(mode){state.mobile=mode;for(const name of ['route','street','steps'])$('app').classList.toggle('mobile-'+name,name===mode);document.querySelectorAll('[data-mobile]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mobile===mode));resizeMaps();wbOnMobileTab(mode);}
  function bind(){for(const [id,fn]of Object.entries({'mode-view':()=>setMode('view'),'mode-draw':()=>toggleAdjustV27(),'fit-route':fitRoute,'fit-taiwan':fitTaiwan,'search-go':search,'compare-button':compare,'add-point':addSelectedPoint,'add-viewpoint':()=>{if(stopLookup)useMapForStop();else{setMode('draw');addSelectedPoint();}},'set-origin':()=>setEndpoint('home'),'set-destination':()=>setEndpoint('office'),'close-position':()=>{$('selected-position').classList.remove('visible');},'reset-street':resetStreet,'open-street-google':resetStreet,'selected-google':openSelectionStreetV28,'nearby-street':showNearbyStreet,'photo-mode':togglePhoto,'previous-station':()=>stationDirection(-1),'next-station':()=>stationDirection(1),'new-route':()=>newCustom(true),'copy-route':copyCurrentRoute,'undo-button':undo,'clear-points':()=>{const r=currentRoute();if(!r?.custom)return;if(!window.confirm('清除這條自訂路線的所有畫點？可按「復原」還原。'))return;pushUndo();r.points=[];invalidateRoute(r);render();storeRoutes();},'save-route':saveCustom,'export-routes':exportRoutes,'import-routes':()=>$('import-file').click(),'open-key':()=>showDialog('key-dialog'),'route-help':()=>showDialog('key-dialog'),'help-button':()=>showDialog('help-dialog'),'activate-google':activateGoogle,'forget-google':forgetGoogle,'compute-google':computeGoogle,'edit-endpoints':editEndpoints,'save-endpoints':saveEndpoints,'geocode-endpoints':geocodeEndpoints,'map-center-view':guideRecenter,'toggle-stations':()=>{state.showStations=!state.showStations;$('toggle-stations').setAttribute('aria-pressed',state.showStations);drawPhotoMarkers();},'toggle-left':()=>{if(window.innerWidth<=760){mobileTab('route');return;}state.layout.collapsed=!state.layout.collapsed;applyLayout();saveLayout();},'expand-street':async()=>{if(state.smallStreetFallback&&$('right-panel').requestFullscreen){try{await $('right-panel').requestFullscreen();}catch(_){toast('無法全螢幕；請拖曳分隔線增加街景高度。');}}else $('app').classList.toggle('fullscreen-street');resizeMaps();},'street-detail-button':()=>{$('street-detail-content').textContent=$('street-status').textContent;showDialog('street-detail-dialog');},'reference-photo':()=>{const s=state.anchor;if(!s)return;$('large-photo').src=$('reference-photo').src;$('photo-dialog-title').textContent=s.id+' '+(s.road||s.title||'');showDialog('photo-dialog');}}))$(id).addEventListener('click',fn);
    $('map-search').addEventListener('keydown',searchKey);$('import-file').addEventListener('change',e=>importRoutes(e.target.files[0]));document.querySelectorAll('[data-close-dialog]').forEach(b=>b.addEventListener('click',()=>{closeDialog(b.dataset.closeDialog);if(b.dataset.closeDialog==='compare-dialog'){state.compareOverlay=false;drawMap();}}));document.querySelectorAll('[data-mobile]').forEach(b=>b.addEventListener('click',()=>mobileTab(b.dataset.mobile)));for(const id of ['cruise-kph','traffic-delay','signal-count','red-wait','two-stage-count','two-stage-seconds'])$(id).addEventListener('change',()=>{const r=currentRoute();if(r){r.modelInputs=getModelInputs();renderResults();if(r.custom)storeRoutes();}});document.addEventListener('fullscreenchange',resizeMaps);window.addEventListener('resize',()=>{state.layout.right=Math.max(260,Math.min(state.layout.right,window.innerWidth-220));applyLayout();});resizeHandle('split-left','left');resizeHandle('split-right','right');resizeHandle('split-street','street');$('compare-dialog').addEventListener('close',()=>{state.compareOverlay=false;drawMap();});document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||document.querySelector('dialog[open]'))return;if(e.key==='ArrowRight'&&e.target.getAttribute('role')!=='separator')stationDirection(1);if(e.key==='ArrowLeft'&&e.target.getAttribute('role')!=='separator')stationDirection(-1);if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}});
  }
  function init(){initLibrary();bind();bindV7();bindLibrary();bindDragUI();bindRoutingUI();initLeaflet();applyLayout();if(currentRoute())setModelInputs(currentRoute());render();fitRoute();setMode('view');const now=new Date(),future=new Date(now.getTime()+10*60*1000),local=new Date(future.getTime()-future.getTimezoneOffset()*60000);$('departure-time').value=local.toISOString().slice(0,16);const first=routeStationIds(currentRoute()||{})[0];if(first)selectStation(first);const viewHash=String(location.hash||'');if(viewHash.startsWith('#view=')){const p=parseCoord(viewHash.slice(6));if(p){selectLocation(p);panTo(p);}}status('已載入路線庫。原始候選與自訂方案保留在左側。');void hydrateLibrary();}
  // This fragment is bundled inside the workspace closure; it never reads Google frames.
  let library={hidden:[],order:[],presetNames:{},dirty:false,serverRevision:0};
  let persistence={ready:false,csrf:null,revision:0,saving:false,pending:false,blocked:false};
  let localEnvelopeFound=false,mutationEpoch=0,renameTarget=null;
  const LIBRARY_KEY=data.publicEdition?'route-workbench-public-library-v25':'commute-planner-library-v10';
  const orderedRoutes=rows=>rows.filter(r=>!library.hidden.includes(r.id)&&!(library.archived||[]).includes(r.id)).sort((a,b)=>{const ai=library.order.indexOf(a.id),bi=library.order.indexOf(b.id);return (ai<0?9999:ai)-(bi<0?9999:bi);});
  function exportRouteV10(r){const out=exportRouteV9(r);out.points=pointsOf(r).map(p=>({...coord(p),label:validName(p.label),road:validName(p.road),turnKind:validName(p.turnKind||'unknown'),instruction:validName(p.instruction),confirmed:p.confirmed===true,streetEvidence:['viewed','unavailable','unknown'].includes(p.streetEvidence)?p.streetEvidence:'unknown',...cleanAnnotation(p)}));out.path=out.points.map(coord);out.workflow=r.workflow?{phase:['origin','destination','planning','complete'].includes(r.workflow.phase)?r.workflow.phase:'planning',originConfirmed:r.workflow.originConfirmed===true,goalConfirmed:r.workflow.goalConfirmed===true}:null;out.status=out.workflow?.phase==='complete'?'user_confirmed':'draft';out.originalText=typeof r.originalText==='string'?r.originalText.slice(0,12000):'';return out;}
  function libraryPayloadV24(){return {version:10,customRoutes:state.customRoutes.map(exportRoute),hidden:[...library.hidden],order:[...library.order],presetNames:{...library.presetNames},currentId:state.routeId,home:{...coord(state.home),address:validName(state.home.address||state.home.label)},office:{...coord(state.office),address:validName(state.office.address||state.office.label)}};}
  function validLibrary(p){return p&&p.version===10&&Array.isArray(p.customRoutes)&&p.customRoutes.length<=100&&p.customRoutes.every(validSavedRoute)&&Array.isArray(p.hidden)&&Array.isArray(p.order)&&p.hidden.every(x=>typeof x==='string')&&p.order.every(x=>typeof x==='string')&&p.presetNames&&typeof p.presetNames==='object';}
  function applyLibraryV12Legacy(p){if(!validLibrary(p))throw new Error('路線庫格式不正確');state.customRoutes=p.customRoutes.map(exportRoute);library.hidden=[...new Set(p.hidden)];library.order=[...new Set(p.order)];library.presetNames={};for(const id of ['A','B'])if(typeof p.presetNames[id]==='string')library.presetNames[id]=validName(p.presetNames[id]);for(const r of state.routes)r.name=library.presetNames[r.id]||presets.find(x=>x.id===r.id)?.label||r.label;for(const key of ['home','office'])if(coord(p[key]))state[key]={...state[key],...coord(p[key]),address:validName(p[key].address)};state.routeId=allRoutes().some(r=>r.id===p.currentId)?p.currentId:allRoutes()[0]?.id||null;state.undo=[];}
  function saveLocal(){try{localStorage.setItem(LIBRARY_KEY,JSON.stringify({version:10,dirty:library.dirty,serverRevision:library.serverRevision,library:libraryPayload()}));localStorage.setItem('commute-planner-routes-v5',JSON.stringify(state.customRoutes.map(exportRoute)));return true;}catch(_){$('save-status').textContent='瀏覽器儲存失敗；請匯出 JSON 備份。';return false;}}
  function storeRoutes(){mutationEpoch++;library.dirty=true;saveLocal();$('save-status').textContent=persistence.ready?'正在保存到本機檔案…':'已保存瀏覽器副本；本機檔案尚未同步';if(persistence.ready&&!persistence.blocked){persistence.pending=true;void flushLibrary();}}
  function initLibrary(){try{const e=JSON.parse(localStorage.getItem(LIBRARY_KEY)||'null');if(e&&validLibrary(e.library)){applyLibrary(e.library);localEnvelopeFound=true;library.dirty=e.dirty===true;library.serverRevision=Number.isInteger(e.serverRevision)?e.serverRevision:0;}}catch(_){$('save-status').textContent='既有路線庫讀取異常，保留舊資料；可匯入 JSON。';}if(!library.order.length)library.order=[...state.routes,...state.customRoutes].map(r=>r.id);if(window.innerWidth>=760){state.layout.collapsed=false;if(window.innerWidth<1100){state.layout.left=210;state.layout.right=260;}}}
  function mergeLegacyLibrary(remote){const merged=clone(remote),legacy=state.customRoutes.map(exportRoute);for(const old of legacy){const found=merged.customRoutes.find(x=>x.id===old.id);if(found&&JSON.stringify(exportRoute(found))===JSON.stringify(old))continue;if(found){old.id='M'+Date.now().toString(36)+'-'+merged.customRoutes.length;old.name=validName(old.name+'（舊版瀏覽器副本）');}merged.customRoutes.push(old);if(!merged.order.includes(old.id))merged.order.push(old.id);}if(merged.customRoutes.length>100){persistence.blocked=true;throw new Error('路線太多，請先匯出整理');}applyLibrary(merged);toast('已保留本機檔案與舊版瀏覽器的路線；衝突方案另存副本。');}
  async function hydrateLibraryV12Legacy(){if(typeof window.fetch!=='function'||!['http:','https:'].includes(location.protocol)){ $('save-status').textContent='瀏覽器保存模式；請匯出 JSON 作跨瀏覽器備份。';return;}const epoch=mutationEpoch;try{const response=await window.fetch('/api/routes',{cache:'no-store'});if(!response.ok)throw new Error('本機檔案讀取失敗');const data=await response.json();if(data.version!==10||typeof data.csrf!=='string'||!Number.isInteger(data.revision))throw new Error('規劃服務版本不符');persistence.csrf=data.csrf;persistence.revision=data.revision;persistence.ready=true;if(data.library){if(!validLibrary(data.library))throw new Error('伺服器路線庫格式不正確');if(!localEnvelopeFound&&state.customRoutes.length&&mutationEpoch===epoch){mergeLegacyLibrary(data.library);localEnvelopeFound=true;library.serverRevision=data.revision;storeRoutes();return;}if(mutationEpoch!==epoch||library.dirty){if(localEnvelopeFound&&library.serverRevision!==data.revision){persistence.blocked=true;$('save-status').textContent='另一頁有較新版本；保留瀏覽器副本，請先匯出，再按重新讀取。';return;}}else{applyLibrary(data.library);library.serverRevision=data.revision;library.dirty=false;render();saveLocal();$('save-status').textContent='已從本機檔案恢復路線庫 · 版本 '+data.revision;return;}}persistence.pending=true;void flushLibrary();}catch(_){$('save-status').textContent='本機檔案未連線；瀏覽器副本保留，請匯出備份。';}}
  async function flushLibrary(){if(!persistence.ready||persistence.saving||persistence.blocked)return;persistence.saving=true;try{while(persistence.pending){persistence.pending=false;const epoch=mutationEpoch,payload=libraryPayload();const response=await window.fetch('/api/routes',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':persistence.csrf,'X-Planner-Client':'25'},body:JSON.stringify({version:10,expectedRevision:persistence.revision,library:payload})});if(response.status===409){persistence.blocked=true;$('save-status').textContent='另一頁已先儲存；保留瀏覽器副本，請先匯出再重新讀取。';break;}if(!response.ok)throw new Error('保存失敗');const answer=await response.json();if(!Number.isInteger(answer.revision))throw new Error('保存回應異常');persistence.revision=answer.revision;library.serverRevision=answer.revision;library.dirty=mutationEpoch!==epoch;saveLocal();$('save-status').textContent=library.dirty?'正在保存最新編輯…':'已保存到本機檔案＋瀏覽器 · 版本 '+answer.revision;if(library.dirty)persistence.pending=true;}}catch(_){$('save-status').textContent='本機保存未成功；瀏覽器副本保留，可按「重試保存」。';}finally{persistence.saving=false;}}
  function retrySaveV24(){if(persistence.blocked){toast('請先匯出路線備份，再重新讀取伺服器版本。');return;}if(!persistence.ready){void hydrateLibrary();return;}persistence.pending=true;void flushLibrary();}
  function reloadLibraryV24(){cancelDragEdit(false);if(library.dirty&&!window.confirm('目前瀏覽器有未同步編輯。請先匯出 JSON；仍要重新讀取本機檔案版本？'))return;library.dirty=false;localEnvelopeFound=false;persistence.blocked=false;void hydrateLibrary();}
  function selectRouteV10(id,options={}){selectRouteV9(id,options);storeRoutes();renderWorkflow();renderRouteText();}
  function renameRoute(id,name){const r=[...state.routes,...state.customRoutes].find(x=>x.id===id);if(!r)return;if(name===undefined){renameTarget=id;$('route-rename-input').value=routeCaption(r);showDialog('route-rename-dialog');return;}name=validName(name).trim();if(!name){toast('請輸入路線名稱。');return;}if(r.custom)r.name=r.label=name;else{library.presetNames[id]=name;r.name=name;}storeRoutes();render();closeDialog('route-rename-dialog');}
  function removeRouteV12Legacy(id){if(!allRoutes().some(r=>r.id===id))return;if(!window.confirm('將這條路線移到回收區？之後可恢復。'))return;library.hidden=[...new Set([...library.hidden,id])];if(state.routeId===id)state.routeId=allRoutes()[0]?.id||null;state.undo=[];storeRoutes();render();}
  function restoreRouteV12Legacy(id){library.hidden=library.hidden.filter(x=>x!==id);state.routeId=id;storeRoutes();render();}
  function reorderRoute(id,delta){const ids=allRoutes().map(r=>r.id),from=ids.indexOf(id),to=from+delta;if(from<0||to<0||to>=ids.length)return;[ids[from],ids[to]]=[ids[to],ids[from]];library.order=[...ids,...library.hidden.filter(x=>!ids.includes(x))];storeRoutes();renderRouteList();}
  function renderRouteListV11(){const box=$('route-list');box.replaceChildren();for(const r of allRoutes()){const row=node('article','library-route');const select=node('button','route-card');select.style.setProperty('--route',r.color||'#a34bb7');select.setAttribute('aria-pressed',r.id===state.routeId);select.append(node('strong',null,routeCaption(r)),node('small',null,r.custom?(r.workflow?.phase==='complete'?'已完成逐段確認':'規劃中')+' · '+pointsOf(r).length+' 個點':'原始候選 · 保留完整路線文字'));select.addEventListener('click',()=>selectRoute(r.id));row.append(select);const actions=node('div','library-actions');for(const [label,fn]of [['點選調整',()=>uxEditRoute(r.id)],['改名',()=>renameRoute(r.id)],['↑',()=>reorderRoute(r.id,-1)],['↓',()=>reorderRoute(r.id,1)],['刪除',()=>removeRoute(r.id)]]){const b=node('button',null,label);b.setAttribute('aria-label',label+' '+routeCaption(r));b.addEventListener('click',fn);actions.append(b);}row.append(actions);box.append(row);}if(!allRoutes().length)box.append(node('p','muted','沒有顯示中的路線；可新增或從回收區恢復。'));const trash=$('route-trash');trash.replaceChildren();for(const id of library.hidden){const r=[...state.routes,...state.customRoutes].find(x=>x.id===id);if(!r)continue;const b=node('button',null,'恢復 '+routeCaption(r));b.addEventListener('click',()=>restoreRoute(id));trash.append(b);}$('trash-count').textContent=library.hidden.length+' 條';$('saved-routes').replaceChildren(node('p','muted','所有方案固定保留在上方清單；每次編輯自動保存。A／B 的編輯會建立副本，原始候選可從回收區恢復。'));}
  function ensureCustomV10(){const old=currentRoute();const custom=ensureCustomV9();if(old&&!old.custom){custom.originalText=routeText(old);custom.points=pointsOf(custom).map((p,i)=>({...p,road:p.road||p.label||'',turnKind:i===0?'start':i===custom.points.length-1?'arrival':p.turnKind||'unknown',confirmed:false,instruction:p.turnHint||''}));custom.keepDestination=true;custom.workflow={phase:'planning',originConfirmed:false,goalConfirmed:true};library.order.push(custom.id);invalidateRoute(custom);}return custom;}
  function newCommuteV12Legacy(){const id='C'+Date.now().toString(36)+'-'+state.customRoutes.length;const r={id,name:'我的通勤方案 '+(state.customRoutes.length+1),custom:true,keepDestination:true,points:[{...coord(state.home),label:'住家',road:'住家',turnKind:'start',signal:'no',confirmed:false},{...coord(state.office),label:'公司',road:'公司',turnKind:'arrival',signal:'no',confirmed:false}],workflow:{phase:'origin',originConfirmed:false,goalConfirmed:false},modelInputs:{}};state.customRoutes.push(r);library.order.push(id);state.routeId=id;state.undo=[];invalidateRoute(r);setModelInputs(r);setMode('draw');selectLocation(r.points[0],{label:'先確認起點'});render();storeRoutes();fitRoute();toast('先查看住家街景，再按「確認起點」。');}
  function newCustomV12Legacy(empty=false){newCustomV9(empty);const r=currentRoute();if(r&&!r.workflow)r.workflow={phase:r.points.length>=2?'planning':'origin',originConfirmed:false,goalConfirmed:r.points.length>=2};if(r&&!library.order.includes(r.id))library.order.push(r.id);render();storeRoutes();}
  function invalidateRouteV10(r){invalidateRouteV9(r);if(r.workflow&&r.points.length<2){r.workflow.phase='origin';r.workflow.goalConfirmed=false;}else if(r.workflow?.phase==='complete'&&r.points.some(p=>p.confirmed!==true))r.workflow.phase='planning';}
  function confirmedPathV10(r){const out=[];for(const p of pointsOf(r)){if(p.confirmed!==true)break;out.push(coord(p));}return out;}
  function routeTextV10(r){if(!r)return '尚未選擇路線。';const rows=[routeCaption(r)];if(!r.custom){for(const [i,s]of (r.steps||[]).entries())rows.push((i+1)+'. '+(s.road||'路段')+'：'+(s.instruction||'轉法待確認')+(s.confirmed?'':'【現場待核對】')+(s.warning?'\n   注意：'+s.warning:''));return rows.join('\n');}const points=pointsOf(r);for(const [i,p]of points.entries()){const meters=i?Math.round(distance(points[i-1],p)):0;rows.push((i+1)+'. '+(p.road||p.label||'路名待填')+'｜'+turnTitle(p.turnKind)+(i?'｜上一點至此約 '+meters+' m（畫點連線）':'')+'｜'+(p.confirmed?'使用者已確認':'待確認')+(p.instruction?'\n   '+p.instruction:'')+(p.signal==='yes'?'\n   號誌停等：'+(p.redWaitSeconds==null?'未知':p.redWaitSeconds+' 秒'):'')+(p.turnKind==='two_stage'?'\n   額外待轉：'+(p.extraTurnSeconds==null?'未知':p.extraTurnSeconds+' 秒'):''));}if(r.originalText)rows.push('\n原始候選文字（編輯後可能不再與畫點一致）：\n'+r.originalText);return rows.join('\n');}
  function renderRouteTextV15(){$('route-text').textContent=routeText(currentRoute());}
  function renderV24(){if(!currentRoute()){renderEndpoints();renderRouteList();$('steps-list').replaceChildren(node('p','muted','請新增或恢復一條路線。'));$('current-route-name').textContent='尚未選擇路線';$('distance-value').textContent=$('duration-value').textContent='—';clearLayers();renderWorkflow();renderRouteText();return;}renderV9();renderWorkflow();renderRouteText();}
  function renderResultsV10(){renderResultsV9();const r=currentRoute();if(!r)return;if(r.custom){const pts=confirmedPath(r),d=pts.length>1?engine.distanceMeters(pts):0;$('confirmed-progress').textContent='已確認連線 '+kmLabel(d)+' · '+Math.max(0,pts.length-1)+' 段；完整畫點長度 '+kmLabel(routeMetrics(r).dist);$('route-warning').textContent='依你的畫點與文字組成路線；連線尚未自動沿合法機車道路，未知號誌與待轉不算成零。';}else $('confirmed-progress').textContent='原始 A／B 候選仍有未確認銜接，請點轉彎標記逐路口核對。';renderWorkflow();renderRouteText();}
  function renderSelection(){renderSelectionV9();renderWorkflow();}
  function selectLocationV12Legacy(p,options={}){selectLocationV9(p,options);renderWorkflow();drawMap();}
  function workflowOf(r){if(!r?.custom)return null;if(!r.workflow)r.workflow={phase:r.points.length>=2?'planning':'origin',originConfirmed:r.points[0]?.confirmed===true,goalConfirmed:r.points.length>=2};return r.workflow;}
  function renderWorkflowV10(){const r=currentRoute(),w=workflowOf(r),p=coord(state.selection);$('workflow-panel').hidden=!r?.custom;for(const id of ['confirm-origin','confirm-goal','confirm-segment','finish-route'])$(id).hidden=true;if(!w)return;const phase=w.phase;$('workflow-phase').textContent=({origin:'1／4 確認起點',destination:'2／4 確認終點位置',planning:'3／4 逐段查看與確認',complete:'4／4 已完成逐段確認'})[phase];$('candidate-coord').textContent=p?'確認的地圖點：'+p.lat.toFixed(6)+', '+p.lng.toFixed(6):'先點選地圖，查看該位置街景';$('confirm-origin').hidden=phase!=='origin';$('confirm-goal').hidden=phase!=='destination';$('confirm-segment').hidden=phase!=='planning';$('finish-route').hidden=phase!=='planning';$('candidate-fields').hidden=phase!=='planning';for(const id of ['confirm-origin','confirm-goal','confirm-segment','finish-route'])$(id).disabled=!p;}
  function confirmOrigin(){const r=currentRoute(),p=coord(state.selection);if(!r?.custom||!p)return;pushUndo();const value={...p,label:'起點',road:'起點',turnKind:'start',signal:'no',confirmed:true};if(r.points.length)r.points[0]=value;else r.points.push(value);r.workflow={phase:'destination',originConfirmed:true,goalConfirmed:false};invalidateRoute(r);render();storeRoutes();const goal=r.points.at(-1);if(r.points.length>=2)selectLocation(goal,{label:'查看並確認終點位置'});toast('起點已確認，接著確認終點位置。');}
  function confirmGoal(){const r=currentRoute(),p=coord(state.selection);if(!r?.custom||!p||!r.workflow?.originConfirmed)return;if(distance(r.points[0],p)<2){toast('終點需與起點不同。');return;}pushUndo();const goal={...p,label:'終點',road:'終點',turnKind:'arrival',signal:'no',confirmed:false};if(r.points.length>1)r.points[r.points.length-1]=goal;else r.points.push(goal);r.keepDestination=true;r.workflow={...r.workflow,phase:'planning',goalConfirmed:true};invalidateRoute(r);render();storeRoutes();selectLocation(r.points[0],{label:'選下一個路口'});toast('起終點已設定；點下一個路口、看街景後確認本段。');}
  function candidateMeta(){const road=validName($('candidate-road').value).trim(),turn=$('candidate-turn').value||'unknown';if(!road||!['straight','right','left','two_stage'].includes(turn)){toast('請填路名／路口，並選擇直行、右轉、左轉或待轉。');return null;}const seconds=id=>{const x=String($(id).value||'').trim();return x===''?null:Number(x);};const red=seconds('candidate-red'),extra=seconds('candidate-extra');if((red!==null&&(!Number.isFinite(red)||red<0||red>600))||(extra!==null&&(!Number.isFinite(extra)||extra<0||extra>1200))){toast('等待秒數超出範圍；不知道可留白。');return null;}return {road,label:road,turnKind:turn,instruction:validName($('candidate-note').value),signal:['yes','no'].includes($('candidate-signal').value)?$('candidate-signal').value:'unknown',redWaitSeconds:red,extraTurnSeconds:extra,confirmed:true,streetEvidence:'unknown'};}
  function confirmSegmentV10(){const r=currentRoute(),p=coord(state.selection);if(!r?.custom||!p||workflowOf(r)?.phase!=='planning')return;const meta=candidateMeta();if(!meta)return;if(r.points.length>=200){toast('每條路線最多 200 個點。');return;}const index=Number.isInteger(state.editIndex)?state.editIndex:Math.max(1,r.points.length-1);if(r.points[index-1]&&distance(r.points[index-1],p)<2){toast('與上一個點太接近，請點下一個路口。');return;}pushUndo();r.points.splice(index,0,{...p,...meta});if(index<r.points.length-2)r.points[index+1].confirmed=false;state.editIndex=null;state.selectedStep=index;invalidateRoute(r);render();storeRoutes();$('candidate-note').value='';toast('本段已確認並保存，繼續點下一個路口。');}
  function addSelectedPointV10(){const r=currentRoute();if(r?.custom&&workflowOf(r)?.phase==='planning'){confirmSegment();return;}if(r?.custom&&['origin','destination'].includes(workflowOf(r)?.phase)){toast('請先依左側流程確認起點與終點。');return;}addSelectedPointV9();}
  function finishRoute(){const r=currentRoute(),p=coord(state.selection);if(!r?.custom||!r.workflow?.goalConfirmed||r.points.length<2)return;const goal=r.points.at(-1);if(!p||distance(p,goal)>20){toast('請先點地圖上的終點標記，看街景後再確認最後一段。');return;}if(r.points.slice(0,-1).some(x=>x.confirmed!==true)){toast('前面還有待確認的點，請先在步驟清單確認。');return;}pushUndo();goal.confirmed=true;r.workflow.phase='complete';invalidateRoute(r);render();storeRoutes();setMode('view');toast('整條路線已完成逐段確認，已保存在左側。');}
  function confirmExistingPoint(index){const r=currentRoute();if(!r?.custom||!r.points[index])return;const p=r.points[index];if(!p.road||p.turnKind==='unknown'){toast('先填此路口名稱與轉法。');return;}if(!coord(state.selection)||distance(state.selection,p)>2){selectLocation(p,{label:p.road});toast('已載入此點街景；查看後再按確認。');return;}pushUndo();p.confirmed=true;if(index===0){workflowOf(r).originConfirmed=true;}render();storeRoutes();}
  function movePointV10(index,p){const r=currentRoute();if(!r?.custom||!coord(p)||!r.points[index])return;pushUndo();r.points[index]={...r.points[index],...coord(p),confirmed:false};if(r.points[index+1])r.points[index+1].confirmed=false;invalidateRoute(r);render();storeRoutes();}
  function deletePointV10(index){const r=currentRoute();if(!r?.custom||!r.points[index])return;pushUndo();r.points.splice(index,1);if(r.points[index])r.points[index].confirmed=false;if(r.workflow)r.workflow.phase=r.points.length>=2?'planning':'origin';invalidateRoute(r);render();storeRoutes();}
  function updatePointMetaV10(index,patch){const r=currentRoute();if(!r?.custom||!r.points[index])return;pushUndo();Object.assign(r.points[index],patch,{confirmed:false});invalidateRoute(r);render();storeRoutes();}
  function saveCustom(){const r=currentRoute();if(!r)return;renameRoute(r.id,$('custom-name').value||routeCaption(r));if(r.custom)r.modelInputs=getModelInputs();storeRoutes();render();}
  function instructionsOf(r){if(!r.custom)return r.steps||[];return pointsOf(r).map((p,i)=>({road:p.road||p.label||'路名待填',instruction:(i?'由上一點至此約 '+Math.round(distance(pointsOf(r)[i-1],p))+' m（畫點連線）；':'')+(p.instruction||turnTitle(p.turnKind)),turnKind:p.turnKind||'unknown',start:p,confirmed:p.confirmed===true,warning:p.confirmed?'使用者確認點位與文字；機車合法動線仍以現場為準。':'此點與銜接尚未確認。'}));}
  function pointEditorV12Legacy(r,i,s){const edit=pointEditorV9(r,i,s),note=node('input');note.value=r.points[i]?.instruction||'';note.placeholder='看到什麼地標、在哪裡轉彎';note.setAttribute('aria-label','畫點 '+(i+1)+' 騎乘文字');note.className='full';note.addEventListener('change',()=>updatePointMeta(i,{instruction:validName(note.value)}));const confirm=node('button','full','確認這個點與前段');confirm.addEventListener('click',()=>confirmExistingPoint(i));edit.append(note,confirm);return edit;}
  function lineSegmentsV10(r){if(!r.custom)return lineSegmentsV9(r);const p=pointsOf(r),result=[];for(let i=1;i<p.length;i++)result.push({path:[coord(p[i-1]),coord(p[i])],dashed:p[i].confirmed!==true||p[i-1].confirmed!==true,label:(p[i].road||p[i].label||'路段')+(p[i].confirmed?' · 使用者已確認':' · 待確認'),status:p[i].confirmed?'user_confirmed':'unresolved_user_segment'});return result;}
  function turnEntries(r){if(r.custom)return pointsOf(r).map((p,i)=>({p,index:i,label:turnTitle(p.turnKind),kind:p.turnKind||'unknown',confirmed:p.confirmed===true}));const entries=[];for(const [i,s]of (r.steps||[]).entries()){const station=stations.find(x=>x.id===s.stationId);const p=coord(station)||coord(s.start)||coord(s.point);if(p)entries.push({p,index:i,label:s.road||'路口',kind:s.turnKind||'unknown',stationId:station?.id,confirmed:s.confirmed===true});}return entries;}
  function drawTurnMarkersV10(){if(!state.maps.leaflet)return;const r=currentRoute();if(!r)return;for(const item of turnEntries(r)){const uncertain=!item.confirmed,kind=item.kind;const arrow=kind.includes('left')||kind==='left'?'↰':kind==='right'?'↱':kind==='two_stage'?'待':kind==='arrival'?'終':kind==='start'?'起':kind==='straight'||kind==='continue'?'↑':'?';const content=node('span','turn-badge');content.append(node('b',null,arrow),node('small',null,String(item.index+1)+(uncertain?'?':'')));const icon=L.divIcon({className:'turn-marker'+(uncertain?' unconfirmed':' confirmed'),html:content,iconSize:[38,40],iconAnchor:[19,20]});const marker=L.marker(item.p,{icon,riseOnHover:true,zIndexOffset:700,draggable:r.custom&&isDrawing()}).addTo(state.maps.leaflet);marker.bindTooltip(node('span',null,(item.index+1)+'. '+item.label+' · '+(uncertain?'待核對':'使用者已確認')));marker.on('click',()=>{state.selectedStep=item.index;if(item.stationId)selectStation(item.stationId);else selectLocation(item.p,{label:item.label});renderSteps();});if(r.custom)marker.on('dragend',()=>movePoint(item.index,productMapCoord(marker.getLatLng())));state.layers.push(marker);}}
  function drawMapV10(){drawMapV9();drawTurnMarkers();const r=currentRoute(),p=coord(state.selection);if(r?.custom&&r.workflow?.phase==='planning'&&p&&state.maps.leaflet){const index=Number.isInteger(state.editIndex)?state.editIndex:Math.max(1,r.points.length-1),start=coord(r.points[index-1]);if(start&&distance(start,p)>2){const preview=L.polyline([start,p],{color:'#dc7d16',weight:5,dashArray:'3 8',interactive:false}).addTo(state.maps.leaflet);state.layers.push(preview);}}}
  function showLegacyStreet(p,options={}){showLegacyStreetV9(p,options);$('street-trouble-note').textContent='若 Google 顯示「無法產生街景服務圖像」，不能僅憑這句判定無覆蓋。可重試原點，或手動選附近道路；選點不會被自動替換。';}
  function resetStreet(){if(!coord(state.selection))return;showLegacyStreet(state.selection);drawMap();}
  function streetTrouble(){const p=coord(state.selection);if(!p)return;$('street-diagnostic-coord').textContent=p.lat.toFixed(6)+', '+p.lng.toFixed(6);$('street-diagnostic-result').textContent='目前原因未判定。HTTP 成功也可能沒有全景影像；嵌入頁無法讀取 Google 框內錯誤。請比較：同一點的 Google 原頁也沒有影像 → 覆蓋／影像問題可能較高；原頁能看、嵌入不能看 → 嵌入相容或載入問題。此為判讀方式，尚非自動診斷結果。';setLink($('diagnostic-google'),mapsStreetURL(p));showDialog('street-diagnostic-dialog');}
  function exportLibraryV24(){const body=JSON.stringify({version:10,library:libraryPayload()},null,2),url=URL.createObjectURL(new Blob([body],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='我的機車路線庫-v10.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  function exportRoutes(){exportLibrary();}
  async function importRoutes(file){if(!file)return;try{if(file.size>2_000_000)throw new Error('路線檔須小於 2 MB。');const p=JSON.parse(await file.text());if(p.version===5){if(!Array.isArray(p.routes)||!p.routes.every(validSavedRoute))throw new Error('路線格式不正確');for(const r of p.routes){const copy=exportRoute(r);copy.id='I'+Date.now().toString(36)+'-'+state.customRoutes.length;state.customRoutes.push(copy);library.order.push(copy.id);}}else if(p.version===10&&validLibrary(p.library)){for(const r of p.library.customRoutes){const copy=exportRoute(r);copy.id='I'+Date.now().toString(36)+'-'+state.customRoutes.length;state.customRoutes.push(copy);library.order.push(copy.id);}toast('已新增匯入方案；原有路線及 A／B 保留。');}else throw new Error('路線檔格式不正確。');storeRoutes();render();}catch(error){toast(cleanError(error));}$('import-file').value='';}
  function bindLibrary(){for(const [id,fn]of Object.entries({'confirm-origin':confirmOrigin,'confirm-goal':confirmGoal,'confirm-segment':confirmSegment,'finish-route':finishRoute,'show-route-text':()=>{renderRouteText();showDialog('route-text-dialog');},'retry-save':retrySave,'reload-library':reloadLibrary,'save-route-name':()=>renameRoute(renameTarget,$('route-rename-input').value),'street-trouble':streetTrouble,'diagnostic-retry':()=>{resetStreet();closeDialog('street-diagnostic-dialog');},'diagnostic-nearby':()=>{showNearbyStreet();closeDialog('street-diagnostic-dialog');}}))$(id).addEventListener('click',fn);}

  // Dragging changes a local geometry draft. It does not invoke a routing service.
  let dragEdit=null,dragPreviewLayers=[],dragPointerCleanup=null,suppressRouteClickUntil=0;
  function cleanShape(value,points){if(!value||!Array.isArray(value.nodes)||value.nodes.length<2||value.nodes.length>1000||!value.nodes.every(coord))return null;const nodes=value.nodes.map(p=>({...coord(p),road:validName(p.road),uncertain:p.uncertain===true,edited:p.edited===true}));if(!points.every(p=>Number.isInteger(p.shapeIndex)&&p.shapeIndex>=0&&p.shapeIndex<nodes.length))return null;for(let i=1;i<points.length;i++)if(points[i].shapeIndex<points[i-1].shapeIndex)return null;return {nodes,sourcePreset:['A','B'].includes(value.sourcePreset)?value.sourcePreset:null};}
  function exportRouteV11(r){const out=exportRouteV10(r);out.points=out.points.map((p,i)=>({...p,...(Number.isInteger(r.points?.[i]?.shapeIndex)?{shapeIndex:r.points[i].shapeIndex}:{})}));const shape=cleanShape(r.editShape,out.points);if(shape){out.editShape=shape;out.path=shape.nodes.map(coord);}return out;}
  function attachPresetShape(custom,original){const nodes=pathOf(original).map(p=>({...p,road:'既有候選路段',uncertain:true,edited:false}));if(nodes.length<2||nodes.length>1000)return;for(const s of original.segments||[]){const shape=(s.path||[]).map(coord).filter(Boolean);for(const p of shape){let nearest=0,min=Infinity;nodes.forEach((n,i)=>{const d=distance(n,p);if(d<min){nearest=i;min=d;}});if(min<3){nodes[nearest].road=validName(s.road||s.label);nodes[nearest].uncertain=String(s.status||'').startsWith('unresolved')||s.uncertain===true;}}}let lower=0;custom.points=pointsOf(custom).map((p,i)=>{let at=lower,min=Infinity;for(let n=lower;n<nodes.length;n++){const d=distance(nodes[n],p);if(d<min){at=n;min=d;}}lower=at;return {...p,...coord(nodes[at]),shapeIndex:at,confirmed:false};});custom.editShape={nodes,sourcePreset:original.id};custom.path=nodes.map(coord);custom.geometry=custom.path;custom.warnings=['保留原候選完整線形；虛線銜接與拖曳改動尚未沿合法機車道路重算。'];}
  function ensureCustomV12Legacy(){const original=currentRoute(),custom=ensureCustomV10();if(original&&!original.custom)attachPresetShape(custom,original);return custom;}
  function invalidateRouteV11(r){invalidateRouteV10(r);const shape=cleanShape(r.editShape,pointsOf(r));if(shape){r.editShape=shape;r.path=shape.nodes.map(coord);r.geometry=r.path;r.warnings=['保留既有候選線形；橘色／虛線調整段尚未沿合法機車道路重算。'];}else if(r.editShape)delete r.editShape;}
  function shapeFor(r){const existing=cleanShape(r.editShape,pointsOf(r));if(existing)return existing;return {nodes:pointsOf(r).map(p=>({...coord(p),road:p.road||p.label||'畫點路段',uncertain:true,edited:false})),sourcePreset:null};}
  function nearestEdge(nodes,p){if(!coord(p)||nodes.length<2)return null;let best=null,min=Infinity;const cos=Math.cos(p.lat*Math.PI/180);for(let i=1;i<nodes.length;i++){const a=nodes[i-1],b=nodes[i],dx=(b.lng-a.lng)*cos,dy=b.lat-a.lat,den=dx*dx+dy*dy;const t=den?Math.max(0,Math.min(1,((p.lng-a.lng)*cos*dx+(p.lat-a.lat)*dy)/den)):0;const q={lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};const d=distance(q,p);if(d<min){min=d;best={index:i,point:q,distance:d};}}return best;}
  function startAdjustV11(id){cancelDragEdit(false);if(id&&id!==state.routeId)selectRoute(id,{keepViewport:true,skipStation:true});if(!currentRoute())return;const r=ensureCustom();if(r.points.length<2){toast('這條路線還沒有完整起終點；請先選 A／B 作為起始路線。');return;}state.dragRouteMode=true;state.showAllRoutes=false;$('show-all-routes').setAttribute('aria-pressed','false');setMode('draw');render();storeRoutes();$('map-help').textContent='按住路線拖到想經過的位置；也可點線，拖曳出現的白色把手。放開後看街景，再確認調整。';toast('整條路線已備好，直接拖線或拖轉彎標誌即可調整。');}
  function renderDragEditV11(){const box=$('drag-review');box.hidden=!dragEdit;$('start-adjust').disabled=!currentRoute();$('start-adjust').textContent=state.dragRouteMode?'拖曳調整中':'拖曳調整這條路';if(!dragEdit)return;const p=dragEdit.target,built=previewGeometry(),delta=Math.round(engine.distanceMeters(built.nodes)-engine.distanceMeters(dragEdit.baseShape.nodes));$('drag-point-coord').textContent='拖到：'+p.lat.toFixed(6)+', '+p.lng.toFixed(6)+' · 幾何長度 '+(delta>=0?'+':'')+delta+' m';$('drag-change-note').textContent='只預覽，尚未保存。未改動的道路線形保留；橘色連線沒有自動沿道路重算。街景內前進不會改變這個選點。';}
  function clearDragLayers(){for(const layer of dragPreviewLayers)layer.remove?.();dragPreviewLayers=[];}
  function finishPointer(){if(dragPointerCleanup){dragPointerCleanup();dragPointerCleanup=null;}}
  function cancelDragEditV11(redraw=true){finishPointer();dragEdit=null;clearDragLayers();$('drag-review').hidden=true;if(redraw)drawMap();}
  function beginRouteDragV11(p,index=null){if(!coord(p)||!isDrawing()||!state.dragRouteMode)return false;cancelDragEdit(false);const r=currentRoute();if(!r?.custom||r.points.length>=200)return false;const shape=shapeFor(r);if(shape.nodes.length>=1000)return false;let at,kind='insert',target;if(Number.isInteger(index)&&r.points[index]){at=Number.isInteger(r.points[index].shapeIndex)?r.points[index].shapeIndex:index;kind='move';target=coord(r.points[index]);}else{const near=nearestEdge(shape.nodes,p);if(!near)return false;at=near.index;target=near.point;}const originalPoints=pointsOf(r).map((x,i)=>({...x,shapeIndex:Number.isInteger(x.shapeIndex)?x.shapeIndex:i}));dragEdit={routeId:r.id,fingerprint:JSON.stringify(exportRoute(r)),kind,pointIndex:index,nodeIndex:at,baseShape:shape,basePoints:originalPoints,target,originalTarget:target,moved:false};$('drag-road').value='';$('drag-turn').value='unknown';$('drag-note').value='';renderDragEdit();drawDragPreview();return true;}
  function previewGeometry(){if(!dragEdit)return null;const d=dragEdit,nodes=clone(d.baseShape.nodes),points=clone(d.basePoints),at=d.nodeIndex;const value={...d.target,road:'拖曳調整段（路名待確認）',uncertain:true,edited:true};if(d.kind==='insert'){nodes.splice(at,0,value);for(const p of points)if(p.shapeIndex>=at)p.shapeIndex++;}else{nodes[at]={...nodes[at],...value};}if(nodes[at+1])nodes[at+1]={...nodes[at+1],uncertain:true,edited:true};return {nodes,points,at};}
  function updateRouteDragV12Legacy(p){if(!dragEdit||!coord(p))return;dragEdit.target=coord(p);dragEdit.moved=distance(dragEdit.originalTarget,p)>1;renderDragEdit();drawDragPreview();}
  function endRouteDragV11(p){if(!dragEdit)return;finishPointer();if(coord(p))dragEdit.target=coord(p);const target=dragEdit.target;selectLocation(target,{label:'拖曳後待確認的位置'});renderDragEdit();drawDragPreview();}
  function drawDragPreviewV11(){clearDragLayers();if(!dragEdit||!state.maps.leaflet)return;const built=previewGeometry(),at=built.at,nodes=built.nodes;const local=nodes.slice(Math.max(0,at-1),Math.min(nodes.length,at+2)).map(coord);if(local.length>1)dragPreviewLayers.push(L.polyline(local,{color:'#e47713',weight:7,dashArray:'5 7',interactive:false}).addTo(state.maps.leaflet));const icon=L.divIcon({className:'drag-handle',html:'<span>↔</span>',iconSize:[30,30],iconAnchor:[15,15]});const handle=L.marker(dragEdit.target,{icon,draggable:true,zIndexOffset:1200}).addTo(state.maps.leaflet);handle.bindTooltip(node('span',null,'拖曳此把手調整位置，放開後看街景'));handle.on('drag',()=>{const p=productMapCoord(handle.getLatLng());if(p&&dragEdit){dragEdit.target=p;dragEdit.moved=true;renderDragEdit();const b=previewGeometry();dragPreviewLayers[0]?.setLatLngs?.(b.nodes.slice(Math.max(0,b.at-1),Math.min(b.nodes.length,b.at+2)).map(coord));}});handle.on('dragend',()=>endRouteDrag(productMapCoord(handle.getLatLng())));dragPreviewLayers.push(handle);}
  function confirmDragEditV11(){const r=currentRoute(),d=dragEdit;if(!d||!r||r.id!==d.routeId)return;if(JSON.stringify(exportRoute(r))!==d.fingerprint){cancelDragEdit();toast('路線已變更，這次預覽已取消；請重新拖曳。');return;}const built=previewGeometry();if(d.kind==='move'&&distance(d.originalTarget,d.target)<1){cancelDragEdit();return;}const road=validName($('drag-road').value).trim()||'拖曳調整點（路名待確認）',turn=$('drag-turn').value||'unknown';const metadata={...d.target,shapeIndex:built.at,road,label:road,turnKind:['straight','right','left','two_stage'].includes(turn)?turn:'unknown',instruction:validName($('drag-note').value),confirmed:false,signal:'unknown',redWaitSeconds:null,extraTurnSeconds:null};pushUndo();if(d.kind==='insert'){let index=built.points.findIndex(p=>p.shapeIndex>built.at);if(index<0)index=built.points.length;built.points.splice(index,0,metadata);state.selectedStep=index;}else{built.points[d.pointIndex]={...built.points[d.pointIndex],...metadata};state.selectedStep=d.pointIndex;if(built.points[d.pointIndex+1])built.points[d.pointIndex+1].confirmed=false;}r.points=built.points;r.editShape={nodes:built.nodes,sourcePreset:d.baseShape.sourcePreset};workflowOf(r).phase='planning';cancelDragEdit(false);invalidateRoute(r);render();storeRoutes();toast('已採用並保存調整。原路線其餘彎曲保留，調整段的道路與轉法仍待核對。');}
  function bindLineDrag(line,route){line.on('click',e=>{L.DomEvent.stopPropagation(e);if(Date.now()<suppressRouteClickUntil)return;if(route.id!==state.routeId){selectRoute(route.id,{keepViewport:true,skipStation:true});return;}if(state.dragRouteMode&&isDrawing()){beginRouteDrag(productMapCoord(e.latlng));if(dragEdit)endRouteDrag(dragEdit.target);}else selectLocation(productMapCoord(e.latlng),{label:'路線上的位置'});});line.on('mousedown',e=>{if(!state.dragRouteMode||!isDrawing()||route.id!==state.routeId||e.originalEvent?.button>0)return;L.DomEvent.stopPropagation(e);L.DomEvent.preventDefault?.(e.originalEvent||e);if(!beginRouteDrag(productMapCoord(e.latlng)))return;const map=state.maps.leaflet,wasEnabled=map.dragging?.enabled?.()!==false;map.dragging?.disable?.();const move=ev=>updateRouteDrag(productMapCoord(ev.latlng)),end=ev=>{suppressRouteClickUntil=Date.now()+350;endRouteDrag(productMapCoord(ev.latlng));};map.on('mousemove',move);map.on('mouseup',end);const release=()=>{if(dragEdit){suppressRouteClickUntil=Date.now()+350;endRouteDrag(dragEdit.target);}};document.addEventListener('mouseup',release);dragPointerCleanup=()=>{map.off?.('mousemove',move);map.off?.('mouseup',end);document.removeEventListener?.('mouseup',release);if(wasEnabled)map.dragging?.enable?.();};});}
  function lineSegments(r){if(!r.custom||!r.editShape)return lineSegmentsV10(r);const nodes=r.editShape.nodes,result=[];for(let i=1;i<nodes.length;i++){const n=nodes[i],dashed=n.uncertain===true||n.edited===true;const label=n.road||'既有候選路段';const prev=result.at(-1);if(prev&&prev.dashed===dashed&&prev.label===label&&prev.edited===n.edited)prev.path.push(coord(n));else result.push({path:[coord(nodes[i-1]),coord(n)],dashed,label,edited:n.edited===true});}return result;}
  function drawMapV11(){clearLayers();const r=currentRoute();if(!r||!state.maps.leaflet){clearDragLayers();return;}const map=state.maps.leaflet;for(const route of allRoutes().filter(x=>x.id===r.id||state.compareOverlay||state.showAllRoutes)){const active=route.id===r.id;for(const seg of lineSegments(route)){const line=L.polyline(seg.path,{color:seg.edited?'#e47713':route.color||(route.id==='A'?'#176ac0':route.id==='B'?'#07846a':'#a34bb7'),weight:active?7:3,opacity:active?.9:.35,dashArray:seg.dashed?'9 7':null,bubblingMouseEvents:false}).addTo(map);line.bindTooltip(node('span',null,seg.label+(seg.edited?' · 拖曳後尚未沿道路接線':seg.dashed?' · 銜接待核對':'')));bindLineDrag(line,route);state.layers.push(line);}}const endpoints=r.custom?pointsOf(r):[state.home,state.office];for(const [p,label]of [[endpoints[0],'起'],[endpoints.at(-1),'終']])if(coord(p)){const icon=L.divIcon({className:'home-marker'+(label==='終'?' office-marker':''),html:label,iconSize:[28,28]});const marker=L.marker(p,{icon}).addTo(map).on('click',()=>selectLocation(p,{label:label==='起'?'路線起點':'路線終點'}));state.layers.push(marker);}drawTurnMarkers();drawPhotoMarkers();drawViewerMarker();if(dragEdit&&dragEdit.routeId===r.id)drawDragPreview();renderDragEdit();}
  function drawTurnMarkersV11(){if(!state.maps.leaflet)return;const r=currentRoute();if(!r)return;for(const item of turnEntries(r)){const kind=item.kind,arrow=kind.includes('left')?'↰':kind==='right'?'↱':kind==='two_stage'?'待':kind==='arrival'?'終':kind==='start'?'起':kind==='straight'||kind==='continue'?'↑':'?';const content=node('span','turn-badge');content.append(node('b',null,arrow),node('small',null,String(item.index+1)+(!item.confirmed?'?':'')));const marker=L.marker(item.p,{icon:L.divIcon({className:'turn-marker'+(!item.confirmed?' unconfirmed':' confirmed'),html:content,iconSize:[38,40],iconAnchor:[19,20]}),draggable:r.custom&&isDrawing(),riseOnHover:true,zIndexOffset:700}).addTo(state.maps.leaflet);marker.bindTooltip(node('span',null,(item.index+1)+'. '+item.label+(r.custom?' · 可拖曳調整':'')));marker.on('click',()=>{state.selectedStep=item.index;if(item.stationId)selectStation(item.stationId);else selectLocation(item.p,{label:item.label});renderSteps();});if(r.custom){marker.on('dragstart',()=>{if(state.dragRouteMode)beginRouteDrag(item.p,item.index);});marker.on('drag',()=>{if(dragEdit){dragEdit.target=productMapCoord(marker.getLatLng());renderDragEdit();}});marker.on('dragend',()=>{const p=productMapCoord(marker.getLatLng());if(state.dragRouteMode)endRouteDrag(p);else movePoint(item.index,p);});}state.layers.push(marker);}}
  function selectRouteV12Legacy(id,options={}){if(id!==state.routeId){cancelDragEdit(false);state.dragRouteMode=false;}selectRouteV10(id,options);renderDragEdit();}
  function setModeV12Legacy(mode){if(mode==='draw'&&currentRoute()&&!currentRoute().custom&&!state.dragRouteMode){startAdjust();return;}if(mode!=='draw'){cancelDragEdit(false);state.dragRouteMode=false;}setModeV10(mode);if(mode==='draw'&&state.dragRouteMode){$('mode-note').textContent='拖曳現成路線，放開看街景，再確認保存';$('map-help').textContent='按住路線拖動，或點線後拖白色把手。橘色修改段尚未自動沿道路接線。';}}
  function undoV12Legacy(){cancelDragEdit(false);undoV10();}
  function renderWorkflowV12Legacy(){renderWorkflowV10();if(state.dragRouteMode&&currentRoute()?.editShape)$('workflow-panel').hidden=true;renderDragEdit();}
  function renderResultsV11(){renderResultsV10();const r=currentRoute();if(r?.custom&&r.editShape){$('distance-note').textContent='候選幾何長度（含未確認銜接）';$('duration-note').textContent=routeMetrics(r).seconds==null?'未取得道路車流時間；人工模型需填完整':'人工假設模型，非道路重算';$('route-warning').textContent='已保留原始線形；拖曳段尚未自動沿合法機車道路接線，不可把橘色直連當成導航。';}}
  function confirmedPath(r){if(!r.editShape)return confirmedPathV10(r);const points=pointsOf(r);let last=-1;for(const p of points){if(!p.confirmed)break;last=p.shapeIndex;}return last<0?[]:r.editShape.nodes.slice(0,last+1).map(coord);}
  function updatePointMetaV12Legacy(index,patch){const r=currentRoute(),shape=r?.editShape;if(!shape){updatePointMetaV10(index,patch);return;}cancelDragEdit(false);updatePointMetaV10(index,patch);}
  function movePointV12Legacy(index,p){const r=currentRoute();if(!r?.editShape){movePointV10(index,p);return;}if(!coord(p)||!r.points[index])return;pushUndo();const at=r.points[index].shapeIndex;r.points[index]={...r.points[index],...coord(p),confirmed:false,road:'移動後路名待確認',instruction:'',turnKind:'unknown'};r.editShape.nodes[at]={...r.editShape.nodes[at],...coord(p),edited:true,uncertain:true,road:'移動後道路待確認'};if(r.editShape.nodes[at+1])Object.assign(r.editShape.nodes[at+1],{edited:true,uncertain:true});if(r.points[index+1])r.points[index+1].confirmed=false;invalidateRoute(r);render();storeRoutes();selectLocation(p,{label:'移動後待確認的位置'});}
  function deletePointV12Legacy(index){const r=currentRoute();if(!r?.editShape){deletePointV10(index);return;}if(index===0||index===r.points.length-1){toast('完整起終點請用「調整起終點」，不要直接刪除。');return;}cancelDragEdit(false);pushUndo();const at=r.points[index].shapeIndex;if(!r.points.some((p,i)=>i!==index&&p.shapeIndex===at)){r.editShape.nodes.splice(at,1);for(const p of r.points)if(p.shapeIndex>at)p.shapeIndex--;if(r.editShape.nodes[at])Object.assign(r.editShape.nodes[at],{edited:true,uncertain:true});}r.points.splice(index,1);if(r.points[index])r.points[index].confirmed=false;invalidateRoute(r);render();storeRoutes();}
  function routeTextV11(r){if(!r?.editShape)return routeTextV10(r);const rows=[routeCaption(r),'保留既有候選線形；拖曳修改段未沿道路重算。'];const points=pointsOf(r),nodes=r.editShape.nodes;for(const [i,p]of points.entries()){const previous=i?points[i-1].shapeIndex:0,meters=i?Math.round(engine.distanceMeters(nodes.slice(previous,p.shapeIndex+1))):0;rows.push((i+1)+'. '+(p.road||p.label||'路名待確認')+'｜'+turnTitle(p.turnKind)+(i?'｜至此約 '+meters+' m（候選幾何）':'')+'｜'+(p.confirmed?'使用者已確認':'待核對')+(p.instruction?'\n   '+p.instruction:''));}if(r.originalText)rows.push('\n原始候選文字（拖曳後可能不再適用）：\n'+r.originalText);return rows.join('\n');}
  function confirmSegmentV12Legacy(){if(currentRoute()?.editShape){const p=coord(state.selection);if(!p)return;if(!state.dragRouteMode)startAdjust();if(beginRouteDrag(p)){updateRouteDrag(p);endRouteDrag(p);}return;}confirmSegmentV10();}
  function addSelectedPointV12Legacy(){if(currentRoute()?.editShape){confirmSegment();return;}addSelectedPointV10();}
  function bindDragUIV12Legacy(){for(const [id,fn]of Object.entries({'start-adjust':()=>startAdjust(),'start-from-a':()=>uxEditRoute('A'),'start-from-b':()=>uxEditRoute('B'),'accept-drag':confirmDragEdit,'cancel-drag':()=>cancelDragEdit()}))$(id).addEventListener('click',fn);document.addEventListener('keydown',e=>{if(e.key==='Escape'&&dragEdit)cancelDragEdit();});}

  // A road preview is separate from saved routes until the user accepts it.
  let roadPreview=null,roadSequence=0;
  function pointKey(points){return points.map(p=>p.lat.toFixed(6)+','+p.lng.toFixed(6)).join('|');}
  function isHybridRoad(road){return ['hybrid_osm_google_v21','hybrid_osm_path_v22'].includes(road?.provider)&&road?.costing==='motorcycle_mixed';}
  function timeSourceLabel(road){return isHybridRoad(road)?'分段混合估計（非尖峰實測）':'道路模型（非尖峰實測）';}
  function cleanRoadRoute(value,r){
    const hybrid=isHybridRoad(value),osm=value?.provider==='valhalla_fossgis'&&['motor_scooter','motorcycle'].includes(value.costing);
    if(!value||!(hybrid||osm)||value.pointKey!==pointKey(pointsOf(r))||!r.editShape||!Array.isArray(value.steps)||!value.steps.length||value.steps.length>200)return null;
    for(const n of [value.distanceMeters,value.durationSeconds])if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1000000)return null;
    const nodes=r.editShape.nodes;
    if(!value.steps.every(s=>Number.isInteger(s.shapeIndex)&&s.shapeIndex>=0&&s.shapeIndex<nodes.length&&coord(s.start)&&distance(s.start,nodes[s.shapeIndex])<1&&Number.isFinite(s.distanceMeters)&&s.distanceMeters>=0&&Number.isFinite(s.durationSeconds)&&s.durationSeconds>=0))return null;
    return {provider:value.provider,costing:value.costing,pointKey:value.pointKey,distanceMeters:value.distanceMeters,durationSeconds:value.durationSeconds,computedAt:validName(value.computedAt),timeNote:hybrid?validName(value.timeNote):'',segmentSources:hybrid?clone(value.segmentSources||[]):[],steps:value.steps.map(s=>({road:validName(s.road),turnKind:validName(s.turnKind),instruction:validName(s.instruction),shapeIndex:s.shapeIndex,start:coord(s.start),distanceMeters:s.distanceMeters,durationSeconds:s.durationSeconds,confirmed:false,warning:hybrid?validName(s.warning):'OSM 機車模型；車道、禁轉與兩段式待轉需現場核對。'}))};
  }
  function roadOf(r){return r&&cleanRoadRoute(r.roadRoute,r);}
  function exportRouteV16(r){const out=exportRouteV11(r),road=cleanRoadRoute(r.roadRoute,out);if(road){out.roadRoute=road;out.source='osm_scooter';out.distanceMeters=road.distanceMeters;out.durationSeconds=road.durationSeconds;out.computedAt=road.computedAt;}return out;}
  function invalidateRoute(r){delete r.roadRoute;invalidateRouteV11(r);}
  function routeMetricsV12Legacy(r){const road=roadOf(r);return road?{dist:road.distanceMeters,seconds:road.durationSeconds,draft:false,distanceKind:'OSM 機車道路里程',timeKind:'OSM 道路模型（非尖峰車流）'}:routeMetricsV11(r);}
  function draftControlsV12Legacy(){if(!dragEdit)return pointsOf(currentRoute()).map(p=>({...p}));const d=dragEdit,b=previewGeometry(),points=b.points.map(p=>({...p}));const value={...d.target,shapeIndex:b.at,road:'調整位置',label:'調整位置',turnKind:'unknown',confirmed:false,signal:'unknown',redWaitSeconds:null,extraTurnSeconds:null};if(d.kind==='insert'){let at=points.findIndex(p=>p.shapeIndex>b.at);if(at<0)at=points.length;points.splice(at,0,value);}else points[d.pointIndex]={...points[d.pointIndex],...value};return points;}
  function clearRoadPreview(){roadSequence++;roadPreview?.controller?.abort();roadPreview=null;}
  function beginRouteDragV12Legacy(p,index=null){const preview=roadPreview?.status==='ready'?roadPreview:null,r=currentRoute();if(!preview||!r||preview.routeId!==r.id)return beginRouteDragV11(p,index);const snapshot=clone(r),fingerprint=JSON.stringify(exportRoute(r)),result=preview.result;const points=result.points.map((n,i)=>({...preview.points[i],...n,confirmed:false}));let accepted=false;try{r.points=points;r.editShape={nodes:result.path.map(n=>({...coord(n),road:'道路預覽',uncertain:false,edited:false})),sourcePreset:snapshot.editShape?.sourcePreset||null};r.path=result.path.map(coord);r.geometry=r.path;delete r.roadRoute;accepted=beginRouteDragV11(p,index);}finally{for(const key of Object.keys(r))delete r[key];Object.assign(r,snapshot);}if(accepted&&dragEdit){dragEdit.fingerprint=fingerprint;dragEdit.fromRoadPreview=true;}return accepted;}
  function cancelDragEditV12Legacy(redraw=true){clearRoadPreview();cancelDragEditV11(redraw);if(redraw){renderResults();renderSteps();}}
  function validateRoadReplyV12Legacy(value,points,profile=null){if(profile&&value?.costing!==profile)throw new Error('回傳的機車模式不符，原路線保留。');if(!value||value.provider!=='valhalla_fossgis'||!['motor_scooter','motorcycle'].includes(value.costing)||!Array.isArray(value.path)||value.path.length<2||value.path.length>1000||!value.path.every(coord)||!Array.isArray(value.points)||value.points.length!==points.length)throw new Error('道路回應不完整；原路線保留。');const r={points:value.points,editShape:{nodes:value.path},roadRoute:{...value,pointKey:pointKey(value.points)}};if(!cleanRoadRoute(r.roadRoute,r))throw new Error('道路回應格式不正確；原路線保留。');for(let i=0;i<points.length;i++){const p=value.points[i];if(!Number.isInteger(p.shapeIndex)||p.shapeIndex<0||p.shapeIndex>=value.path.length||distance(p,value.path[p.shapeIndex])>1||distance(p,points[i])>101)throw new Error('道路離選點太遠，請把點移到道路上。');if(i&&p.shapeIndex<value.points[i-1].shapeIndex)throw new Error('道路順序不正確。');}return value;}
  async function requestRoadPreviewV12Legacy(){const r=currentRoute();if(!r?.custom)return;if(!['http:','https:'].includes(location.protocol)||typeof window.fetch!=='function'){toast('沿街道計算需要從工作台網址開啟。');return;}const points=draftControls();if(points.length<2||points.length>50){toast('免費沿道路重算每條可用 2～50 個途經點；請先整理畫點。');return;}clearRoadPreview();const profile=$('road-profile').value||'motorcycle';const seq=roadSequence,controller=typeof AbortController==='function'?new AbortController():null;roadPreview={routeId:r.id,fingerprint:JSON.stringify(exportRoute(r)),points,profile,status:'loading',result:null,error:null,controller};renderDragEdit();renderResults();renderSteps();try{let token=persistence.csrf;if(!token){const handshake=await window.fetch(data.publicEdition?'/api/session':'/api/routes',{cache:'no-store',signal:controller?.signal});if(!handshake.ok)throw new Error('規劃服務未就緒，請稍後重試。');token=(await handshake.json()).csrf;if(typeof token!=='string')throw new Error('規劃服務版本不符。');}if(seq!==roadSequence||!roadPreview)return;const response=await window.fetch('/api/scooter-route',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':token,'X-Planner-Consent':productConsent()?'yes':'no'},body:JSON.stringify({points:points.map(coord),profile}),signal:controller?.signal});const answer=await response.json();if(seq!==roadSequence||!roadPreview)return;if(!response.ok)throw new Error(answer.message||'免費道路服務暫時無法計算，原路線保留。');if(currentRoute()?.id!==r.id||JSON.stringify(exportRoute(currentRoute()))!==roadPreview.fingerprint){cancelDragEdit();toast('路線已改變；舊計算結果不會覆蓋目前路線。');return;}roadPreview.result=validateRoadReply(answer.route,points,profile);roadPreview.status='ready';if(dragEdit){const index=dragEdit.kind==='move'?dragEdit.pointIndex:points.findIndex(p=>distance(p,dragEdit.target)<.2);const snapped=roadPreview.result.points[index];if(snapped)selectLocation(snapped,{label:'道路重算後的位置（已吸附到街道）'});}drawDragPreview();renderDragEdit();renderResults();renderSteps();renderRouteText();toast('已沿街道產生完整預覽；請確認公里、模型時間與每一步，再保存。');}catch(error){if(seq!==roadSequence||!roadPreview||error.name==='AbortError')return;roadPreview.status='error';roadPreview.error=cleanError(error);renderDragEdit();renderResults();renderSteps();}}
  function recalculateRoadsV12Legacy(){if(!currentRoute()?.custom){startAdjust();return;}void requestRoadPreview();}
  function startAdjustV12Legacy(id){startAdjustV11(id);if($('auto-road-routing').checked&&['http:','https:'].includes(location.protocol)&&typeof window.fetch==='function'&&!roadOf(currentRoute()))void requestRoadPreview();}
  function endRouteDragV12Legacy(p){endRouteDragV11(p);if(dragEdit&&$('auto-road-routing').checked)void requestRoadPreview();}
  function renderDragEditV12Legacy(){renderDragEditV11();const preview=roadPreview,box=$('drag-review');if(preview)box.hidden=false;$('road-preview-status').textContent=preview?.status==='loading'?'正在沿街道重算整條路線…':preview?.status==='ready'?'沿街道預覽已完成，尚未保存':preview?.status==='error'?preview.error:'';$('road-preview-metrics').textContent=preview?.result?'全程 '+kmLabel(preview.result.distanceMeters)+' · 模型 '+minuteLabel(preview.result.durationSeconds):'';$('road-preview-note').textContent=preview?'含起點到終點。此為 OSM 機車道路模型；沒有早尖峰即時車流、完整號誌及待轉秒數。':'';$('retry-road-route').hidden=!preview||preview.status!=='error';$('accept-drag').disabled=!!preview&&preview.status!=='ready';if(preview)$('drag-change-note').textContent='道路預覽會重新計算整條路線；藍線與右側文字是這次結果。請確認後保存，取消會保留原方案。';if(preview&&!dragEdit)$('drag-point-coord').textContent='依起終點與 '+Math.max(0,preview.points.length-2)+' 個途經點計算。';}
  function drawDragPreviewV12Legacy(){drawDragPreviewV11();const result=roadPreview?.result,map=state.maps.leaflet;if(!map)return;if(!result){if(dragEdit?.fromRoadPreview)dragPreviewLayers.push(L.polyline(dragEdit.baseShape.nodes,{color:'#087df0',weight:4,opacity:.65,interactive:false}).addTo(map));return;}dragPreviewLayers.push(L.polyline(result.path,{color:'#fff',weight:12,opacity:.95,interactive:false}).addTo(map));const blue=L.polyline(result.path,{color:'#087df0',weight:7,opacity:1,interactive:true,bubblingMouseEvents:false}).addTo(map);bindLineDrag(blue,currentRoute());dragPreviewLayers.push(blue);for(const [i,s] of result.steps.entries()){if(['start','arrival','straight'].includes(s.turnKind))continue;const badge=node('span','turn-badge');badge.append(node('b',null,iconFor(s.turnKind)),node('small',null,String(i+1)+(['left','uturn'].includes(s.turnKind)?'?':'')));const marker=L.marker(s.start,{icon:L.divIcon({className:'turn-marker road-preview-marker',html:badge,iconSize:[38,40],iconAnchor:[19,20]}),zIndexOffset:900}).addTo(map);marker.bindTooltip(node('span',null,(i+1)+'. '+s.instruction));marker.on('click',()=>selectLocation(s.start,{label:s.instruction}));dragPreviewLayers.push(marker);}}
  function applyRoadPreview(){const r=currentRoute(),preview=roadPreview,result=preview?.result;if(!r||!result||r.id!==preview.routeId||JSON.stringify(exportRoute(r))!==preview.fingerprint){cancelDragEdit();toast('預覽已過期，請重新沿街道計算。');return;}const draft=preview.points,d=dragEdit;pushUndo();const points=result.points.map((p,i)=>{const previous=draft[i],shift=distance(previous,p);return {...previous,...p,confirmed:false,...(shift>2?{signal:'unknown',redWaitSeconds:null,extraTurnSeconds:null,streetEvidence:'unknown'}:{})};});if(d){let index=d.kind==='move'?d.pointIndex:draft.findIndex(p=>distance(p,d.target)<.2);if(index>=0){points[index]={...points[index],road:validName($('drag-road').value)||points[index].road,label:validName($('drag-road').value)||points[index].label,turnKind:['straight','right','left','two_stage'].includes($('drag-turn').value)?$('drag-turn').value:'unknown',instruction:validName($('drag-note').value),signal:'unknown',redWaitSeconds:null,extraTurnSeconds:null};}}const nodes=result.path.map(p=>({...coord(p),road:'沿道路重算路段',uncertain:false,edited:false}));for(let i=0;i<result.steps.length;i++){const s=result.steps[i],end=result.steps[i+1]?.shapeIndex??nodes.length-1;for(let n=s.shapeIndex;n<=end;n++)nodes[n].road=s.road;}r.points=points;r.editShape={nodes,sourcePreset:r.editShape?.sourcePreset||null};r.path=nodes.map(coord);r.geometry=r.path;r.roadRoute={provider:result.provider,costing:result.costing,pointKey:pointKey(points),distanceMeters:result.distanceMeters,durationSeconds:result.durationSeconds,computedAt:result.computedAt,steps:result.steps};r.source='osm_scooter';r.status='road_model';r.warnings=['已沿 OpenStreetMap 機車道路重算；實際車道、禁轉與兩段式待轉仍需核對，時間不含完整尖峰車流。'];workflowOf(r).phase='planning';cancelDragEdit(false);state.routeSeq++;render();storeRoutes();toast('道路路徑、公里、模型時間與完整文字已保存到左側方案。');}
  function confirmDragEditV12Legacy(){if(roadPreview){if(roadPreview.status==='ready')applyRoadPreview();else toast('請等道路計算完成，或取消後再試。');return;}confirmDragEditV11();}
  function roadPresentationV12Legacy(r){return roadPreview&&r&&roadPreview.routeId===r.id&&roadPreview.result?roadPreview.result:roadOf(r);}
  function drawMapV12Legacy(){if(roadPreview&&roadPreview.routeId!==currentRoute()?.id)cancelDragEdit(false);drawMapV11();if(roadPreview?.result&&!dragEdit)drawDragPreview();}
  function renderResultsV12Legacy(){renderResultsV11();const r=currentRoute(),road=roadPresentation(r);if(!road)return;const preview=roadPreview?.routeId===r.id&&roadPreview.result;$('distance-value').textContent=kmLabel(road.distanceMeters);$('duration-value').textContent=minuteLabel(road.durationSeconds);$('distance-note').textContent=(preview?'預覽，尚未保存 · ':'')+'起點至終點的 OSM 道路里程';$('duration-note').textContent='道路模型預估；非 07:00～09:00 車流實測';$('route-warning').textContent='路徑已沿道路計算。左轉是否要待轉、白牌禁行車道與現場管制仍需核對；模型時間沒有完整尖峰、紅燈及兩段式停等資料。';$('confirmed-progress').textContent=(preview?'正在確認道路預覽':'已保存道路路徑')+' · '+road.steps.length+' 個文字步驟';$('route-badges').replaceChildren(node('span','pill',preview?'道路預覽':'OSM 機車道路'),node('span','pill','轉法與待轉仍待核對'));}
  function renderStepsV12Legacy(){const r=currentRoute(),road=roadPresentation(r);if(!road){renderStepsV11();return;}const box=$('steps-list');box.replaceChildren();$('step-count').textContent=(roadPreview?.result?'預覽 · ':'')+road.steps.length+' 個道路步驟';road.steps.forEach((s,i)=>{const card=node('article','step-card'),button=node('button','step-select'),main=node('div','step-main');button.append(node('span','step-icon',iconFor(s.turnKind)),main);main.append(node('strong',null,(i+1)+'. '+s.road),node('span',null,s.instruction),node('span','muted','接著約 '+Math.round(s.distanceMeters)+' m'));button.addEventListener('click',()=>{state.selectedStep=i;selectLocation(s.start,{label:(i+1)+'. '+s.instruction,fromStep:true});});card.append(button);if(['left','uturn'].includes(s.turnKind))card.append(node('div','step-warning','左轉／迴轉方式未經現場確認，請查看待轉及禁轉標誌。'));box.append(card);});if(!roadPreview?.result){const details=node('details','details');details.append(node('summary',null,'編輯起終點與途經點（'+pointsOf(r).length+'）'));pointsOf(r).forEach((p,i)=>{const card=node('article','step-card');card.append(node('strong',null,'途經點 '+(i+1)+' · '+(p.road||p.label||'')),pointEditor(r,i,p));details.append(card);});box.append(details);}}
  function routeTextV12Legacy(r){const road=roadPresentation(r);if(!road)return routeTextV11(r);const rows=[routeCaption(r),'全程 '+kmLabel(road.distanceMeters)+'｜模型 '+minuteLabel(road.durationSeconds)+'（未取得完整尖峰／號誌／待轉時間）'];for(const [i,s]of road.steps.entries())rows.push((i+1)+'. '+s.instruction+'；接著約 '+Math.round(s.distanceMeters)+' m');rows.push('來源：OpenStreetMap / Valhalla 機車道路模型。非臺灣白牌專用導航，現場禁行車道、禁轉及兩段式待轉仍待核對。');const notes=pointsOf(r).filter(p=>p.instruction||p.turnKind==='two_stage');if(notes.length){rows.push('你的補充標註：');for(const p of notes)rows.push((p.road||p.label||'途經點')+'：'+(p.turnKind==='two_stage'?'已標註兩段式待轉。':'')+(p.instruction||''));}return rows.join('\n');}
  function drawTurnMarkersV12Legacy(){const r=currentRoute(),road=roadOf(r);if(!road){drawTurnMarkersV11();return;}const map=state.maps.leaflet;if(!map)return;for(const [i,s]of road.steps.entries()){const badge=node('span','turn-badge');badge.append(node('b',null,iconFor(s.turnKind)),node('small',null,String(i+1)+(['left','uturn'].includes(s.turnKind)?'?':'')));const marker=L.marker(s.start,{icon:L.divIcon({className:'turn-marker'+(['left','uturn'].includes(s.turnKind)?' unconfirmed':' confirmed'),html:badge,iconSize:[38,40],iconAnchor:[19,20]}),draggable:isDrawing(),riseOnHover:true,zIndexOffset:700}).addTo(map);marker.bindTooltip(node('span',null,(i+1)+'. '+s.instruction));marker.on('click',()=>{state.selectedStep=i;selectLocation(s.start,{label:s.instruction});});marker.on('dragstart',()=>{if(state.dragRouteMode)beginRouteDrag(s.start);});marker.on('dragend',()=>{if(state.dragRouteMode)endRouteDrag(productMapCoord(marker.getLatLng()));});state.layers.push(marker);}}
  function renderRouteListV12Legacy(){renderRouteListV11();const rows=$('route-list').children;allRoutes().forEach((r,i)=>{const m=routeMetrics(r);const card=rows[i]?.children[0],road=roadOf(r);if(road&&card?.children[1])card.children[1].textContent='道路已計算 · '+road.steps.length+' 個步驟 · 轉法待核對';card?.append(node('small','muted',kmLabel(m.dist)+' · '+minuteLabel(m.seconds)+' · '+m.timeKind));});}
  function compareV12Legacy(){compareV11();const base=roadOf(currentRoute()),rows=$('compare-body').children;allRoutes().forEach((r,i)=>{const road=roadOf(r);if(base&&road&&base.costing===road.costing){const delta=road.durationSeconds-base.durationSeconds;rows[i].children[3].textContent=(delta>=0?'+':'−')+Math.abs(delta).toFixed(0)+' 秒（同模式道路模型差）';}});}
  function bindRoutingUIV12Legacy(){if(!['motor_scooter','motorcycle'].includes($('road-profile').value))$('road-profile').value='motorcycle';if(typeof $('auto-road-routing').checked!=='boolean')$('auto-road-routing').checked=true;$('recompute-roads').addEventListener('click',recalculateRoads);$('retry-road-route').addEventListener('click',()=>void requestRoadPreview());}

  // One pending transaction; rendering never combines draft geometry with a road result.
  let clickEdit = null;
  const SNAP_LIMIT = 30;
  function baselineRoad(r) {
    if (!r) return null;
    if (!r.custom) return data.computedPresets?.[r.id] || null;
    return productCachedRoadV28(r);
  }
  function roadPresentationV16(r) {
    return r && roadPreview?.routeId === r.id && roadPreview.status === 'ready'
      ? roadPreview.result : baselineRoad(r);
  }
  function controlsOf(r) {
    if(!r)return [];
    const raw = pointsOf(r);
    const cached = !r.custom && baselineRoad(r);
    return cached ? cached.points.map((p,i)=>({...raw[i], ...p})) : raw;
  }
  function fingerprint(r) { return JSON.stringify(exportRoute(r)); }
  function pendingClear() { clearRoadPreview(); clearDragLayers(); finishPointer(); dragEdit=null; }
  function cancelDragEditV14(redraw=true) {
    pendingClear(); clickEdit=null;
    if (redraw) render();
  }
  function beginRouteDrag() { return false; }
  function updateRouteDrag() {}
  function endRouteDrag() {}
  function drawDragPreview() {}
  function ensureCustom() {
    const original=currentRoute(), r=ensureCustomV10();
    if (original && !original.custom && baselineRoad(original)) {
      Object.assign(r, routeWithResult(r,baselineRoad(original),controlsOf(original)));
    }
    return r;
  }
  function startAdjustV14(id) {
    cancelDragEdit(false);
    if (id && id!==state.routeId) selectRouteV9(id,{keepViewport:true,skipStation:true});
    const r=currentRoute(); if(!r)return;
    state.mode='draw'; state.dragRouteMode=false; state.showAllRoutes=false;state.compareOverlay=false;
    $('show-all-routes').setAttribute('aria-pressed','false');
    if($('compare-dialog').open)closeDialog('compare-dialog');
    clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'none',basePoints:clone(controlsOf(r)),target:null};
    render();
    if (!baselineRoad(r) && controlsOf(r).length>=2) void requestRoadPreview();
    else toast('選擇新增、移動或替換路段，再點道路查看街景。');
  }
  function chooseEditV14(kind, options={}) {
    const r=currentRoute();if(!r)return false;
    const pts=controlsOf(r), n=pts.length;
    if(n<2){toast('先設定起點與終點。');return false;}
    const index=Number(options.index??1),start=Number(options.start??0),end=Number(options.end??n-1);
    const valid=(kind==='insert'&&Number.isInteger(index)&&index>=1&&index<n)||
      (kind==='move'&&Number.isInteger(index)&&index>=0&&index<n)||
      (kind==='replace'&&Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end<n&&end>start)||
      (kind==='delete'&&Number.isInteger(index)&&index>0&&index<n-1);
    if(!valid){toast('請選擇有效的途經點或前後路段。');return false;}
    cancelDragEdit(false); state.mode='draw';state.dragRouteMode=false;state.compareOverlay=false;state.showAllRoutes=false;
    clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind,index,start,end,basePoints:clone(pts),target:null};
    render();
    if(kind==='move')selectLocation(pts[index],{viewOnly:true,label:'準備移動 P'+(index+1)+'，請點新的道路位置'});
    if(kind==='delete')void requestRoadPreview();
    else toast('已選定調整範圍。點目標道路看街景，再按「預覽這個走法」。');
    return true;
  }
  function selectLocationV13(p, options={}) {
    p=coord(p);if(!p)return;
    const canChoose=isDrawing()&&clickEdit&&['insert','move','replace'].includes(clickEdit.kind);
    if(canChoose&&!options.viewOnly&&!options.fromStep){
      pendingClear(); clickEdit.target=p;
    }
    selectLocationV9(p, options);
    renderEditor();renderResults();renderSteps();renderRouteText();drawMap();
  }
  function draftControlsV13() {
    const d=clickEdit;
    const pts=clone(d?.basePoints||controlsOf(currentRoute()));
    if(!d||['none','recompute'].includes(d.kind))return pts;
    if(d.kind==='delete'){pts.splice(d.index,1);return pts;}
    if(!coord(d.target))throw new Error('請先點選想經過的道路，再查看街景。');
    const p={...d.target,road:'新選道路位置',label:'新選道路位置',turnKind:'unknown',confirmed:false,signal:'unknown',streetEvidence:'unknown',redWaitSeconds:null,extraTurnSeconds:null};
    if(d.kind==='insert')pts.splice(d.index,0,p);
    if(d.kind==='move')pts[d.index]={...pts[d.index],...p};
    if(d.kind==='replace')pts.splice(d.start+1,d.end-d.start-1,p);
    return pts;
  }
  function candidateIndexV14() {
    return !clickEdit?null:clickEdit.kind==='replace'?clickEdit.start+1:
      ['insert','move'].includes(clickEdit.kind)?clickEdit.index:null;
  }
  function validateRoadReply(value,points,profile=null) {
    const r=validateRoadReplyV12Legacy(value,points,profile);
    for(let i=0;i<points.length;i++){
      const gap=distance(points[i],r.points[i]);
      const upstream=r.snapDistancesMeters?.[i]??r.snapDistances?.[i]??0;
      if(gap>SNAP_LIMIT||!Number.isFinite(upstream)||upstream<0||upstream>SNAP_LIMIT)
        throw new Error('第 '+(i+1)+' 個點離實際道路超過 30 公尺，請重新選在道路上。');
    }
    if(distance(r.points[0],r.path[0])>1||distance(r.points.at(-1),r.path.at(-1))>1)
      throw new Error('道路起終點未接合，已保留原方案。');
    return r;
  }
  async function requestRoadPreviewV16() {
    const r=currentRoute();if(!r)return;
    if(!['http:','https:'].includes(location.protocol)||typeof window.fetch!=='function'){toast('請從工作台網址使用道路計算。');return;}
    if(!ensureProductConsent())return;
    if(!clickEdit) {
      state.mode='draw';state.showAllRoutes=false;state.compareOverlay=false;
      clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'recompute',basePoints:clone(controlsOf(r)),target:null};
    }
    let points;try{points=draftControls();}catch(e){toast(cleanError(e));return;}
    if(points.length<2||points.length>50){toast('每條路線需要 2～50 個起終點與途經點。');return;}
    pendingClear();
    const seq=roadSequence,profile=$('road-profile').value||'motorcycle';
    const controller=typeof AbortController==='function'?new AbortController():null;
    roadPreview={routeId:r.id,fingerprint:fingerprint(r),points,profile,status:'loading',result:null,error:null,controller};
    const selectionAtRequest=state.requestSeq;
    render();
    try {
      let token=persistence.csrf;
      if(!token){const h=await window.fetch(data.publicEdition?'/api/session':'/api/routes',{cache:'no-store',signal:controller?.signal});if(!h.ok)throw new Error('規劃服務未就緒。');token=(await h.json()).csrf;}
      if(seq!==roadSequence||!roadPreview)return;
      if(typeof token!=='string')throw new Error('規劃服務版本不符。');
const response=await routingFetchV27('/api/scooter-route',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':token,'X-Planner-Consent':productConsent()?'yes':'no'},body:JSON.stringify({points:points.map(coord),profile,maxSnapMeters:SNAP_LIMIT}),signal:controller?.signal});
      const answer=await response.json();
      if(seq!==roadSequence||!roadPreview)return;
      if(!response.ok)throw new Error(answer.message||'道路服務暫時無法計算。');
      if(currentRoute()?.id!==r.id||fingerprint(currentRoute())!==roadPreview.fingerprint){cancelDragEdit();toast('路線已改變，舊回應已取消。');return;}
      roadPreview.result=validateRoadReply(answer.route,points,profile);roadPreview.status='ready';
      const at=candidateIndex();
      if(at!==null&&state.requestSeq===selectionAtRequest)selectLocation(roadPreview.result.points[at],{viewOnly:true,label:'實際採用的道路位置 P'+(at+1)});
      render();toast('道路預覽完成。確認完整走法、公里與模型時間後，再採用保存。');
    }catch(error){
      if(seq!==roadSequence||!roadPreview||error.name==='AbortError')return;
      roadPreview.status='error';roadPreview.result=null;roadPreview.error=cleanError(error);render();
    }
  }
  function routeWithResultV14(base,result,draft) {
    const r=clone(base);
    r.points=result.points.map((p,i)=>({...draft[i],...p,confirmed:false,...(distance(draft[i],p)>2?{signal:'unknown',redWaitSeconds:null,extraTurnSeconds:null,streetEvidence:'unknown'}:{})}));
    const nodes=result.path.map(p=>({...coord(p),road:'道路計算路段',uncertain:false,edited:false}));
    for(let i=0;i<result.steps.length;i++)for(let n=result.steps[i].shapeIndex;n<=(result.steps[i+1]?.shapeIndex??nodes.length-1);n++)nodes[n].road=result.steps[i].road;
    r.editShape={nodes,sourcePreset:base.editShape?.sourcePreset||(['A','B'].includes(base.id)?base.id:null)};
    r.path=nodes.map(coord);r.geometry=r.path;r.custom=true;
    r.roadRoute={provider:result.provider,costing:result.costing,pointKey:pointKey(r.points),distanceMeters:result.distanceMeters,durationSeconds:result.durationSeconds,computedAt:result.computedAt,timeNote:result.timeNote,segmentSources:result.segmentSources,steps:result.steps};
    r.roadRoute=cleanRoadRoute(r.roadRoute,r);
    r.source=isHybridRoad(result)?'mixed_user_confirmed_geometry':'osm_scooter';r.status=isHybridRoad(result)?'mixed_source_estimate':'road_model';r.workflow={phase:'planning',originConfirmed:true,goalConfirmed:true};
    r.warnings=[isHybridRoad(result)?result.timeNote:'整條線為道路計算結果；白牌禁行、兩段式待轉與尖峰停等仍需核對。'];
    return r;
  }
  function confirmDragEditV14() {
    const r=currentRoute(),p=roadPreview;
    if(!r||p?.status!=='ready'){toast('請先完成道路預覽。');return;}
    if(p.routeId!==r.id||p.fingerprint!==fingerprint(r)){cancelDragEdit();toast('預覽已過期，請重新計算。');return;}
    const next=routeWithResult(r,p.result,p.points);
    if(r.custom){pushUndo();Object.assign(r,next);}
    else {
      next.id='C'+Date.now().toString(36)+'-'+state.customRoutes.length;
      next.name=validName(routeCaption(r)+'・地圖改道方案');next.originalText=routeText(r);
      const prior=routeWithResult(r,baselineRoad(r)||p.result,baselineRoad(r)?controlsOf(r):p.points);prior.id=next.id;prior.name=next.name;state.customRoutes.push(next);library.order.push(next.id);state.routeId=next.id;state.undo=baselineRoad(r)?[{routeId:next.id,snapshot:prior}]:[];
    }
    cancelDragEdit(false);state.routeSeq++;render();storeRoutes();
    toast('完整道路、公里、模型時間與逐步文字已保存。可繼續選擇下一個調整。');
  }
  function setModeV16(mode) {
    if(mode==='draw'){if(!isDrawing())startAdjust();return;}
    cancelDragEdit(false);state.mode='view';state.dragRouteMode=false;render();
  }
  function selectRouteV16(id,options={}) {
    cancelDragEdit(false);state.mode='view';state.dragRouteMode=false;
    selectRouteV10(id,options);render();if(!baselineRoad(currentRoute())&&controlsOf(currentRoute()).length>=2)void requestRoadPreview();
  }
  function undo(){cancelDragEdit(false);undoV10();}
  function movePoint(index,p){if(chooseEdit('move',{index})&&coord(p))selectLocation(p);}
  function deletePoint(index){return chooseEdit('delete',{index});}
  function setEndpointV13(kind){const p=coord(state.selection);if(!p)return;movePoint(kind==='home'?0:controlsOf(currentRoute()).length-1,p);}
  function confirmSegment(){return requestRoadPreview();}
  function addSelectedPointV13(){
    if(!clickEdit||!['insert','move','replace'].includes(clickEdit.kind)){toast('先在左側選「新增途經點／移動點／替換一段」，指定順序後再點道路。');return;}
    if(!clickEdit.target&&coord(state.selection))selectLocation(state.selection);
    return requestRoadPreview();
  }
  function recalculateRoadsV14(){cancelDragEdit(false);return requestRoadPreview();}
  function newCustomBeforeStorageV172(empty=false){if(empty){newCommute();return;}cancelDragEdit(false);ensureCustom();render();storeRoutes();startAdjust();}
  function newCommuteBeforeStorageV172(){
    cancelDragEdit(false);const r={id:'C'+Date.now().toString(36)+'-'+state.customRoutes.length,name:'我的通勤方案 '+(state.customRoutes.length+1),custom:true,points:[{...coord(state.home),label:'住家',turnKind:'start'},{...coord(state.office),label:'公司',turnKind:'arrival'}],keepDestination:true,workflow:{phase:'planning'},modelInputs:{}};
    state.customRoutes.push(r);library.order.push(r.id);state.routeId=r.id;state.undo=[];storeRoutes();startAdjust();fitRoute();
  }
  function routeMetrics(r){const road=baselineRoad(r);return road?{dist:road.distanceMeters,seconds:road.durationSeconds,draft:false,distanceKind:isHybridRoad(road)?'分段道路線形里程':'OSM 道路里程',timeKind:timeSourceLabel(road)}:{dist:null,seconds:null,draft:true,distanceKind:'尚未取得道路里程',timeKind:'請先沿道路計算'};}
  function routeTextV14(r){if(!r)return '尚未選擇路線；請新增或恢復方案。';
    const road=roadPresentation(r);if(!road)return routeCaption(r)+'\n尚未取得道路走法；請先沿道路計算。';
    const rows=[routeCaption(r),(roadPreview?.status==='ready'?'未採用預覽':'道路結果')+'｜全程 '+kmLabel(road.distanceMeters)+'｜模型 '+minuteLabel(road.durationSeconds), '計算時間：'+road.computedAt];
    road.steps.forEach((s,i)=>rows.push((i+1)+'. '+s.instruction+'；接著約 '+Math.round(s.distanceMeters)+' m'));
    rows.push('道路模型沒有完整早尖峰車流、紅燈及兩段式待轉停等；請核對現場車道與轉向標誌。');
    for(const p of pointsOf(r))if(p.instruction||p.turnKind==='two_stage')rows.push('你的標註｜'+(p.road||p.label||'途經點')+'：'+(p.turnKind==='two_stage'?'兩段式待轉。':'')+(p.instruction||''));
    return rows.join('\n');
  }
  function drawMapV14(){
    clearLayers();clearDragLayers();const map=state.maps.leaflet,r=currentRoute();if(!map||!r)return;
    const main=roadPresentation(r),comparison=!isDrawing()&&(state.showAllRoutes||state.compareOverlay);
    if(comparison)for(const other of allRoutes().filter(x=>x.id!==r.id)){
      const road=baselineRoad(other);if(!road)continue;
      const line=L.polyline(road.path,{color:'#687584',weight:3,opacity:.45,interactive:true,bubblingMouseEvents:false,role:'comparison-route',routeId:other.id}).addTo(map);
      line.bindTooltip(node('span',null,'比較：'+routeCaption(other)));line.on('click',e=>{L.DomEvent.stopPropagation(e);selectRoute(other.id,{keepViewport:true,skipStation:true});});state.layers.push(line);
    }
    if(main){
      const line=L.polyline(main.path,{color:'#087df0',weight:7,opacity:1,interactive:true,bubblingMouseEvents:false,role:'active-road',routeId:r.id}).addTo(map);
      line.bindTooltip(node('span',null,roadPreview?.status==='ready'?'新道路預覽，確認後保存':'目前道路結果'));
      line.on('click',e=>{L.DomEvent.stopPropagation(e);selectLocation(productMapCoord(e.latlng),{label:'路線上的位置'});});state.layers.push(line);
    }
    const points=main?.points||controlsOf(r);
    for(const [i,p]of points.entries()){
      const label=i===0?'起':i===points.length-1?'終':'P'+(i+1);
      const marker=L.marker(p,{icon:L.divIcon({className:'waypoint-marker',html:label,iconSize:[28,28],iconAnchor:[14,14]}),draggable:false,zIndexOffset:1100,role:'waypoint',pointIndex:i}).addTo(map);
      marker.bindTooltip(node('span',null,label+' '+(p.road||p.label||'途經點')+(isDrawing()?' · 點選後可移動':'')));
      marker.on('click',()=>{if(isDrawing()&&!roadPreview?.result)chooseEdit('move',{index:i});else selectLocation(p,{viewOnly:true,label:label+' 道路位置'});});state.layers.push(marker);
    }
    drawTurnMarkers();
    if(clickEdit?.target){
      const at=candidateIndex(),p=roadPreview?.status==='ready'?roadPreview.result.points[at]:clickEdit.target;
      const marker=L.marker(p,{icon:L.divIcon({className:'candidate-marker',html:roadPreview?.status==='ready'?'新':'候',iconSize:[32,32],iconAnchor:[16,16]}),draggable:false,zIndexOffset:1300,role:'candidate'}).addTo(map);
      marker.on('click',()=>selectLocation(p,{viewOnly:true,label:'這次選定的道路位置'}));state.layers.push(marker);
    }
    drawPhotoMarkers();drawViewerMarker();
  }
  function drawTurnMarkers(){
    const r=currentRoute(),road=roadPresentation(r),map=state.maps.leaflet;if(!road||!map)return;
    road.steps.forEach((s,i)=>{
      if(['start','arrival','straight'].includes(s.turnKind))return;
      const badge=node('span','turn-badge');badge.append(node('b',null,iconFor(s.turnKind)),node('small',null,String(i+1)+(['left','uturn'].includes(s.turnKind)?'?':'')));
      const marker=L.marker(s.start,{icon:L.divIcon({className:'turn-marker',html:badge,iconSize:[38,40],iconAnchor:[19,20]}),draggable:false,zIndexOffset:800,role:'road-turn'}).addTo(map);
      marker.bindTooltip(node('span',null,(i+1)+'. '+s.instruction));marker.on('click',()=>wbSelectStep(i,'marker'));state.layers.push(marker);
    });
  }
  function fitRoute(){const r=currentRoute();if(!r||!state.maps.leaflet)return;const road=roadPresentation(r),pts=road?.path||controlsOf(r);if(pts.length)state.maps.leaflet.fitBounds(L.latLngBounds(pts),{padding:[40,40],maxZoom:16});}
  function pointLabel(p,i){return 'P'+(i+1)+' '+(i===0?'起點':i===controlsOf(currentRoute()).length-1?'終點':p.road||p.label||'途經點');}
  function fillOptions(id,rows,preferred){const el=$(id),keep=preferred??el.value;el.replaceChildren();for(const [value,label]of rows){const opt=node('option',null,label);opt.value=String(value);el.append(opt);}el.value=rows.some(x=>String(x[0])===String(keep))?String(keep):String(rows[0]?.[0]??'');}
  function renderEditorV13(){
    const r=currentRoute();if(!r)return;
    const d=clickEdit,p=roadPreview,pts=controlsOf(r),n=pts.length;
    $('mode-view').setAttribute('aria-pressed',!isDrawing());$('mode-draw').setAttribute('aria-pressed',isDrawing());
    $('show-all-routes').setAttribute('aria-pressed',!!state.showAllRoutes);
    $('start-adjust').textContent=isDrawing()?'點選調整中':'點選調整這條路';
    $('mode-note').textContent=isDrawing()?'指定調整範圍 → 點道路看街景 → 預覽 → 採用保存':'點地圖查看街景；路線不會改動';
    $('map-help').textContent=isDrawing()?'選左側調整方式，再點目標道路。候選點不會畫直線，按預覽才沿道路計算。':'點路口可看街景；路線與標記不可拖動。拖動地圖可平移。';
    $('click-controls').hidden=!isDrawing();
    fillOptions('insert-interval',pts.slice(1).map((x,i)=>[i+1,pointLabel(pts[i],i)+' → '+pointLabel(x,i+1)]),d?.kind==='insert'?d.index:null);
    fillOptions('move-index',pts.map((x,i)=>[i,pointLabel(x,i)]),d?.kind==='move'?d.index:null);
    fillOptions('replace-start',pts.slice(0,-1).map((x,i)=>[i,pointLabel(x,i)]),d?.kind==='replace'?d.start:null);
    fillOptions('replace-end',pts.slice(1).map((x,i)=>[i+1,pointLabel(x,i+1)]),d?.kind==='replace'?d.end:n-1);
    for(const id of ['choose-insert','choose-move','choose-replace'])$(id).disabled=n<2;
    $('edit-scope').textContent=!d||d.kind==='none'?'先選擇一種調整方式。':d.kind==='insert'?'加入 P'+d.index+' 與 P'+(d.index+1)+' 之間':d.kind==='move'?'移動 P'+(d.index+1)+'，取代原位置':d.kind==='replace'?'替換 P'+(d.start+1)+' → P'+(d.end+1)+'；將移除：'+(d.basePoints.slice(d.start+1,d.end).map((x,i)=>pointLabel(x,i+d.start+1)).join('、')||'無中間點') : d.kind==='delete'?'移除 P'+(d.index+1)+' 並重算全程':'重新計算完整道路';
    $('click-preview').disabled=!d||(['insert','move','replace'].includes(d.kind)&&!d.target)||p?.status==='loading';
    $('drag-review').hidden=!d&&!p;
    $('road-preview-status').textContent=p?.status==='loading'?'正在計算，地圖保留上次已採用道路…':p?.status==='ready'?'新道路預覽，尚未採用':p?.status==='error'?p.error:d?.target?'已選候選點，請按「預覽這個走法」':'選好調整範圍後，點目標道路。';
    $('road-preview-metrics').textContent=p?.result?'全程 '+kmLabel(p.result.distanceMeters)+' · 模型 '+minuteLabel(p.result.durationSeconds):'';
    const at=candidateIndex(),snap=p?.result&&at!==null?p.result.points[at]:null;
    $('drag-point-coord').textContent=snap?'實際採用 '+snap.lat.toFixed(6)+', '+snap.lng.toFixed(6)+'；離原選點 '+distance(d.target,snap).toFixed(1)+' m':d?.target?'候選點 '+d.target.lat.toFixed(6)+', '+d.target.lng.toFixed(6):'';
    $('drag-change-note').textContent='地圖、轉彎標記、完整文字、公里與時間均來自同一筆道路結果。確認前不覆蓋已保存方案。';
    $('road-preview-note').textContent='模型時間沒有完整尖峰車流、紅燈與兩段式待轉停等。';
    $('retry-road-route').hidden=p?.status!=='error';$('accept-drag').disabled=p?.status!=='ready';
    $('add-point').hidden=!isDrawing();$('add-viewpoint').textContent='預覽選點走法';$('add-point').textContent='預覽選點走法';
    for(const id of ['set-origin','set-destination'])$(id).hidden=!isDrawing();
  }
  function renderDragEdit(){renderEditor();}
  function renderWorkflow(){$('workflow-panel').hidden=true;renderEditor();}
  function renderResults(){
    renderResultsV9();const r=currentRoute();if(!r)return;const road=roadPresentation(r),preview=roadPreview?.status==='ready';
    $('distance-value').textContent=road?kmLabel(road.distanceMeters):'—';$('duration-value').textContent=road?minuteLabel(road.durationSeconds):'—';
    $('distance-note').textContent=road?(preview?'新預覽':'目前道路')+' · 起點至終點的'+(isHybridRoad(road)?'分段線形里程':'道路里程'):'尚未取得道路里程';
    $('duration-note').textContent=road?timeSourceLabel(road):'尚未取得估時';
    $('route-warning').textContent=road?(road.provider==='hybrid_osm_path_v22'?'部分路段在 OSM 標為 path；公眾通行不等於准許機車，須核對現場；該段估時是人工假設，不能與其他路線直接比快慢。':isHybridRoad(road)?'部分巷道在 OSM 標為步道／小徑；通行標誌待現場核對。時間混合兩項來源，不能與其他路線直接比快慢。':'整條路線取自道路計算；白牌禁行、禁轉與兩段式待轉仍需現場核對。'):'只有選點，尚未取得道路；不顯示自行連成的直線。';
    $('confirmed-progress').textContent=road?(preview?'待採用預覽':'目前道路結果')+' · '+road.steps.length+' 步 · '+road.computedAt:'請按沿街道重算';
    $('route-badges').replaceChildren(node('span','pill',preview?'新道路預覽':road?.provider==='hybrid_osm_path_v22'?'分段重建・混合粗估':isHybridRoad(road)?'分段重建・混合估時':road?'道路計算結果':'等待道路計算'));
    $('time-components').hidden=false;renderEditor();
  }
  function pointEditor(r,i,s){
    const box=node('div','point-actions'),move=node('button',null,'移動這個點'),insert=node('button',null,'在後方新增'),del=node('button','danger','移除並預覽');
    move.addEventListener('click',()=>chooseEdit('move',{index:i}));insert.disabled=i===r.points.length-1;insert.addEventListener('click',()=>chooseEdit('insert',{index:i+1}));del.disabled=i===0||i===r.points.length-1;del.addEventListener('click',()=>deletePoint(i));box.append(move,insert,del);
    const detail=node('details');detail.append(node('summary',null,'路口與停等標註'));
    for(const [key,label]of [['road','路名／地標'],['instruction','看到什麼、怎麼騎']]){const el=node('input');el.value=s[key]||'';el.placeholder=label;el.setAttribute('aria-label',label);el.addEventListener('change',()=>updatePointMeta(i,{[key]:validName(el.value)}));detail.append(el);}
    const signal=node('select');for(const [v,t]of [['unknown','號誌未知'],['yes','有號誌'],['no','無號誌']]){const opt=node('option',null,t);opt.value=v;signal.append(opt);}signal.value=s.signal||'unknown';signal.addEventListener('change',()=>updatePointMeta(i,{signal:signal.value}));detail.append(signal);
    const turn=node('select');for(const [v,t]of [['unknown','轉法待核對'],['straight','直行'],['right','右轉'],['left','左轉（待核對）'],['two_stage','兩段式待轉']]){const opt=node('option',null,t);opt.value=v;turn.append(opt);}turn.value=s.turnKind||'unknown';turn.addEventListener('change',()=>updatePointMeta(i,{turnKind:turn.value}));detail.append(turn);
    for(const [key,label,max]of [['redWaitSeconds','號誌停等秒數',600],['extraTurnSeconds','額外待轉秒數',1200]]){const el=node('input');el.type='number';el.min=0;el.max=max;el.placeholder=label;el.setAttribute('aria-label',label);el.value=s[key]??'';el.addEventListener('change',()=>{const v=el.value===''?null:Number(el.value);if(v===null||(Number.isFinite(v)&&v>=0&&v<=max))updatePointMeta(i,{[key]:v});else toast('停等秒數超出範圍。');});detail.append(el);}box.append(detail);return box;
  }
  function renderSteps(){
    const r=currentRoute(),road=roadPresentation(r),box=$('steps-list');box.replaceChildren();if(!r)return;
    $('step-count').textContent=road?road.steps.length+' 個道路步驟':'等待計算';
    if(!road)box.append(node('p','muted','先取得沿街道的完整路線，才會顯示怎麼騎。'));
    else road.steps.forEach((s,i)=>{const card=node('article','step-card'),b=node('button','step-select'),main=node('div','step-main');b.append(node('span','step-icon',iconFor(s.turnKind)),main);main.append(node('strong',null,(i+1)+'. '+s.road),node('span',null,s.instruction),node('span','muted','接著約 '+Math.round(s.distanceMeters)+' m'));b.addEventListener('click',()=>{selectLocation(s.start,{viewOnly:true,fromStep:true,label:(i+1)+'. '+s.instruction});});card.append(b);if(['left','uturn'].includes(s.turnKind))card.append(node('p','step-warning','左轉／迴轉與待轉規定，請查看現場標誌。'));box.append(card);});
    if(!roadPreview?.result){const details=node('details');details.append(node('summary',null,'途經點與路口標註（'+controlsOf(r).length+'）'));controlsOf(r).forEach((p,i)=>{const card=node('article','step-card'),b=node('button',null,pointLabel(p,i));b.addEventListener('click',()=>selectLocation(p,{viewOnly:true,label:pointLabel(p,i)}));card.append(b);if(r.custom)card.append(pointEditor(r,i,p));else{const move=node('button',null,'移動這個點');move.addEventListener('click',()=>chooseEdit('move',{index:i}));card.append(move);}details.append(card);});box.append(details);}
  }
  function renderRouteListV24(){renderRouteListV11();const rows=$('route-list').children;allRoutes().forEach((r,i)=>{const m=routeMetrics(r),card=rows[i]?.children[0];if(card?.children[1])card.children[1].textContent=baselineRoad(r)?(r.custom?'已保存道路':'原方案道路快照'):'尚未計算道路';card?.append(node('small','muted',kmLabel(m.dist)+' · '+minuteLabel(m.seconds)+' · '+m.timeKind));});uxRefresh();}
  function compareV14(){if(isDrawing()){cancelDragEdit(false);state.mode='view';render();}compareV11();const base=baselineRoad(currentRoute());allRoutes().forEach((r,i)=>{const road=baselineRoad(r);if(base&&road&&base.costing===road.costing){const delta=road.durationSeconds-base.durationSeconds;$('compare-body').children[i].children[3].textContent=(delta>=0?'+':'−')+Math.abs(delta).toFixed(0)+' 秒（同模式道路模型差）';}});}
  function toggleAllRoutes(){if(isDrawing()){toast('編輯時只顯示目前道路；請先取消調整並切到查看模式。');return;}state.showAllRoutes=!state.showAllRoutes;renderEditor();drawMap();}
  function bindDragUI(){
    for(const [id,fn]of Object.entries({'start-adjust':()=>startAdjust(),'start-from-a':()=>uxEditRoute('A'),'start-from-b':()=>uxEditRoute('B'),'accept-drag':confirmDragEdit,'cancel-drag':()=>cancelDragEdit(),'click-preview':()=>void requestRoadPreview(),'choose-insert':()=>chooseEdit('insert',{index:Number($('insert-interval').value)}),'choose-move':()=>chooseEdit('move',{index:Number($('move-index').value)}),'choose-replace':()=>chooseEdit('replace',{start:Number($('replace-start').value),end:Number($('replace-end').value)})}))$(id).addEventListener('click',fn);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('search-panel').hidden&&!stopLookup&&(clickEdit||roadPreview))cancelDragEdit();});
  }
  function bindRoutingUIV14(){state.showAllRoutes=false;state.dragRouteMode=false;$('road-profile').value='motorcycle';$('recompute-roads').addEventListener('click',recalculateRoads);$('retry-road-route').addEventListener('click',()=>void requestRoadPreview());$('road-profile').addEventListener('change',()=>{cancelDragEdit(false);render();toast('計算模式已變更，按沿街道重算取得新結果。');});}

  function updatePointMetaV14(index,patch){
    const r=currentRoute();if(!r?.custom||!r.points[index])return;
    const allowed=['road','label','instruction','turnKind','signal','redWaitSeconds','extraTurnSeconds','streetEvidence'];
    const safe={};for(const key of allowed)if(key in patch)safe[key]=patch[key];
    cancelDragEdit(false);pushUndo();Object.assign(r.points[index],safe,{confirmed:false});render();storeRoutes();
  }
  function removeRoute(id){if(id===state.routeId&&uxHasDraft()){toast('請先採用或取消目前修改，再刪除這條路線。');return false;}cancelDragEdit(false);removeRouteV12Legacy(id);}
  function restoreRoute(id){cancelDragEdit(false);restoreRouteV12Legacy(id);}
  function applyLibraryV24(payload){cancelDragEdit(false);applyLibraryV12Legacy(payload);}
  function modelEstimate(r){
    const road=roadPresentation(r);if(!road)return null;
    const v=getModelInputs(),speed=v.cruiseKph??25;
    const movement=road.distanceMeters/(speed/3.6), lights=v.signalCount==null||v.redWaitSeconds==null?null:v.signalCount*v.redWaitSeconds;
    const turns=v.twoStageTurns==null||v.twoStageSeconds==null?null:v.twoStageTurns*v.twoStageSeconds;
    const traffic=v.trafficDelayMinutes==null?null:v.trafficDelayMinutes*60;
    return {movingSeconds:movement,signalDelaySeconds:lights,twoStageDelaySeconds:turns,trafficDelaySeconds:traffic,totalSeconds:lights==null||turns==null||traffic==null?null:movement+lights+turns+traffic};
  }
  function renderModel(r){
    const box=$('time-components');box.replaceChildren();const m=modelEstimate(r);if(!m)return;
    for(const [label,value]of [['人工移動時間',m.movingSeconds],['號誌假設',m.signalDelaySeconds],['待轉假設',m.twoStageDelaySeconds],['壅塞假設',m.trafficDelaySeconds],['人工合計（另列）',m.totalSeconds]])box.append(node('span',null,label),node('b',null,value==null?'未知':minuteLabel(value)));
  }

  async function hydrateLibraryV24(){
    await hydrateLibraryV12Legacy();
    const r=currentRoute();if(r&&!baselineRoad(r)&&controlsOf(r).length>=2&&!roadPreview&&persistence.ready&&!persistence.blocked)void requestRoadPreview();
  }

  // Search is a separate viewing flow. A result never mutates route controls.
  let placeSearch={seq:0,controller:null,results:[],query:'',phase:'idle',message:''};
  function stopPlaceSearch(){placeSearch.seq++;placeSearch.controller?.abort();placeSearch.controller=null;}
  function closeSearch(){stopPlaceSearch();$('search-panel').hidden=true;$('map-search').setAttribute('aria-expanded','false');$('search-go').disabled=false;}
  function normalizePlaceText(s){return String(s||'').normalize('NFKC').toLowerCase().replace(/台/g,'臺').replace(/[\s,，\/／·・]/g,'');}
  function localPlaceResults(query){
    const q=normalizePlaceText(query),rows=[];
    for(const [p,name,aliases]of [[state.home,'住家',['家','住家','home']],[state.office,'公司',['公司','office','work']]]){
      if(coord(p)&&(aliases.includes(query.toLowerCase())||normalizePlaceText(p.address).includes(q)))rows.push({...coord(p),name,address:p.address||p.label||name,source:'已設定位置（本機）',kind:'saved',local:true,privateMatch:aliases.includes(query.toLowerCase())||normalizePlaceText(p.address)===q});
    }
    for(const s of stations){const name=s.road||s.title||s.id;if(coord(s)&&normalizePlaceText(name).includes(q))rows.push({...coord(s),name,address:s.title||s.road||s.id,source:'已收錄拍點（本機）',kind:'station',local:true});}
    for(const r of allRoutes())for(const p of controlsOf(r)){const name=p.road||p.label;if(name&&coord(p)&&normalizePlaceText(name).includes(q))rows.push({...coord(p),name,address:routeCaption(r)+' 的途經點',source:'路線資料（本機）',kind:'waypoint',local:true});}
    return uniquePlaces(rows).slice(0,6);
  }
  function placeKind(kind){return ({coordinate:'輸入座標',train_station:'火車站',train_station_building:'車站建物（非道路入口）',bus_stop:'公車站',footway:'步行通道（請核對行車入口）',steps:'樓梯（非行車道路）',pedestrian:'行人空間',path:'小徑',building:'建物',mall:'購物中心',platform:'月台',bicycle_rental:'公共自行車站',square:'廣場',map:'導覽圖',place:'地點',station:'車站／拍點',subway:'捷運',subway_entrance:'捷運出入口',museum:'博物館／紀念館',memorial:'紀念設施',attraction:'景點',residential:'道路／住宅',primary:'主要道路',secondary:'道路',tertiary:'道路',unclassified:'道路',service:'通道',restaurant:'餐廳',cafe:'咖啡店',bank:'銀行',saved:'已設定位置',waypoint:'路線途經點'})[kind]||kind||'地點';}
  function uniquePlaces(rows){const seen=new Set();return rows.filter(p=>{if(!coord(p)||!String(p.name||'').trim())return false;const key=p.lat.toFixed(5)+','+p.lng.toFixed(5)+':'+p.name+':'+(p.kind||'');if(seen.has(key))return false;seen.add(key);return true;});}
  function drawSearchResults(){
    if(window.innerWidth<=760)mobileTab('map');
    const box=$('search-results');box.replaceChildren();$('search-panel').hidden=false;$('map-search').setAttribute('aria-expanded','true');
    $('search-status').textContent=placeSearch.message;$('search-go').disabled=placeSearch.phase==='loading';
    for(const [i,p]of placeSearch.results.entries()){
      const b=node('button','place-result');b.type='button';b.setAttribute('aria-label',p.name+'，'+p.address);b.append(node('strong',null,p.name),node('span',null,p.address),node('small',null,placeKind(p.kind)+' · '+p.source));
      b.addEventListener('click',()=>selectPlaceResult(i));
      b.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const next=i+(e.key==='ArrowDown'?1:-1);(box.children[next]||$('map-search')).focus?.();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();closeSearch();$('map-search').focus?.();}});box.append(b);
    }
    $('search-retry').hidden=placeSearch.phase!=='error';searchRefinementV28(box,$('map-search').value,placeSearch.results,'map-search',placeSearch.phase==='ready');
  }
  function selectPlaceResult(index){
    const p=placeSearch.results[index];if(!p)return;
    closeSearch();$('selection-insert').hidden=true;
    selectLocation(p,{viewOnly:true,label:p.name});panTo(p);
    $('selection-source').textContent=p.source+' · '+p.address+'；僅查看，尚未改動路線。';
    if(window.innerWidth<=760)mobileTab('map');
    status('已定位 '+p.name+'。可看街景，再設起點、終點或加入途經點。');
  }
  async function search(){
    const query=$('map-search').value.trim();stopPlaceSearch();const seq=placeSearch.seq;
    placeSearch={...placeSearch,query,results:[],phase:'idle',message:''};
    if(!query){placeSearch.message='輸入地名、道路、地址或「緯度,經度」，再按搜尋。';drawSearchResults();return;}
    const coordinate=parseCoord(query);
    if(coordinate){placeSearch.results=[{...coordinate,name:'座標位置',address:query,source:'輸入座標（本機）'}];selectPlaceResult(0);return;}
    if(query.length<2||query.length>160){placeSearch.phase='error';placeSearch.message='請輸入 2～160 個字的地名或地址。';drawSearchResults();return;}
    const local=localPlaceResults(query);placeSearch.results=local;
    if(local.some(p=>p.privateMatch)){placeSearch.phase='ready';placeSearch.message='找到已設定位置；這次未將地址傳送給搜尋服務。';drawSearchResults();return;}
    if(!['http:','https:'].includes(location.protocol)||typeof window.fetch!=='function'){placeSearch.phase='error';placeSearch.message='請從工作台網址使用地點搜尋。';drawSearchResults();return;}
    if(!ensureProductConsent()){placeSearch.phase='idle';placeSearch.message='同意後再按搜尋。';drawSearchResults();return;}const controller=new AbortController();placeSearch.controller=controller;if(!ensureProductConsent())return;placeSearch.phase='loading';placeSearch.message='正在搜尋「'+query+'」…';drawSearchResults();
    try{
      let token=persistence.csrf;
      if(!token){const r=await window.fetch(data.publicEdition?'/api/session':'/api/routes',{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error('本機服務尚未就緒。');token=(await r.json()).csrf;}
      if(seq!==placeSearch.seq)return;
      const response=await window.fetch('/api/place-search',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':token,'X-Planner-Consent':productConsent()?'yes':'no'},body:JSON.stringify({query,scope:'world'}),signal:controller.signal});
      const result=await response.json();if(seq!==placeSearch.seq)return;
      if(!response.ok)throw new Error(result.message||'地點搜尋暫時無法使用。');
      if(!Array.isArray(result.results))throw new Error('搜尋服務回應不完整。');
      placeSearch.results=rankPlaces(uniquePlaces([...local,...result.results.map(p=>({...p,...coord(p)}))]),query).slice(0,12);placeSearch.phase='ready';
      placeSearch.message=placeSearch.results.length?'找到 '+placeSearch.results.length+' 個位置；請核對名稱與地址，再點選。':'找不到「'+query+'」。試試當地名稱＋城市、完整地址或座標；部分地點未收錄，也可直接點地圖。';
    }catch(e){if(seq!==placeSearch.seq||e.name==='AbortError')return;placeSearch.phase='error';placeSearch.message=cleanError(e)+(local.length?'；仍可選下方本機位置。':' 請稍後重試，或直接點地圖。');}
    if(seq===placeSearch.seq){placeSearch.controller=null;drawSearchResults();}
  }
  function searchKey(e){if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();void search();}else if(e.key==='ArrowDown'&&!$('search-panel').hidden){e.preventDefault();$('search-results').children[0]?.focus?.();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();closeSearch();}}
  function bindPlaceSearch(){
    $('search-close').addEventListener('click',closeSearch);$('search-retry').addEventListener('click',()=>void search());
    $('map-search').addEventListener('input',()=>{stopPlaceSearch();placeSearch.results=[];placeSearch.phase='idle';$('search-panel').hidden=true;$('map-search').setAttribute('aria-expanded','false');$('search-go').disabled=false;});
    $('selection-apply').addEventListener('click',()=>void insertSelection());$('selection-cancel').addEventListener('click',()=>{$('selection-insert').hidden=true;});
    $('use-edit-target').addEventListener('click',()=>{const p=coord(state.selection),label=state.selection?.label;if(!p||!clickEdit)return;selectLocation(p,{label});void requestRoadPreview();});
    for(const [id,q]of [['search-home','住家'],['search-office','公司']])$(id).addEventListener('click',()=>{$('map-search').value=q;void search();});
  }
  function renderEditorV14(){
    renderEditorV13();const pts=currentRoute()?controlsOf(currentRoute()):[],has=!!coord(state.selection);
    for(const id of ['set-origin','set-destination','add-point']){$(id).hidden=!has;$(id).disabled=pts.length<2;}
    $('add-point').textContent='加入途經點…';$('add-viewpoint').textContent='加入途經點…';$('add-viewpoint').disabled=!has||pts.length<2;
    const canUse=has&&clickEdit&&['insert','move','replace'].includes(clickEdit.kind);
    $('use-edit-target').hidden=!canUse;$('use-edit-target').textContent='用於這次調整並預覽';
    fillOptions('selection-interval',pts.slice(1).map((p,i)=>[i+1,pointLabel(pts[i],i)+' → '+pointLabel(p,i+1)]));
    $('map-help').textContent=isDrawing()?'選道路或搜尋位置 → 看街景 → 預覽 → 採用並保存。預覽前不改動已保存方案。':'搜尋地名、地址或點路口看街景；選點後可設為起終點或加入途經點。';
  }
  function selectLocationV16(p,options={}){
    $('selection-insert').hidden=true;selectLocationV13(p,options);
    if(clickEdit?.target&&!options.viewOnly&&!options.fromStep)clickEdit.targetLabel=options.label||'新選道路位置';
  }
  function draftControlsV14(){const pts=draftControlsV13(),at=candidateIndex();if(at!==null&&pts[at]&&clickEdit?.targetLabel){pts[at].label=clickEdit.targetLabel;pts[at].road=clickEdit.targetLabel;}return pts;}
  function addSelectedPointV14(){
    if(!currentRoute()||controlsOf(currentRoute()).length<2){toast('先從左側新增或恢復一條路線。');return;}
    if(!coord(state.selection)){toast('請先搜尋或點地圖選位置。');return;}
    renderEditor();$('selection-insert').hidden=false;
    const n=controlsOf(currentRoute()).length;const index=clickEdit?.kind==='insert'?clickEdit.index:Math.max(1,n-1);$('selection-interval').value=String(index);
    $('selection-interval').focus?.();
    if(window.innerWidth<=760)mobileTab('map');
  }
  async function insertSelectionV14(){
    const p=coord(state.selection),label=state.selection?.label,index=Number($('selection-interval').value);if(!p)return;
    if(chooseEdit('insert',{index})){selectLocation(p,{label});$('selection-insert').hidden=true;await requestRoadPreview();}
  }
  async function setEndpointV14(kind){
    const p=coord(state.selection),label=state.selection?.label;if(!p||!currentRoute())return;
    if(chooseEdit('move',{index:kind==='home'?0:controlsOf(currentRoute()).length-1})){selectLocation(p,{label});await requestRoadPreview();}
  }

  // v15: route stops are one ordered, uncommitted control-point transaction.
  let stopLookup=null,stopLookupSeq=0,stopLookupController=null,stopDrag=null,stopPanelKey='';
  const stopName=(p,i,n)=>p?.label||p?.road||(i===0?'起點':i===n-1?'終點':'途經點 '+i);
  const stopRole=(i,n)=>i===0?'起點':i===n-1?'終點':'P'+(i+1)+' 途經點';
  function planningControlsV16(){
    const r=currentRoute();if(!r)return [];
    if(roadPreview?.routeId===r.id&&roadPreview.status==='ready')return roadPreview.result.points.map((p,i)=>({...roadPreview.points[i],...p}));
    if(clickEdit?.routeId===r.id){if(clickEdit.kind==='controls')return clone(clickEdit.proposedPoints);try{return draftControlsV14();}catch(_){}}
    return clone(controlsOf(r));
  }
  function planningSignature(){const r=currentRoute();return JSON.stringify([r?.id,r?fingerprint(r):null,clickEdit?{kind:clickEdit.kind,base:clickEdit.basePoints,proposed:clickEdit.proposedPoints,index:clickEdit.index,start:clickEdit.start,end:clickEdit.end,target:clickEdit.target}:null]);}
  function resetStopLookup(){stopLookupSeq++;stopLookupController?.abort();stopLookupController=null;stopLookup=null;stopDrag=null;stopPanelKey='';}
  function cancelDragEditV16(redraw=true){resetStopLookup();cancelDragEditV14(redraw);}
  function draftControlsV16(){return clickEdit?.kind==='controls'?clone(clickEdit.proposedPoints):draftControlsV14();}
  function candidateIndex(){return clickEdit?.kind==='controls'?(Number.isInteger(clickEdit.focusIndex)?clickEdit.focusIndex:null):candidateIndexV14();}
  function clearPointEvidence(p){const next={...p,confirmed:false,turnKind:'unknown',signal:'unknown',redWaitSeconds:null,extraTurnSeconds:null,streetEvidence:'unknown'};next.instruction='';delete next.shapeIndex;return next;}
  function adjustedEvidence(points,before){
    const key=p=>p?Number(p.lat).toFixed(7)+','+Number(p.lng).toFixed(7):'none';
    return points.map((p,i)=>{const old=before.findIndex(q=>key(q)===key(p));const unchanged=old>=0&&key(points[i-1])===key(before[old-1])&&key(points[i+1])===key(before[old+1]);const next=unchanged?{...p}:clearPointEvidence(p);if(i===0)next.turnKind='start';if(i===points.length-1)next.turnKind='arrival';return next;});
  }
  async function stageStopControlsV16(points,focusIndex=null,reason='已調整停靠點'){
    const r=currentRoute();if(!r)return false;
    if(points.length<2||points.length>50||points.some(p=>!coord(p))){toast('路線需有 2～50 個有效位置。');render();return false;}
    if(points.some((p,i)=>i&&distance(points[i-1],p)<1)){toast('相鄰兩點位置相同，請移除重複點或選其他位置。');render();return false;}
    const before=planningControls(),proposed=adjustedEvidence(points,before),target=Number.isInteger(focusIndex)?coord(proposed[focusIndex]):null;
    pendingClear();resetStopLookup();closeSearch();state.mode='draw';state.compareOverlay=false;state.showAllRoutes=false;state.dragRouteMode=false;
    clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'controls',basePoints:clone(controlsOf(r)),proposedPoints:proposed,focusIndex,target,reason};
    if(target)selectLocation(target,{viewOnly:true,label:stopName(proposed[focusIndex],focusIndex,proposed.length)});
    render();await requestRoadPreview();return roadPreview?.status==='ready';
  }
  async function moveStop(index,p,label){const pts=planningControls();if(!Number.isInteger(index)||!pts[index]||!coord(p))return false;pts[index]=clearPointEvidence({...pts[index],...coord(p),label:label||'拖動後的位置',road:label||'拖動後的位置'});return stageStopControls(pts,index,'已移動 '+stopRole(index,pts.length));}
  async function reorderStop(from,to,signature=null){const pts=planningControls();if(signature&&signature!==planningSignature())return false;if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=pts.length||to>=pts.length||from===to)return false;const [p]=pts.splice(from,1);pts.splice(to,0,p);return stageStopControls(pts,to,'已調整停靠順序');}
  async function removeStop(index){const pts=planningControls();if(index<=0||index>=pts.length-1){toast('起點與終點請搜尋替換，路線至少保留兩點。');return false;}pts.splice(index,1);return stageStopControls(pts,null,'已移除途經點');}
  function revealStops(){if(ux.ready){uxSetTab('edit');ux.expanded[state.routeId]=true;}state.layout.collapsed=false;applyLayout();saveLayout();if(window.innerWidth<=760)mobileTab('route');$('stop-planner').scrollIntoView?.({block:'nearest'});}
  function beginStopLookup(index,kind='replace',query=''){
    const pts=planningControls();if(!currentRoute()||pts.length<2){toast('先選擇或新增路線。');return false;}
    if(kind==='insert'&&pts.length>=50){toast('每條路線最多 50 個停靠點。');return false;}
    resetStopLookup();stopLookup={routeId:currentRoute().id,signature:planningSignature(),index,kind,query,phase:'idle',results:[],chosen:null,message:'輸入地名／地址後按搜尋；點結果先看街景，再使用這個位置。'};
    revealStops();renderStops();$('stop-query').focus?.();return true;
  }
  function lookupValid(){return stopLookup&&stopLookup.routeId===currentRoute()?.id&&stopLookup.signature===planningSignature();}
  async function searchRoutePoint(index,query,kind='replace'){
    if(!lookupValid()||stopLookup.index!==index||stopLookup.kind!==kind){if(!beginStopLookup(index,kind,query))return;}
    query=String(query||'').trim();stopLookup.query=query;stopLookup.chosen=null;stopLookup.results=[];stopLookupSeq++;stopLookupController?.abort();const seq=stopLookupSeq;
    if(!query){stopLookup.message='請輸入地名、地址或座標。';stopLookup.phase='idle';renderStops();return;}
    const p=parseCoord(query),local=p?[{...p,name:'座標位置',address:query,source:'輸入座標（本機）',kind:'place'}]:localPlaceResults(query);
    stopLookup.results=local;
    if(p||local.some(x=>x.privateMatch)){stopLookup.phase='ready';stopLookup.message='選擇下方位置，再確認使用。';renderStops();return;}
    if(query.length<2||query.length>160){stopLookup.phase='error';stopLookup.message='請輸入 2～160 個字。';renderStops();return;}
    if(!['http:','https:'].includes(location.protocol)||typeof window.fetch!=='function'){stopLookup.phase='error';stopLookup.message='請使用工作台網址搜尋。';renderStops();return;}
    if(!ensureProductConsent())return;const controller=new AbortController();stopLookupController=controller;stopLookup.phase='loading';stopLookup.message='正在搜尋「'+query+'」…';renderStops();
    try{
      let token=persistence.csrf;if(!token){const h=await window.fetch(data.publicEdition?'/api/session':'/api/routes',{cache:'no-store',signal:controller.signal});if(!h.ok)throw new Error('本機服務尚未就緒。');token=(await h.json()).csrf;}
      if(seq!==stopLookupSeq||!lookupValid())return;
      const res=await window.fetch('/api/place-search',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':token,'X-Planner-Consent':productConsent()?'yes':'no'},body:JSON.stringify({query,scope:'world'}),signal:controller.signal});const answer=await res.json();
      if(seq!==stopLookupSeq||!lookupValid())return;
      if(!res.ok)throw new Error(answer.message||'搜尋服務暫時無法使用。');if(!Array.isArray(answer.results))throw new Error('搜尋結果格式不完整。');
      stopLookup.results=rankPlaces(uniquePlaces([...local,...answer.results]),query).slice(0,12);stopLookup.phase='ready';stopLookup.message=stopLookup.results.length?'請核對地址與類別，點選結果查看街景。':'找不到位置。試試當地名稱＋城市、完整地址或座標，或按「使用地圖選點」。';
    }catch(e){if(seq!==stopLookupSeq||!lookupValid()||e.name==='AbortError')return;stopLookup.phase='error';stopLookup.message=cleanError(e)+' 可再搜尋或使用地圖選點。';}
    if(seq===stopLookupSeq&&lookupValid()){stopLookupController=null;renderStops();}
  }
  function chooseStopResult(index){if(!lookupValid())return;const p=stopLookup.results[index];if(!coord(p))return;stopLookup.chosen=clone(p);selectLocation(p,{viewOnly:true,label:p.name});panTo(p);renderStops();if(window.innerWidth<=760)mobileTab('street');}
  async function applyStopResult(){
    if(!lookupValid()||!coord(stopLookup.chosen)){toast('先點選搜尋結果，或使用地圖選點。');return false;}
    const {kind,index,chosen}=stopLookup,pts=planningControls(),p=clearPointEvidence({...coord(chosen),label:chosen.name,road:chosen.name});
    if(kind==='insert')pts.splice(index,0,p);else pts[index]=p;
    return stageStopControls(pts,index,(kind==='insert'?'已新增':'已替換')+' '+chosen.name);
  }
  function useMapForStop(){if(!lookupValid()||!coord(state.selection)){toast('先點地圖選擇道路入口。');return;}stopLookup.chosen={...coord(state.selection),name:state.selection.label||'地圖選定位置',address:'地圖選點',source:'本機選點'};renderStops();revealStops();}
  function stopQueryInput(){if(!stopLookup)return;stopLookupSeq++;stopLookupController?.abort();stopLookupController=null;stopLookup.query=$('stop-query').value;stopLookup.phase='idle';stopLookup.results=[];stopLookup.chosen=null;stopLookup.message='輸入完成後按搜尋；文字本身不會修改路線。';renderStopLookup();}
  function renderStopLookup(){
    $('stop-street-confirm').hidden=!stopLookup?.chosen;$('stop-street-confirm').textContent=stopLookup?.chosen?'使用已選：'+stopLookup.chosen.name:'使用已選位置並預覽';$('stop-use-visible').hidden=!stopLookup;$('add-viewpoint').textContent=stopLookup?'用作待選停靠點':'加入途經點…';if(stopLookup)$('accept-drag').disabled=true;
    const box=$('stop-lookup');box.hidden=!stopLookup;if(!stopLookup)return;
    const pts=planningControls(),d=stopLookup;$('stop-lookup-title').textContent=d.kind==='insert'?'新增途經點：放在 '+stopRole(d.index-1,pts.length)+' 與 '+stopRole(d.index,pts.length)+' 之間':'搜尋替換 '+stopRole(d.index,pts.length);
    if($('stop-query').value!==d.query)$('stop-query').value=d.query;
    $('stop-search-status').textContent=d.message;$('stop-search-go').disabled=d.phase==='loading';
    const rows=$('stop-search-results');rows.replaceChildren();d.results.forEach((p,i)=>{const b=node('button','stop-result'+(d.chosen&&distance(d.chosen,p)<1&&d.chosen.name===p.name?' selected':''));b.append(node('strong',null,p.name),node('span',null,p.address),node('small',null,placeKind(p.kind)+' · '+p.source));b.setAttribute('aria-label',p.name+' '+p.address+'，查看街景');b.addEventListener('click',()=>chooseStopResult(i));rows.append(b);});
    searchRefinementV28(rows,d.query,d.results,'stop-query',d.phase==='ready'&&!d.chosen);
    $('stop-picked').textContent=d.chosen?'已選：'+d.chosen.name+' · '+d.chosen.lat.toFixed(6)+', '+d.chosen.lng.toFixed(6)+'。請核對道路入口。':'尚未選取位置；已保存路線不會改動。';$('stop-use-result').disabled=!d.chosen;$('stop-map-selection').disabled=!coord(state.selection);
  }
  function renderStops(){
    const pts=planningControls(),key=JSON.stringify([currentRoute()?.id,pts.map(p=>[p.label,p.road])]);
    if(key!==stopPanelKey){stopPanelKey=key;const list=$('route-stops');list.replaceChildren();
      if(!pts.length)list.append(node('p','muted','先選擇或新增一條路線。'));
      pts.forEach((p,i)=>{
        const row=node('div','route-stop-row');row.dataset.index=String(i);const role=stopRole(i,pts.length),head=node('div','stop-row-heading'),handle=node('button','stop-handle','⠿');handle.draggable=true;handle.title='拖曳調整順序，也可用上下按鈕';handle.setAttribute('aria-label','拖曳 '+role+' 調整順序');head.append(handle,node('b',null,role));
        const up=node('button','stop-order','↑'),down=node('button','stop-order','↓');up.disabled=i===0;down.disabled=i===pts.length-1;up.setAttribute('aria-label',role+' 往前移');down.setAttribute('aria-label',role+' 往後移');up.addEventListener('click',()=>void reorderStop(i,i-1));down.addEventListener('click',()=>void reorderStop(i,i+1));head.append(up,down);
        if(i>0&&i<pts.length-1){const del=node('button','stop-order danger','×');del.setAttribute('aria-label','移除 '+role);del.addEventListener('click',()=>void removeStop(i));head.append(del);}
        const field=node('input');field.value=stopName(p,i,pts.length);field.placeholder='搜尋地名或地址';field.setAttribute('aria-label',role+' 地名或地址');field.maxLength=160;
        const searchButton=node('button','stop-search','搜尋');searchButton.addEventListener('click',()=>void searchRoutePoint(i,field.value));field.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();void searchRoutePoint(i,field.value);}});
        const view=node('button','stop-view','街景');view.addEventListener('click',()=>{const now=planningControls()[i];if(!now)return;selectLocation(now,{viewOnly:true,label:role+' '+stopName(now,i,pts.length)});if(window.innerWidth<=760)mobileTab('street');});
        const inputRow=node('div','stop-input-row');inputRow.append(field,searchButton,view);row.append(head,inputRow);
        handle.addEventListener('dragstart',e=>{stopDrag={from:i,signature:planningSignature()};e.dataTransfer?.setData('text/plain','route-stop');if(e.dataTransfer)e.dataTransfer.effectAllowed='move';});handle.addEventListener('dragend',()=>{stopDrag=null;});
        row.addEventListener('dragover',e=>{if(stopDrag){e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';row.classList.add('drop-target');}});row.addEventListener('dragleave',()=>row.classList.remove('drop-target'));
        row.addEventListener('drop',e=>{e.preventDefault();row.classList.remove('drop-target');const drag=stopDrag;stopDrag=null;if(drag)void reorderStop(drag.from,i,drag.signature);});
        list.append(row);
      });
      fillOptions('stop-add-interval',pts.slice(1).map((p,i)=>[i+1,stopRole(i,pts.length)+' '+stopName(pts[i],i,pts.length)+' → '+stopRole(i+1,pts.length)+' '+stopName(p,i+1,pts.length)]),pts.length-1);
    }
    $('stop-add').disabled=pts.length<2||pts.length>=50;$('stop-swap').disabled=pts.length<2;
    const pending=!!clickEdit,status=roadPreview?.status;
    $('stop-state').textContent=status==='loading'?'正在沿道路重算；目前藍線是已保存的走法。':status==='error'?'尚未計算成功：'+roadPreview.error+' 可拖動點到道路入口後再試。':status==='ready'?'新路線預覽，尚未保存。':pending?'停靠點草稿，尚未保存。':'目前已保存的停靠順序';
    $('stop-accept').disabled=status!=='ready'||!!stopLookup;$('stop-cancel').disabled=!pending&&!stopLookup;
    const road=roadPresentation(currentRoute());$('stop-route-metrics').textContent=road?kmLabel(road.distanceMeters)+' · '+(isHybridRoad(road)?'混合粗估 ':'模型 ')+minuteLabel(road.durationSeconds)+(status==='ready'?'（新預覽）':pending?'（已保存道路）':''):'';
    renderStopLookup();uxRefresh();
  }
  function renderEndpoints(){renderEndpointsV14();renderStops();}
  function renderEditorV16(){renderEditorV14();const editingPoints=planningControls();fillOptions('selection-interval',editingPoints.slice(1).map((p,i)=>[i+1,stopRole(i,editingPoints.length)+' '+stopName(editingPoints[i],i,editingPoints.length)+' → '+stopRole(i+1,editingPoints.length)+' '+stopName(p,i+1,editingPoints.length)]));if(clickEdit?.kind==='controls'){
    $('edit-scope').textContent=clickEdit.reason+'；起終點與途經順序全部依左側草稿重算。';
    $('road-preview-status').textContent=roadPreview?.status==='loading'?'正在沿道路重算…':roadPreview?.status==='ready'?'新道路預覽，按採用並保存才更新。':roadPreview?.status==='error'?roadPreview.error+' 請把地圖上的草稿點移到道路入口。':'停靠點草稿等待重算';
  }
    for(const id of ['choose-insert','choose-move','choose-replace']){$(id).disabled=clickEdit?.kind==='controls';$(id).title=clickEdit?.kind==='controls'?'先採用或取消上方停靠點草稿，再用進階工具':'';}
    $('map-help').textContent='拖動「起／終／P」標記可改位置；左側可搜尋、加點與排序。整條沿道路重算，確認後才保存。';
    if(stopLookup)$('accept-drag').disabled=true;
    $('stop-use-visible').hidden=!stopLookup;$('stop-street-confirm').hidden=!stopLookup?.chosen;$('stop-street-confirm').textContent=stopLookup?.chosen?'使用已選：'+stopLookup.chosen.name:'使用已選位置並預覽';$('add-viewpoint').textContent=stopLookup?'用作待選停靠點':'加入途經點…';renderStops();
  }
  function editEndpoints(){revealStops();$('route-stops').querySelector?.('input')?.focus();toast('在此路線的起點／終點欄位輸入地名，再從搜尋結果選取。');}
  async function setEndpoint(kind){const p=coord(state.selection),pts=planningControls();if(!p||!pts.length)return;return moveStop(kind==='home'?0:pts.length-1,p,state.selection.label);}
  async function insertSelection(){const pts=planningControls(),index=Number($('selection-interval').value),p=coord(state.selection);if(!p||index<1||index>=pts.length)return;pts.splice(index,0,clearPointEvidence({...p,label:state.selection.label,road:state.selection.label}));return stageStopControls(pts,index,'已加入地圖選點');}
  function bindStops(){
    $('stop-add').addEventListener('click',()=>beginStopLookup(Number($('stop-add-interval').value),'insert',''));
    $('stop-swap').addEventListener('click',()=>{const pts=planningControls().reverse();void stageStopControls(pts,null,'已反轉起終點與途經順序');});
    $('stop-search-go').addEventListener('click',()=>{if(stopLookup)void searchRoutePoint(stopLookup.index,$('stop-query').value,stopLookup.kind);});
    $('stop-query').addEventListener('input',stopQueryInput);$('stop-query').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();if(stopLookup)void searchRoutePoint(stopLookup.index,e.target.value,stopLookup.kind);}if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();resetStopLookup();render();}});
    $('stop-close-search').addEventListener('click',()=>{resetStopLookup();render();});$('stop-use-result').addEventListener('click',()=>void applyStopResult());$('stop-map-selection').addEventListener('click',useMapForStop);$('stop-use-visible').addEventListener('click',useMapForStop);
    $('stop-street-confirm').addEventListener('click',()=>void applyStopResult());
    $('stop-accept').addEventListener('click',()=>{if(!stopLookup)confirmDragEdit();});$('stop-cancel').addEventListener('click',()=>cancelDragEdit());
  }
  function drawMapV16(){
    clearLayers();clearDragLayers();const map=state.maps.leaflet,r=currentRoute();if(!map||!r)return;
    const main=roadPresentation(r),comparison=!isDrawing()&&(state.showAllRoutes||state.compareOverlay);
    if(comparison)for(const other of allRoutes().filter(x=>x.id!==r.id)){const road=baselineRoad(other);if(!road)continue;const line=L.polyline(road.path,{color:'#687584',weight:3,opacity:.45,bubblingMouseEvents:false,role:'comparison-route',routeId:other.id}).addTo(map);line.on('click',e=>{L.DomEvent.stopPropagation(e);selectRoute(other.id,{keepViewport:true,skipStation:true});});state.layers.push(line);}
    if(main){const line=L.polyline(main.path,{color:'#087df0',weight:7,opacity:1,bubblingMouseEvents:false,role:'active-road',routeId:r.id}).addTo(map);line.bindTooltip(node('span',null,roadPreview?.status==='ready'?'新道路預覽，尚未保存':'已保存道路'));line.on('click',e=>{L.DomEvent.stopPropagation(e);selectLocation(productMapCoord(e.latlng),{viewOnly:!['insert','move','replace'].includes(clickEdit?.kind),label:'道路上的位置'});});state.layers.push(line);}
    const controls=planningControls(),draft=clickEdit?.kind==='controls'&&roadPreview?.status!=='ready';
    const pts=clickEdit?.kind==='controls'?controls:main?.points||controls;
    pts.forEach((p,i)=>{const label=i===0?'起':i===pts.length-1?'終':'P'+(i+1),marker=L.marker(p,{icon:L.divIcon({className:'waypoint-marker'+(draft?' stop-draft-marker':''),html:label,iconSize:[32,32],iconAnchor:[16,16]}),draggable:true,zIndexOffset:1100,role:'waypoint',pointIndex:i}).addTo(map);let dragContext=null;
      marker.bindTooltip(node('span',null,label+' '+stopName(controls[i]||p,i,pts.length)+(draft?'（草稿，尚未接路）':'')+'；可拖曳改位置'));
      marker.on('click',()=>selectLocation(p,{viewOnly:true,label:stopRole(i,pts.length)+' '+stopName(controls[i]||p,i,pts.length)}));
      marker.on('dragstart',()=>{dragContext={points:planningControls(),routeId:r.id,fingerprint:fingerprint(r)};if(roadPreview?.status==='loading')pendingClear();resetStopLookup();status('拖動停靠點；放開後整條沿道路重算。');});
      marker.on('dragend',()=>{const p=productMapCoord(marker.getLatLng());if(!p||!dragContext||currentRoute()?.id!==dragContext.routeId||fingerprint(currentRoute())!==dragContext.fingerprint){render();return;}const next=dragContext.points;next[i]=clearPointEvidence({...next[i],...p,label:'拖動後的位置',road:'拖動後的位置'});void stageStopControls(next,i,'已拖動 '+stopRole(i,next.length));});state.layers.push(marker);
    });
    drawTurnMarkers();
    if(clickEdit?.target&&clickEdit.kind!=='controls'){const at=candidateIndex(),p=roadPreview?.status==='ready'?roadPreview.result.points[at]:clickEdit.target;const marker=L.marker(p,{icon:L.divIcon({className:'candidate-marker',html:'候',iconSize:[32,32],iconAnchor:[16,16]}),draggable:false,zIndexOffset:1300,role:'candidate'}).addTo(map);state.layers.push(marker);}
    drawPhotoMarkers();drawViewerMarker();
  }

  function confirmDragEditV16(){if(stopLookup){toast('先使用這個位置，或關閉尚未完成的搜尋，再採用路線。');return;}confirmDragEditV14();}

  function addSelectedPoint(){const pts=planningControls();if(pts.length<2||!coord(state.selection)){toast('先選路線，再搜尋或點地圖選位置。');return;}renderEditor();$('selection-insert').hidden=false;$('selection-interval').value=String(pts.length-1);$('selection-interval').focus?.();if(window.innerWidth<=760)mobileTab('map');}

  function routeWithResultV16(base,result,draft){const next=routeWithResultV14(base,result,draft);next.points=exportRouteV11(next).points;return next;}
  function recalculateRoads(){return requestRoadPreview();}
  function bindRoutingUI(){state.showAllRoutes=false;state.dragRouteMode=false;$('road-profile').value='motorcycle';$('recompute-roads').addEventListener('click',()=>void recalculateRoads());$('retry-road-route').addEventListener('click',()=>void requestRoadPreview());$('road-profile').addEventListener('change',()=>{void requestRoadPreview();});}
  function routeText(r){if(!r)return '尚未選擇路線；請新增或恢復方案。';
    const road=roadPresentation(r);if(!road)return routeCaption(r)+'\n尚未取得道路走法；請先沿道路計算。';
    const preview=roadPreview?.routeId===r.id&&roadPreview.status==='ready';
    const rows=[routeCaption(r),(preview?'未採用預覽':'道路結果')+'｜全程 '+kmLabel(road.distanceMeters)+'｜'+timeSourceLabel(road)+' '+minuteLabel(road.durationSeconds),'計算時間：'+road.computedAt];
    road.steps.forEach((s,i)=>rows.push((i+1)+'. '+s.instruction+'；接著約 '+Math.round(s.distanceMeters)+' m'));
    rows.push(isHybridRoad(road)?road.timeNote+(road.provider==='hybrid_osm_path_v22'?' 部分路段在 OSM 標為 path；機車通行須依現場標誌核對。':' 部分巷道在 OSM 標為步道／小徑，機車通行須依現場標誌核對。'):'道路模型沒有完整早尖峰車流、紅燈及兩段式待轉停等；請核對現場車道與轉向標誌。');
    for(const p of (preview?planningControls():pointsOf(r)))if(p.instruction||p.turnKind==='two_stage')rows.push('你的標註｜'+(p.road||p.label||'途經點')+'：'+(p.turnKind==='two_stage'?'兩段式待轉。':'')+(p.instruction||''));
    return rows.join('\n');
  }

  function protectStopDraft(){if(clickEdit?.kind!=='controls')return false;toast('目前有未保存的停靠點調整；請先採用並保存，或取消草稿，再使用此工具。');revealStops();return true;}
  function chooseEditV16(kind,options={}){return protectStopDraft()?false:chooseEditV14(kind,options);}
  function startAdjustV16(id){if((!id||id===state.routeId)&&protectStopDraft())return;return startAdjustV14(id);}
  function compareV15(){if(protectStopDraft())return;return compareV14();}
  function updatePointMeta(index,patch){if(protectStopDraft())return;return updatePointMetaV14(index,patch);}

  // v16: always-visible copyable journey and explicit comparison evidence.
  let comparisonBase=null;
  const secondsText=s=>Number.isFinite(s)?Math.floor(Math.round(s)/60)+' 分 '+(Math.round(s)%60)+' 秒':'尚未取得';
  function roadStateV16(r){const road=roadPresentation(r),preview=!!r&&r.id===roadPreview?.routeId&&roadPreview.status==='ready';return {road,preview};}
  function roadNames(road){const names=[];for(const step of road?.steps||[]){const name=step.road||'未命名道路';if(names.at(-1)!==name)names.push(name);}return names;}
  function roadSequenceText(r){return roadNames(roadState(r).road).join(' → ');}
  function journeyTextBeforeStorageV172(r){
    if(!r)return '尚未選擇路線。';const {road,preview}=roadState(r),pending=r.id===currentRoute()?.id&&!!clickEdit;
    const pts=mapEdit?.routeId===r.id&&mapEdit.baseIsUnsaved&&roadPreview?.status!=='ready'?mapEdit.controls:preview?planningControls():controlsOf(r);const rows=[routeCaption(r),'版本狀態：'+(preview?'新道路預覽，尚未保存':pending?'以下是已保存結果；新草稿尚未完成':'已保存路線'), '起點：'+(pts[0]?.label||pts[0]?.road||'未設定'),'終點：'+(pts.at(-1)?.label||pts.at(-1)?.road||'未設定')];
    if(!road){rows.push('全程公里：尚未取得道路計算','預計時間：尚未取得道路模型時間','途經點順序（不是導航指示）：',pts.map((p,i)=>(i+1)+'. '+(p.label||p.road||p.lat+', '+p.lng)).join('\n'),'請先沿街道計算，成功預覽後才會產生完整走法。');return rows.join('\n');}
    rows.push('全程道路里程：'+(road.distanceMeters/1000).toFixed(2)+' 公里','預計時間（'+timeSourceLabel(road)+'）：'+secondsText(road.durationSeconds),'模式：'+road.costing+'；計算時間：'+road.computedAt);
    
    if(isHybridRoad(road))rows.push('來源與限制：'+road.timeNote,road.provider==='hybrid_osm_path_v22'?'部分路段在 OpenStreetMap 標為 path；不能因此認定現場允許機車通行，請查看標誌。':'部分巷道在 OpenStreetMap 標為 footway／path；不能因此認定現場允許機車通行，請查看標誌。');
    rows.push('','路名順序：'+roadSequenceText(r),'','完整騎乘步驟：');
    road.steps.forEach((s,i)=>rows.push((i+1)+'. '+s.instruction+'；接著約 '+Math.round(s.distanceMeters)+' 公尺'+(['left','uturn'].includes(s.turnKind)?'【左轉／待轉方式須核對現場標誌】':'')));
    for(const p of pts)if(p.instruction||p.turnKind==='two_stage')rows.push('使用者標註：'+(p.label||p.road)+'｜'+(p.turnKind==='two_stage'?'兩段式待轉；':'')+(p.instruction||''));
    rows.push('','估時範圍：沒有完整 07:00–09:00 車流、紅燈與兩段式待轉停等，不能當成保證抵達時間。');return rows.join('\n');
  }
  function renderRouteTextBeforeStorageV172(){
    renderRouteTextV15();const r=currentRoute(),{road,preview}=roadState(r),names=roadNames(road);
    $('journey-text').value=journeyText(r);$('journey-roads-text').value=roadSequenceText(r);
    $('journey-name').textContent=r?routeCaption(r):'完整路線';
    $('journey-metrics').textContent=road?(road.distanceMeters/1000).toFixed(2)+' km · '+(isHybridRoad(road)?'混合粗估 ':'模型 ')+secondsText(road.durationSeconds):'尚未計算道路與時間';
    $('journey-state').textContent=!r?'尚未選擇路線':preview?'未保存預覽':clickEdit?'已保存結果 · 新草稿尚未完成':'已保存';
    $('journey-state').className='journey-state'+(preview||clickEdit?' pending':'');
    $('journey-road-count').textContent=names.length?names.length+' 段路名':'';
    $('journey-road-empty').hidden=!!names.length;
    $('journey-road-empty').textContent=r?'尚未取得道路計算，完成預覽後才會顯示路名順序。':'先選擇一條路線。';
    const list=$('journey-roads');list.replaceChildren();names.forEach((name,i)=>{const item=node('li','journey-road');const number=node('span','journey-road-number',String(i+1));number.setAttribute('aria-hidden','true');item.append(number,node('span',null,name));list.append(item);});
    const steps=$('journey-steps');steps.replaceChildren();(road?.steps||[]).forEach(step=>{const item=node('li'),body=node('div'),hint=node('span','journey-step-distance','接著約 '+Math.round(step.distanceMeters)+' 公尺');body.append(node('strong',null,step.instruction),hint);if(['left','uturn'].includes(step.turnKind))body.append(node('span','journey-turn-note','左轉／待轉方式須核對現場標誌'));item.append(body);steps.append(item);});
    $('journey-step-count').textContent='逐步騎乘說明'+(road?'（'+road.steps.length+' 個步驟）':'');
    $('journey-step-empty').hidden=!!road;
    $('journey-a-note').hidden=r?.id!=='A';
    $('journey-copy-roads').disabled=!names.length;$('journey-copy').disabled=!r;
    $('journey-copy-status').textContent='';$('journey-manual').hidden=true;
    if($('compare-dialog').open)renderComparison();resizeMaps();
  }
  async function copyJourney(scope='all'){
    const r=currentRoute(),roadsOnly=scope==='roads',field=$(roadsOnly?'journey-roads-text':'journey-text');
    if(!r||(roadsOnly&&!roadNames(roadState(r).road).length))return false;
    const text=roadsOnly?roadSequenceText(r):journeyText(r);field.value=text;
    const snapshot=journeyText(r);$('journey-copy-status').textContent='';$('journey-manual').hidden=true;
    const stillCurrent=()=>r.id===currentRoute()?.id&&journeyText(currentRoute())===snapshot;
    try{if(!window.navigator?.clipboard?.writeText)throw new Error();await window.navigator.clipboard.writeText(text);if(stillCurrent()){$('journey-copy-status').textContent=roadsOnly?'已複製路名順序。':'已複製完整路線、公里、估計時間與所有步驟。';resizeMaps();}return true;}
    catch(_){if(!stillCurrent())return false;setJourneyExpanded(true,false);$('journey-manual').hidden=false;$('journey-roads-text').hidden=!roadsOnly;$('journey-text').hidden=roadsOnly;$('journey-manual-label').textContent=roadsOnly?'路名順序（已選取）':'完整路線（已選取）';field.focus();field.select?.();field.scrollIntoView({block:'nearest'});$('journey-copy-status').textContent='瀏覽器未允許自動複製，已選取'+(roadsOnly?'路名順序':'完整文字')+'；請按 Ctrl+C，手機可長按複製。';resizeMaps();return false;}
  }
  let journeyFontSize=18;
  function setJourneyFont(size){journeyFontSize=Math.min(22,Math.max(16,Number(size)||18));$('journey-tray').style.setProperty('--journey-font',journeyFontSize+'px');$('journey-font-size').textContent=journeyFontSize+' px';$('journey-font-down').disabled=journeyFontSize<=16;$('journey-font-up').disabled=journeyFontSize>=22;try{localStorage.setItem('planner.journey.fontSize',String(journeyFontSize));}catch(_){}resizeMaps();}
  function comparisonRows(baseId){
    const routes=allRoutes(),base=routes.find(r=>r.id===baseId),br=base?roadState(base).road:null;
    return routes.map(r=>{
      const {road,preview}=roadState(r);let difference='此方案尚未計算';
      if(road){
        if(!br)difference='請選已計算的比較基準';
        else if(distance(road.points[0],br.points[0])>30||distance(road.points.at(-1),br.points.at(-1))>30)difference='起終點不同，不作通勤快慢排名';
        else if(isHybridRoad(road)||isHybridRoad(br))difference=r.id===baseId?'比較基準（混合估時）':'估時來源不同，不作快慢排名';
        else if(road.costing!==br.costing||road.provider!==br.provider)difference='道路來源／機車模式不同';
        else{const delta=road.durationSeconds-br.durationSeconds;difference=r.id===baseId?'比較基準':(delta>=0?'慢 ':'快 ')+secondsText(Math.abs(delta))+'（同條件模型差）';}
      }
      return {r,road,preview,difference};
    });
  }
  function renderComparison(){
    const routes=allRoutes(),available=routes.filter(r=>roadState(r).road);if(!available.some(r=>r.id===comparisonBase))comparisonBase=available.find(r=>r.id===state.routeId)?.id||available[0]?.id||null;
    fillOptions('compare-baseline',available.map(r=>[r.id,routeCaption(r)+(roadState(r).preview?'（未保存預覽）':'')]),comparisonBase);$('compare-baseline').disabled=!available.length;
    const missing=routes.length-available.length;$('compare-status').textContent=available.length+' 條可比較，'+missing+' 條尚未計算。'+(currentRoute()&&!roadState(currentRoute()).road?'目前方案尚未計算，先以所選的已計算方案作基準。':'')+(roadPreview?.status==='ready'?'目前路線使用未保存預覽。':'');
    const box=$('compare-body');box.replaceChildren();comparisonRows(comparisonBase).forEach(({r,road,preview,difference})=>{
      const row=node('tr'),name=node('td'),title=node('strong',null,routeCaption(r));name.append(title,node('small','muted',(r.custom?'自訂 #'+r.id.slice(-6):'原方案 '+r.id)+' · '+(preview?'未保存預覽':road?'已有道路結果':r.editShape?'舊候選線，尚未沿道路計算':'只有停靠點，尚未沿道路計算')));
      const detail=node('details'),ledger=pointLedger(r),v=r.modelInputs||{};detail.append(node('summary',null,'號誌／待轉與假設'),node('p','muted',r.custom?'已標號誌 '+ledger.markedSignals+'；號誌未知 '+ledger.unknownSignalPoints+' 點；已標待轉 '+ledger.twoStageTurns+'；轉法未知 '+ledger.unknownTurnPoints+' 點。':'舊候選線附近號誌參考 '+(r.signals?.candidateCount??'未知')+'；全程必經號誌與待轉數未知。'),node('p','muted','人工假設：號誌 '+(v.signalCount??'未知')+' × '+(v.redWaitSeconds??'未知')+' 秒；待轉 '+(v.twoStageTurns??'未知')+' × '+(v.twoStageSeconds??'未知')+' 秒；壅塞 '+(v.trafficDelayMinutes??'未知')+' 分。未加到道路模型。'));name.append(detail);
      row.append(name,node('td',null,road?(road.distanceMeters/1000).toFixed(2)+' km':'尚未取得道路里程'),node('td',null,road?secondsText(road.durationSeconds)+(isHybridRoad(road)?'（混合粗估）':'（模型）'):'尚未取得模型時間'),node('td',null,difference));
      const actions=node('td'),b=node('button',road?'':'primary',road?'查看路線':'補算並預覽');b.addEventListener('click',()=>void openComparisonRoute(r.id));actions.append(b);row.append(actions);box.append(row);
    });
  }
  function compare(){renderComparison();showDialog('compare-dialog');}
  async function openComparisonRoute(id){if(id!==state.routeId&&(stopLookup||(clickEdit&&clickEdit.kind!=='none')||roadPreview)){toast('先採用或取消目前草稿，再切換補算其他方案。');return false;}closeDialog('compare-dialog');if(id!==state.routeId){selectRoute(id,{skipStation:true});}else if(!roadState(currentRoute()).road){await requestRoadPreview();}revealStops();return true;}
  function bindJourney(){
    const body=$('journey-body');
    $('journey-toggle').addEventListener('click',()=>setJourneyExpanded(body.hidden));
    $('journey-details').addEventListener('toggle',resizeMaps);
    $('journey-copy').addEventListener('click',()=>void copyJourney());$('journey-copy-roads').addEventListener('click',()=>void copyJourney('roads'));
    $('journey-font-down').addEventListener('click',()=>setJourneyFont(journeyFontSize-2));$('journey-font-up').addEventListener('click',()=>setJourneyFont(journeyFontSize+2));
    try{const stored=Number(localStorage.getItem('planner.journey.fontSize'));if([16,18,20,22].includes(stored))journeyFontSize=stored;}catch(_){}setJourneyFont(journeyFontSize);
    $('compare-baseline').addEventListener('change',()=>{comparisonBase=$('compare-baseline').value;renderComparison();});renderRouteText();
  }

  // v17: a map gesture edits a route constraint transaction, never its polyline vertices.
  let mapEditEnabled=false,mapEdit=null,mapPick=null,mapDrag=null,mapDragCleanup=null,mapSuppressClick=0,mapEditCalculation=0;
  const editGeometry=window.RouteEditGeometry;
  function controlMetadata(points,r){
    const used=new Set();return points.map((p,i)=>{const base=typeof p.controlId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(p.controlId)?p.controlId:'c-'+String(r?.id||'route').replace(/[^A-Za-z0-9_-]/g,'').slice(0,50)+'-'+i;let id=base,attempt=0;while(used.has(id)){attempt++;id=base.slice(0,70)+'-'+i+'-'+attempt;}used.add(id);
      let role=['stop','shaping','locked','legacy'].includes(p.controlRole)?p.controlRole:r&&!r.custom?(i===2||i===3?'locked':'shaping'):'legacy';if(i===0||i===points.length-1)role='endpoint';
      return {controlId:id,controlRole:role,controlSource:validName(p.controlSource||(r&&!r.custom?'preset-reconstruction':'legacy-preserved')).slice(0,80)||'legacy-preserved'};});
  }
  function editControls(r,road,points){const raw=points||controlsOf(r),meta=controlMetadata(raw,r);return raw.map((p,i)=>({...p,...meta[i],...(road?.points?.[i]||{}),...meta[i]}));}
  function exportRoute(r){const out=exportRouteV16(r);if(pointsOf(r).some(p=>p.controlId||p.controlRole||p.controlSource)){const meta=controlMetadata(pointsOf(r),r);out.points=out.points.map((p,i)=>({...p,...meta[i]}));}return out;}
  function routeWithResult(base,result,draft){const next=routeWithResultV16(base,result,draft),meta=controlMetadata(draft,base);next.points=next.points.map((p,i)=>({...p,...meta[i]}));return next;}
  async function stageStopControls(points,focusIndex=null,reason='已調整停靠點'){
    if(mapEdit){toast('先採用或取消地圖改道，再編排停靠點。');return false;}
    const next=points.map((p,i)=>({...p,...controlMetadata(points,currentRoute())[i]}));if(Number.isInteger(focusIndex)&&focusIndex>0&&focusIndex<next.length-1){next[focusIndex].controlRole='stop';next[focusIndex].controlSource='user-stop';}
    return stageStopControlsV16(next,focusIndex,reason);
  }
  function releaseMapPointer(){if(mapDragCleanup){const f=mapDragCleanup;mapDragCleanup=null;f();}mapDrag=null;}
  function cancelDragEdit(redraw=true){mapEditCalculation++;releaseMapPointer();mapEdit=null;mapPick=null;cancelDragEditV16(redraw);}
  function startAdjust(id){
    if(ux.ready)uxSetTab('edit');
    if(stopLookup||(clickEdit&&clickEdit.kind!=='none'&&!mapEdit)){toast('先採用或取消目前草稿，再開始地圖改道。');return false;}
    if(id&&id!==state.routeId)selectRoute(id,{keepViewport:true,skipStation:true});
    const r=currentRoute();if(!r)return false;if(!baselineRoad(r)){mapEditEnabled=false;startAdjustV16();toast('這個方案要先取得完整道路結果，才能選線改道。');return false;}
    if(mapEdit){toast('可以繼續拖動新藍線改道，或先採用／取消。');return true;}
    cancelDragEdit(false);mapEditEnabled=true;state.mode='draw';state.showAllRoutes=false;state.compareOverlay=false;state.dragRouteMode=false;
    setJourneyExpanded(false,false);state.layout.collapsed=false;applyLayout();saveLayout();render();if(window.innerWidth<=760)mobileTab('map');toast('拖動藍線到另一條道路；也可先點藍線，再點新道路。');return true;
  }
  function setModeV24(mode){if(mode==='draw')return startAdjust();mapEditEnabled=false;cancelDragEdit(false);setModeV16(mode);}
  function selectRouteV24(id,options={}){if(id!==state.routeId&&uxHasDraft()){toast('請先採用或取消目前修改，再切換路線。');uxRefresh();return false;}guide.requestPoint=null;guide.heading=null;guide.focusKey=null;mapEditEnabled=false;cancelDragEdit(false);return selectRouteV16(id,options);}
  function chooseEdit(kind,options={}){if(mapEdit){toast('先完成地圖改道，再用進階工具。');return false;}mapEditEnabled=false;return chooseEditV16(kind,options);}
  function editRoadName(road,index){let name='路線位置';for(const step of road.steps||[]){if(step.shapeIndex>index)break;name=step.road||'未命名道路';}return name;}
  function beginMapSelection(point,candidateIndex=null){
    if(!mapEditEnabled)return false;const r=currentRoute(),road=roadPresentation(r);if(!r||!road)return false;
    if(roadPreview?.status==='loading'){toast('目前正在重算，請等完成或按取消。');return false;}
    if(mapEdit?.analysis?.outsideChanged&&!mapEdit.outsideAccepted){toast('請先核對上一段的範圍外道路變更，才能繼續改下一段。');return false;}
    const candidates=editGeometry.projectCandidates(road,point,{maxDistanceMeters:60});if(!candidates.length){toast('請點目前藍色路線上的位置。');return false;}
    if(candidates.length>1&&candidateIndex===null){mapPick={point,candidates};renderMapEdit();toast('這裡有重疊路線，請先選擇要改的行進段。');return false;}
    const hit=candidates[candidateIndex||0];if(!hit)return false;
    const baseIsUnsaved=roadPreview?.status==='ready'||!!mapEdit?.baseIsUnsaved;
    const original=mapEdit?.originalRoad||baselineRoad(r),controls=editControls(r,road,planningControls());
    const bounds=editGeometry.suggestRange({road,controls,hitIndex:hit.pos});
    releaseMapPointer();pendingClear();resetStopLookup();mapPick=null;
    mapEdit={routeId:r.id,fingerprint:fingerprint(r),baseRoad:clone(road),originalRoad:clone(original),baseIsUnsaved,controls:clone(controls),...bounds,target:null,releaseIds:[],plan:null,analysis:null,outsideAccepted:false,boundary:null};
    clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'maprange',basePoints:clone(controls),target:null};
    selectLocationV16(hit,{viewOnly:true,label:'準備調整：'+editRoadName(road,hit.pos)});render();return true;
  }
  async function stageMapTarget(point){
    const d=mapEdit,r=currentRoute(),p=coord(point);if(!d||!p||!r||r.id!==d.routeId||fingerprint(r)!==d.fingerprint)return false;
    releaseMapPointer();d.target=p;d.analysis=null;d.outsideAccepted=false;d.boundary=null;
    try{d.plan=editGeometry.buildReplacement({road:d.baseRoad,controls:d.controls,startIndex:d.startIndex,endIndex:d.endIndex,hitIndex:d.hitIndex,target:p,releaseIds:d.releaseIds});}
    catch(e){pendingClear();clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'maprange',basePoints:d.controls,target:null};d.error=cleanError(e);render();toast(d.error);return false;}
    d.error=null;pendingClear();resetStopLookup();clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'controls',basePoints:clone(controlsOf(r)),proposedPoints:adjustedEvidence(d.plan.points,d.controls),focusIndex:d.plan.focusIndex,target:p,reason:'地圖替換：'+editRoadName(d.baseRoad,d.startIndex)+' → '+editRoadName(d.baseRoad,d.endIndex)};
    selectLocationV16(p,{viewOnly:true,label:'改道目標，等待沿道路計算'});render();await requestRoadPreview();
    if(mapEdit!==d)return false;
    renderMapEdit();return roadPreview?.status==='ready';
  }
  function beginMapBoundary(which){const d=mapEdit;if(!d||roadPreview?.status==='loading')return false;mapEditCalculation++;pendingClear();d.analysis=null;d.outsideAccepted=false;d.error=null;d.boundary=which;clickEdit={routeId:d.routeId,fingerprint:d.fingerprint,kind:'maprange',basePoints:clone(d.controls),target:null};render();return true;}
  function setMapBoundary(which,point){const d=mapEdit;if(!d)return false;const hits=editGeometry.projectCandidates(d.baseRoad,point,{maxDistanceMeters:60});if(hits.length!==1){toast(hits.length?'交疊位置不明確，請選旁邊能分辨的原路段。':'請把邊界放在原藍線上。');return false;}
    const index=hits[0].index,start=which==='start'?index:d.startIndex,end=which==='end'?index:d.endIndex;
    if(start>=d.hitIndex||end<=d.hitIndex||start>=end){toast('開始與接回位置須包住原本選中的路段。');return false;}
    d.startIndex=start;d.endIndex=end;d.boundary=null;d.analysis=null;d.outsideAccepted=false;if(d.target)void stageMapTarget(d.target);else render();return true;
  }
  function selectLocation(p,options={}){
    if(mapEditEnabled&&mapEdit&&!options.viewOnly&&!options.fromStep){if(mapEdit.boundary)return setMapBoundary(mapEdit.boundary,p);void stageMapTarget(p);return;}
    return selectLocationV16(p,options);
  }
  function roadPresentation(r){if(mapEdit&&r&&mapEdit.routeId===r.id&&mapEdit.baseIsUnsaved&&roadPreview?.status!=='ready')return mapEdit.baseRoad;return roadPresentationV16(r);}
  function roadState(r){const s=roadStateV16(r);if(mapEdit&&r&&mapEdit.routeId===r.id&&mapEdit.baseIsUnsaved&&roadPreview?.status!=='ready')s.preview=true;return s;}
  function planningControls(){if(mapEdit?.baseIsUnsaved&&clickEdit?.kind==='maprange')return clone(mapEdit.controls);return planningControlsV16();}
  async function requestRoadPreview(){
    const d=mapEdit,sequence=++mapEditCalculation;if(d){d.analysis=null;d.outsideAccepted=false;}else mapEditEnabled=false;
    await requestRoadPreviewV16();if(mapEdit!==d||sequence!==mapEditCalculation)return;
    if(d&&roadPreview?.status==='ready'){try{d.analysis=editGeometry.assessChanges(d.baseRoad,roadPreview.result,d.startIndex,d.endIndex);}catch(e){d.error='路線差異無法核對：'+cleanError(e);}}
    renderMapEdit();
  }
  function draftControls(){if(clickEdit?.kind==='maprange')throw new Error('先把藍線拖到新道路，或點選新的道路位置。');return draftControlsV16();}
  function confirmDragEditBeforeStorageV172(){if(mapEdit&&(!mapEdit.analysis||mapEdit.analysis.outsideChanged&&!mapEdit.outsideAccepted)){toast('請先完成重算，並核對範圍外的道路變更。');return false;}const editing=mapEditEnabled;confirmDragEditV16();if(!roadPreview){mapEditEnabled=editing;render();}return true;}
  function mapEditPreviewDetails(){const d=mapEdit;if(!d)return null;return {startIndex:d.startIndex,endIndex:d.endIndex,hitIndex:d.hitIndex,releaseIds:[...d.releaseIds],target:coord(d.target),plan:d.plan?clone(d.plan):null,analysis:d.analysis?clone(d.analysis):null,outsideAccepted:d.outsideAccepted,boundary:d.boundary};}
  function chooseMapOccurrence(index){if(!mapPick)return false;return beginMapSelection(mapPick.point,index);}
  function mapEditRelease(id,released){if(!mapEdit)return;mapEdit.releaseIds=mapEdit.releaseIds.filter(x=>x!==id);if(released)mapEdit.releaseIds.push(id);if(mapEdit.target)void stageMapTarget(mapEdit.target);else renderMapEdit();}
  function renderMapEdit(){
    const panel=$('map-edit-panel'),d=mapEdit,ready=roadPreview?.status==='ready';panel.hidden=!mapEditEnabled;$('map-edit-bar').hidden=!mapEditEnabled;if(!mapEditEnabled)return;
    $('mode-draw').textContent='調整走法';$('mode-note').textContent='拖藍線換街道；放開後沿道路重算';$('start-adjust').textContent='地圖改道中';$('click-controls').hidden=true;
    $('map-edit-status').textContent=mapPick?'同一位置有不同的行進段，請選要修改哪一段。':!d?'① 拖動藍線到新道路，或點原藍線後再點新道路。':d.error?'未能預覽：'+d.error:roadPreview?.status==='loading'?'② 正在重算，顯示'+(d.baseIsUnsaved?'上次成功的未保存走法。':'已保存路線。'):roadPreview?.status==='error'?'重算失敗：'+roadPreview.error+' '+(d.baseIsUnsaved?'顯示上次成功的未保存走法。':'原方案未變。'):ready?'③ 新藍線已取代畫面舊線；看街景後採用。':d.boundary?'請在原藍線點選新的'+(d.boundary==='start'?'開始':'接回')+'位置。':'② 已選好原路段，點新道路或拖動「改」標記。';
    $('map-edit-bar-status').textContent=$('map-edit-status').textContent;$('map-help').textContent='「始／回」限定替換範圍；「改」是新道路目標。點轉彎標誌可看街景。';
    $('map-edit-range').hidden=!d;$('map-edit-new-scope').disabled=!d;$('map-edit-start').disabled=!d;$('map-edit-end').disabled=!d;
    if(d){$('map-edit-range-label').textContent='開始：'+editRoadName(d.baseRoad,d.startIndex)+' → 接回：'+editRoadName(d.baseRoad,d.endIndex);}
    const choices=$('map-edit-occurrences');choices.replaceChildren();if(mapPick)mapPick.candidates.forEach((p,i)=>{const b=node('button',null,'第 '+(i+1)+' 次經過 · '+editRoadName(roadPresentation(currentRoute()),p.pos)+' · 距起點約 '+(p.alongMeters/1000).toFixed(2)+' km');b.addEventListener('click',()=>chooseMapOccurrence(i));choices.append(b);});
    const protectedBox=$('map-edit-protected');protectedBox.replaceChildren();
    if(d)for(const p of d.controls.filter(p=>p.shapeIndex>d.startIndex&&p.shapeIndex<d.endIndex&&p.controlRole!=='shaping'&&p.controlRole!=='endpoint')){const row=node('label','map-edit-protected-row'),box=node('input');box.type='checkbox';box.checked=d.releaseIds.includes(p.controlId);box.disabled=roadPreview?.status==='loading';box.addEventListener('change',()=>mapEditRelease(p.controlId,box.checked));row.append(box,node('span',null,'解除必經：'+(p.label||p.road||p.controlId)+'（'+({locked:'指定橋樑',stop:'停靠點',legacy:'舊點，用途待確認'}[p.controlRole]||'保護點')+'）'));protectedBox.append(row);}
    $('map-edit-protected-note').hidden=!protectedBox.children.length;
    $('map-edit-removed').textContent=d?.plan?'替換舊控制點：'+(d.plan.removed.map(p=>p.label||p.road||p.controlId).join('、')||'無'):'範圍內的舊走法控制點會被替換；指定橋樑、停靠點及用途不明的舊點預設保留。';
    const road=ready?roadPreview.result:null,delta=road&&d?road.durationSeconds-d.originalRoad.durationSeconds:null;
    $('map-edit-metrics').textContent=road?(road.distanceMeters/1000).toFixed(2)+' km · 模型 '+secondsText(road.durationSeconds)+'；相對保存前 '+(delta>=0?'慢 ':'快 ')+secondsText(Math.abs(delta))+'，里程 '+((road.distanceMeters-d.originalRoad.distanceMeters)>=0?'+':'')+Math.round(road.distanceMeters-d.originalRoad.distanceMeters)+' m':'';
    if(road&&d&&road.costing!==d.originalRoad.costing)$('map-edit-metrics').textContent=(road.distanceMeters/1000).toFixed(2)+' km · 模型 '+secondsText(road.durationSeconds)+'；計算模式不同，不比較快慢。';
    $('map-edit-changes').textContent=d?.analysis?'新出現道路：'+(d.analysis.roadsAdded.join('、')||'路名相同，請看線形')+'；不再經過：'+(d.analysis.roadsRemoved.join('、')||'無'):'距離、時間及文字會在同一筆道路計算完成後更新。';
    const outside=!!d?.analysis?.outsideChanged;$('map-edit-outside-row').hidden=!outside;$('map-edit-outside').checked=!!d?.outsideAccepted;
    $('map-edit-outside-text').textContent='選定範圍外的道路可能改變或無法確認。已核對完整新線，仍採用這個走法。';
    if(outside&&!d.outsideAccepted)$('map-edit-bar-status').textContent='範圍外道路可能變動：請開啟「範圍與變更」核對後再採用。';
    const allowed=ready&&!!d?.analysis&&(!outside||d.outsideAccepted);for(const id of ['map-edit-accept','map-edit-bar-accept','accept-drag','stop-accept'])$(id).disabled=!allowed;
    $('map-edit-retry').hidden=roadPreview?.status!=='error';$('map-edit-cancel').disabled=!d&&!mapPick;$('map-edit-bar-cancel').disabled=!d&&!mapPick;refreshMapEditV27();
  }
  function renderEditor(){renderEditorV16();if(mapEditEnabled)renderMapEdit();else{$('map-edit-panel').hidden=true;$('map-edit-bar').hidden=true;$('mode-draw').textContent='調整走法';$('start-adjust').textContent='在地圖調整走法';}}
  function bindMapEditLine(line){
    let hover=null;
    line.on('mousemove',e=>{if(mapDrag||mapPick||mapEdit?.boundary)return;const p=productMapCoord(e.latlng);if(!p)return;if(!hover){hover=L.marker(p,{icon:L.divIcon({className:'map-edit-hover',html:'',iconSize:[18,18],iconAnchor:[9,9]}),interactive:false,zIndexOffset:1400,role:'route-hover'}).addTo(state.maps.leaflet);state.layers.push(hover);}else hover.setLatLng?.(p);});
    line.on('mouseout',()=>{hover?.remove();hover=null;});
    line.on('click',e=>{L.DomEvent.stopPropagation(e);if(Date.now()<mapSuppressClick)return;if(mapEdit?.boundary){setMapBoundary(mapEdit.boundary,productMapCoord(e.latlng));return;}if(mapEdit&&!roadPreview){void stageMapTarget(productMapCoord(e.latlng));return;}beginMapSelection(productMapCoord(e.latlng));});
    line.on('mousedown',e=>{if(e.originalEvent?.button>0||mapEdit?.boundary)return;L.DomEvent.stopPropagation(e);L.DomEvent.preventDefault?.(e.originalEvent||e);if(!beginMapSelection(productMapCoord(e.latlng)))return;const map=state.maps.leaflet,wasEnabled=map.dragging?.enabled?.()!==false,start=productMapCoord(e.latlng);map.dragging?.disable();mapDrag={start,last:start};
      const move=ev=>{const p=productMapCoord(ev.latlng);if(!mapDrag||!p)return;mapDrag.last=p;const handle=state.layers.find(x=>x.options?.role==='map-target');handle?.setLatLng?.(p);};
      const end=ev=>{if(!mapDrag)return;const p=productMapCoord(ev?.latlng)||mapDrag.last,moved=distance(start,p)>5;releaseMapPointer();mapSuppressClick=Date.now()+350;if(moved)void stageMapTarget(p);};
      map.on('mousemove',move);map.on('mouseup',end);document.addEventListener('mouseup',end);mapDragCleanup=()=>{map.off('mousemove',move);map.off('mouseup',end);document.removeEventListener('mouseup',end);if(wasEnabled)map.dragging?.enable();};
    });
  }
  function drawMap(){if(!mapEditEnabled){drawMapV16();return;}clearLayers();clearDragLayers();const map=state.maps.leaflet,r=currentRoute(),main=roadPresentation(r);if(!map||!r||!main)return;
    const line=L.polyline(main.path,{color:'#087df0',weight:8,opacity:1,bubblingMouseEvents:false,role:'active-road',routeId:r.id,className:'map-edit-line'}).addTo(map);line.bindTooltip(node('span',null,'拖動這段藍線改道，或點一下後再點新道路'));bindMapEditLine(line);state.layers.push(line);
    const d=mapEdit;
    if(d&&roadPreview?.status!=='ready'&&roadPreview?.status!=='error'){const shade=L.polyline(d.baseRoad.path.slice(d.startIndex,d.endIndex+1),{color:'#5c25a8',weight:14,opacity:.32,interactive:false,role:'edit-scope'}).addTo(map);state.layers.push(shade);}
    for(const [p,label]of [[main.path[0],'起'],[main.path.at(-1),'終']]){const mark=L.marker(p,{icon:L.divIcon({className:'home-marker',html:label,iconSize:[28,28]}),role:'endpoint'}).addTo(map);state.layers.push(mark);}
    drawTurnMarkers();drawPhotoMarkers();drawViewerMarker();
    if(d){for(const [key,index,label]of [['start',d.startIndex,'始'],['end',d.endIndex,'回']]){const marker=L.marker(d.baseRoad.path[index],{icon:L.divIcon({className:'map-edit-boundary',html:label,iconSize:[34,34],iconAnchor:[17,17]}),draggable:roadPreview?.status!=='loading',zIndexOffset:1600,role:'map-boundary',boundary:key}).addTo(map);marker.bindTooltip(node('span',null,(key==='start'?'從這裡開始替換':'在這裡接回')+'：'+editRoadName(d.baseRoad,index)));marker.on('dragend',()=>{if(!setMapBoundary(key,productMapCoord(marker.getLatLng())))drawMap();});marker.on('click',()=>selectLocation(d.baseRoad.path[index],{viewOnly:true,label:editRoadName(d.baseRoad,index)}));state.layers.push(marker);}
      const p=roadPreview?.status==='ready'?roadPreview.result.points[d.plan.focusIndex]:d.target||d.baseRoad.path[Math.round(d.hitIndex)];
      const handle=L.marker(p,{icon:L.divIcon({className:'map-edit-target',html:'改',iconSize:[38,38],iconAnchor:[19,19]}),draggable:roadPreview?.status!=='loading',zIndexOffset:1700,role:'map-target'}).addTo(map);handle.bindTooltip(node('span',null,'拖到想經過的新道路，放開後重算'));handle.on('dragend',()=>void stageMapTarget(productMapCoord(handle.getLatLng())));handle.on('click',()=>selectLocation(p,{viewOnly:true,label:'目前改道位置'}));state.layers.push(handle);
    }
  }
  function bindMapEditor(){
    for(const id of ['map-edit-accept','map-edit-bar-accept'])$(id).addEventListener('click',()=>confirmDragEdit());
    for(const id of ['map-edit-cancel','map-edit-bar-cancel'])$(id).addEventListener('click',()=>productDiscard());
    $('map-edit-start').addEventListener('click',()=>beginMapBoundary('start'));$('map-edit-end').addEventListener('click',()=>beginMapBoundary('end'));
    $('map-edit-new-scope').addEventListener('click',()=>{if(roadPreview?.status==='ready'){toast('直接拖動目前新藍線，即可繼續調整下一段。');}else{cancelDragEdit();toast('請重新點選原藍線上的路段。');}});
    $('map-edit-outside').addEventListener('change',()=>{if(mapEdit){mapEdit.outsideAccepted=$('map-edit-outside').checked;renderMapEdit();}});
    $('map-edit-retry').addEventListener('click',()=>{if(mapEdit?.target)void stageMapTarget(mapEdit.target);});
    $('map-edit-details').addEventListener('click',()=>{state.layout.collapsed=false;applyLayout();if(window.innerWidth<=760)mobileTab('route');$('map-edit-panel').scrollIntoView({block:'nearest'});});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&mapEdit&&!['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName)){e.preventDefault();cancelDragEdit();}});
    renderMapEdit();
  }

  // v17.2: one source of truth for the bottom drawer; preferences never enter the route library.
  const journeyLayoutKey='planner.journey.layout.v1';
  let journeyLayout={expanded:false,height:240},journeyResize=null;
  function journeyHeightLimit(){
    const viewport=Number(window.innerHeight)||800,body=$('journey-body'),bench=document.querySelector('.workbench');
    const available=bench?.getBoundingClientRect?.().height;
    const shown=body.hidden?0:body.getBoundingClientRect().height;
    const header=$('journey-header');const openingHeader=header.hidden?(Number(header.scrollHeight)||140):0;
    const budget=Number.isFinite(available)&&available>0?available+shown-openingHeader-Math.min(220,viewport*.3):viewport-310;
    return Math.max(48,Math.floor(Math.min(viewport*.55,budget)));
  }
  function saveJourneyLayout(){try{localStorage.setItem(journeyLayoutKey,JSON.stringify(journeyLayout));}catch(_){} }
  function applyJourneyLayout(){
    const body=$('journey-body'),handle=$('journey-resize'),expanded=journeyLayout.expanded,max=journeyHeightLimit();
    const height=Math.max(Math.min(80,max),Math.min(max,journeyLayout.height));
    body.hidden=!expanded;$('journey-header').hidden=!expanded;$('journey-copy-status').hidden=!expanded;$('journey-tray').style.setProperty('--journey-body-height',height+'px');
    $('journey-toggle').textContent=expanded?'收合路線 ▼':'展開路線 ▲';$('journey-toggle').setAttribute('aria-expanded',String(expanded));
    $('journey-toggle').title=expanded?'完整收合，只保留展開列':'展開公里、時間、路名與完整騎乘步驟';
    $('journey-tray').classList.toggle('journey-collapsed',!expanded);
    handle.setAttribute('aria-valuemin','0');handle.setAttribute('aria-valuemax',String(max));handle.setAttribute('aria-valuenow',String(expanded?height:0));
    handle.setAttribute('aria-valuetext',expanded?'路線內容高度 '+height+' 像素':'路線已收合');
    $('journey-resize-label').textContent=expanded?'↕ 上下拖曳調整高度 · 雙擊收合':'↕ 往上拖曳展開路線 · 雙擊展開';
    resizeMaps();
  }
  function setJourneyExpanded(expanded,persist=true){journeyLayout.expanded=!!expanded;applyJourneyLayout();if(persist)saveJourneyLayout();}
  function setJourneyHeight(height,persist=true){const max=journeyHeightLimit();journeyLayout.height=Math.max(Math.min(80,max),Math.min(max,Number(height)||240));journeyLayout.expanded=true;applyJourneyLayout();if(persist)saveJourneyLayout();}
  function finishJourneyResize(event,cancel=false){
    if(!journeyResize||(event?.pointerId!==undefined&&event.pointerId!==journeyResize.pointerId))return;
    const old=journeyResize;journeyResize=null;
    if(cancel)journeyLayout={...old.previous};
    $('journey-tray').classList.remove('journey-resizing');document.body.classList.remove('journey-is-resizing');
    try{$('journey-resize').releasePointerCapture?.(old.pointerId);}catch(_){}
    applyJourneyLayout();saveJourneyLayout();
  }
  function bindJourneyDrawer(){
    try{const saved=JSON.parse(localStorage.getItem(journeyLayoutKey)||'null');if(saved&&typeof saved.expanded==='boolean'&&Number.isFinite(saved.height)&&saved.height>=48&&saved.height<=2000)journeyLayout={expanded:saved.expanded,height:saved.height};}catch(_){}
    const handle=$('journey-resize');
    handle.addEventListener('pointerdown',e=>{if(e.button!==0||e.isPrimary===false||journeyResize)return;e.preventDefault();journeyResize={pointerId:e.pointerId,startY:e.clientY,startHeight:journeyLayout.expanded?Math.min(journeyLayout.height,journeyHeightLimit()):0,previous:{...journeyLayout}};handle.setPointerCapture?.(e.pointerId);$('journey-tray').classList.add('journey-resizing');document.body.classList.add('journey-is-resizing');});
    handle.addEventListener('pointermove',e=>{if(!journeyResize||e.pointerId!==journeyResize.pointerId)return;e.preventDefault();const dy=journeyResize.startY-e.clientY;if(Math.abs(dy)<4)return;const next=journeyResize.startHeight+dy;if(next<40)setJourneyExpanded(false,false);else setJourneyHeight(next,false);});
    handle.addEventListener('pointerup',e=>finishJourneyResize(e));handle.addEventListener('pointercancel',e=>finishJourneyResize(e,true));handle.addEventListener('lostpointercapture',e=>finishJourneyResize(e,true));
    handle.addEventListener('dblclick',()=>setJourneyExpanded(!journeyLayout.expanded));
    handle.addEventListener('keydown',e=>{const current=journeyLayout.expanded?Math.min(journeyLayout.height,journeyHeightLimit()):0;if(e.key==='ArrowUp'){e.preventDefault();setJourneyHeight(current+(e.shiftKey?80:32));}else if(e.key==='ArrowDown'){e.preventDefault();if(current<=80)setJourneyExpanded(false);else setJourneyHeight(current-(e.shiftKey?80:32));}else if(e.key==='Home'){e.preventDefault();setJourneyExpanded(false);}else if(e.key==='End'){e.preventDefault();setJourneyHeight(journeyHeightLimit());}else if(e.key==='Enter'||e.key===' '){e.preventDefault();setJourneyExpanded(!journeyLayout.expanded);}else if(e.key==='Escape'){finishJourneyResize(null,true);}});
    window.addEventListener('resize',()=>{if(journeyResize)finishJourneyResize(null,true);applyJourneyLayout();});window.addEventListener('blur',()=>finishJourneyResize(null,true));
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&journeyResize){e.preventDefault();finishJourneyResize(null,true);}});
    applyJourneyLayout();
  }

// v17.2: preserve truthful persistence feedback and bound all visible creation flows.
  const ROUTE_LIBRARY_LIMIT = 100;
  let storageProduct = {browserSaved:null, legacyMirrorSaved:null};
  try{const stored=JSON.parse(localStorage.getItem(LIBRARY_KEY)||'null');if(stored?.version===10&&validLibrary(stored.library))storageProduct.browserSaved=true;}catch(_){}
  function capacityAvailable(add=1) {
    if(Number.isInteger(add)&&add>=0&&state.customRoutes.length+add<=ROUTE_LIBRARY_LIMIT)return true;
    toast('最多保存 100 條自訂方案（含回收區）。這次未新增；請先匯出備份並整理方案。');return false;
  }
  function currentSaveLabelV24() {
    if(persistence.ready&&!library.dirty)return '已保存到本機';
    if(storageProduct.browserSaved===false)return '未完整保存・請勿關閉';
    if(library.dirty&&persistence.ready)return storageProduct.browserSaved?'瀏覽器已保存・本機待同步':'本機待同步';
    if(storageProduct.browserSaved)return '已保存於此瀏覽器';
    return '既有已保存方案';
  }
  function refreshSaveBadge() {
    const r=currentRoute();if(!r||roadState(r).preview||clickEdit)return;
    $('journey-state').textContent=currentSaveLabel();
    $('journey-state').className='journey-state'+(library.dirty?' pending':'');
    $('journey-text').value=journeyText(r);refreshHandoff();
  }
  function saveLocalV24() {
    try{localStorage.setItem(LIBRARY_KEY,JSON.stringify({version:10,dirty:library.dirty,serverRevision:library.serverRevision,library:libraryPayload()}));storageProduct.browserSaved=true;}
    catch(_){storageProduct.browserSaved=false;$('save-status').textContent='瀏覽器完整路線庫未保存；請勿關閉頁面，請匯出 JSON 備份。';return false;}
    // The v10 envelope is authoritative. Failure of the old v5 mirror must not
    // misreport that a successfully written complete library was lost.
    try{localStorage.setItem('commute-planner-routes-v5',JSON.stringify(state.customRoutes.map(exportRoute)));storageProduct.legacyMirrorSaved=true;}
    catch(_){storageProduct.legacyMirrorSaved=false;}
    return true;
  }
  function storeRoutesV24() {
    mutationEpoch++;library.dirty=true;const browser=saveLocal();
    if(persistence.blocked)$('save-status').textContent=browser?'瀏覽器副本已保存；本機版本衝突，請先匯出備份再重新讀取。':'瀏覽器未保存，本機版本也衝突；請勿關閉，立即匯出 JSON 備份。';
    else if(persistence.ready)$('save-status').textContent=browser?'瀏覽器副本已保存，正在保存到本機檔案…':'瀏覽器未保存，正在嘗試本機檔案保存；請勿關閉頁面。';
    else $('save-status').textContent=browser?'已保存瀏覽器副本；本機檔案尚未同步':'尚未保存：瀏覽器儲存失敗且本機未連線；請勿關閉，立即匯出 JSON 備份。';
    refreshSaveBadge();
    if(persistence.ready&&!persistence.blocked){persistence.pending=true;void flushLibrary();}
  }
  async function flushLibraryV24() {
    if(!persistence.ready||persistence.saving||persistence.blocked)return;persistence.saving=true;
    try{while(persistence.pending){
      persistence.pending=false;const epoch=mutationEpoch,payload=libraryPayload(),expected=persistence.revision;
      const response=await window.fetch('/api/routes',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':persistence.csrf,'X-Planner-Client':'25'},body:JSON.stringify({version:10,expectedRevision:expected,library:payload})});
      if(response.status===409){persistence.blocked=true;let detail=null;try{detail=await response.json();}catch(_){}
        const reason=detail?.error==='newer_client_required'?'此分頁版本過舊，請重新開啟最新版':'另一頁已先保存';
        $('save-status').textContent=reason+'；'+(storageProduct.browserSaved?'瀏覽器副本保留，請先匯出備份再重新讀取。':'瀏覽器也未保存，請勿關閉並立即匯出 JSON 備份。');break;}
      if(!response.ok)throw new Error('保存失敗');const answer=await response.json();if(answer.revision!==expected+1)throw new Error('保存版本回應異常');
      persistence.revision=answer.revision;library.serverRevision=answer.revision;library.dirty=mutationEpoch!==epoch;const browser=saveLocal();
      $('save-status').textContent=library.dirty?(browser?'正在保存最新編輯；瀏覽器副本已保留…':'本機已保存上一筆，最新編輯尚未完整保存；請勿關閉…'):(browser?'已保存到本機檔案＋瀏覽器 · 版本 '+answer.revision:'已保存到本機檔案 · 版本 '+answer.revision+'；瀏覽器副本未更新，可匯出備份。');
      refreshSaveBadge();if(library.dirty)persistence.pending=true;
    }}catch(_){$('save-status').textContent=storageProduct.browserSaved?'本機保存未成功；瀏覽器副本保留，可按「重試保存」。':'本機及瀏覽器均未保存；請勿關閉，請立即匯出 JSON 備份或重試保存。';}
    finally{persistence.saving=false;refreshSaveBadge();}
  }
  function newRouteIdentity(prefix='C') {
    let id,attempt=0;const taken=new Set(state.customRoutes.map(r=>r.id));
    do{id=prefix+Date.now().toString(36)+'-'+state.customRoutes.length+'-'+attempt++;}while(taken.has(id));return id;
  }
  function newCommuteV24(){if(!capacityAvailable())return false;return newCommuteBeforeStorageV172();}
  function newCustom(empty=false){if((empty||!currentRoute()?.custom)&&!capacityAvailable())return false;return newCustomBeforeStorageV172(empty);}
  function copyCurrentRoute(){
    if(!capacityAvailable())return false;const r=currentRoute();if(!r?.custom)return newCustom(false);
    cancelDragEdit(false);const copy={...clone(r),id:newRouteIdentity(),name:validName(routeCaption(r)+'・副本')};copy.label=copy.name;
    state.customRoutes.push(copy);library.order.push(copy.id);state.routeId=copy.id;state.undo=[];render();storeRoutes();setMode('draw');return true;
  }
  function confirmDragEditV24(){
    if(!currentRoute()?.custom&&roadPreview?.status==='ready'&&!capacityAvailable())return false;
    const before=mutationEpoch,result=confirmDragEditBeforeStorageV172();
    if(mutationEpoch!==before){refreshSaveBadge();toast('已採用完整道路、公里、模型時間與逐步文字。'+(storageProduct.browserSaved?'瀏覽器副本已保存；本機保存結果請看左側狀態。':'瀏覽器副本未保存；請確認左側本機保存狀態並匯出備份。'));}
    return result;
  }
  async function importRoutesV24(file){
    if(!file)return;try{
      if(file.size>2_000_000)throw new Error('路線檔須小於 2 MB。');const p=JSON.parse(await file.text());let incoming;
      if(p.version===5&&Array.isArray(p.routes)&&p.routes.every(validSavedRoute))incoming=p.routes;
      else if(p.version===10&&validLibrary(p.library))incoming=p.library.customRoutes;
      else throw new Error('路線檔格式不正確。');
      if(!capacityAvailable(incoming.length))return;
      // Prepare every route before mutating the live collection: malformed
      // imports must not leave a partially appended library.
      const taken=new Set(state.customRoutes.map(r=>r.id));let serial=0;
      const copies=incoming.map(r=>{const copy=exportRoute(r);let id;do{id='I'+Date.now().toString(36)+'-'+(serial++);}while(taken.has(id));taken.add(id);copy.id=id;return copy;});
      state.customRoutes.push(...copies);library.order.push(...copies.map(r=>r.id));storeRoutes();render();
      toast('已新增匯入 '+copies.length+' 條方案。這不是全庫還原：住家／公司設定、排序、回收區及 A／B 名稱維持目前內容。');
    }catch(error){toast(cleanError(error));}finally{$('import-file').value='';}
  }
  function renderRouteTextBeforeHandoffV172(){renderRouteTextBeforeStorageV172();refreshSaveBadge();}
  function journeyText(r){const text=journeyTextBeforeStorageV172(r);if(!r||roadState(r).preview||r.id===currentRoute()?.id&&clickEdit)return text;return text.replace('版本狀態：已保存路線','版本狀態：'+currentSaveLabel());}

// v18: a complete-route export is separate from the saved road geometry.
  let handoffSnapshot=null,handoffMap=null;
  const handoffPrefKey='route-handoff-v18';
  let handoffPrefs=[];
  try{const p=JSON.parse(localStorage.getItem(handoffPrefKey)||'[]');if(Array.isArray(p))handoffPrefs=p.filter(x=>x&&typeof x.fingerprint==='string'&&x.fingerprint.length<300000&&Array.isArray(x.selectedIndices)&&x.selectedIndices.length<=50&&x.selectedIndices.every(Number.isInteger)).slice(-20);}catch(_){}
  function handoffContext(){
    const r=currentRoute();if(!r)throw new Error('先選擇一條路線。');
    if(stopLookup)throw new Error('目前還在選位置；請先使用或取消這個位置，再建立手機導航。');
    const {road,preview}=roadState(r);
    if((clickEdit||roadPreview)&&roadPreview?.status!=='ready')throw new Error('目前草稿尚未完成道路計算；請先完成預覽，或取消草稿。舊路線不會冒充新結果匯出。');
    if(mapEdit?.analysis?.outsideChanged&&!mapEdit.outsideAccepted)throw new Error('改道路段以外也有變動；請先在地圖改道區核對並確認。');
    if(!road)throw new Error('此方案尚未沿道路計算，請先按「補算並預覽」。');
    const controls=preview?planningControls():controlsOf(r),routeState=preview?'未保存預覽；出發前請先採用並確認保存':currentSaveLabel();
    return {r,road,preview,controls,routeState,name:routeCaption(r),roadText:roadSequenceText(r),journeyText:journeyText(r)};
  }
  function handoffCurrent(){
    const c=handoffContext(),fp=window.RouteHandoffSingle.fingerprint(c.road,c.controls),pref=handoffPrefs.find(p=>p.fingerprint===fp),segmented=$('handoff-mode').value==='segments';
    const home=c.road?.path?.[0]&&state.home&&Math.abs(c.road.path[0].lat-state.home.lat)<0.0002&&Math.abs(c.road.path[0].lng-state.home.lng)<0.0002&&String(c.controls[0]?.label||'').includes('住家')?state.home.address:'';
    const result=segmented?window.RouteHandoff.build({...c,includeTurns:$('handoff-turns').checked,maxWaypoints:Number($('handoff-limit').value)||8}):window.RouteHandoffSingle.plan({...c,candidates:data.handoffCandidates||[],originAddress:home,...(pref?{selectedIndices:pref.selectedIndices,useOriginal:true}:{})});
    return {...result,valid:segmented?true:result.valid,segmented,routeId:c.r.id,fingerprint:fp,signature:JSON.stringify([c.r.id,c.name,c.road,c.controls,c.routeState,home,$('handoff-mode').value,$('handoff-turns').checked,$('handoff-limit').value,pref]),name:c.name,preview:c.preview,road:c.road,roadText:c.roadText,journeyText:c.journeyText,metrics:(c.road.distanceMeters/1000).toFixed(2)+' km · '+(isHybridRoad(c.road)?'分段混合估計 ':'道路模型 ')+secondsText(c.road.durationSeconds)};
  }
  function setHandoffSelection(indices){
    const c=handoffContext(),fp=window.RouteHandoffSingle.fingerprint(c.road,c.controls);
    handoffPrefs=handoffPrefs.filter(x=>x.fingerprint!==fp);if(indices!==null)handoffPrefs.push({fingerprint:fp,selectedIndices:[...indices]});handoffPrefs=handoffPrefs.slice(-20);
    let saved=true;try{localStorage.setItem(handoffPrefKey,JSON.stringify(handoffPrefs));}catch(_){saved=false;}
    renderHandoff();if(!saved)$('handoff-copy-status').textContent='選點已更新；瀏覽器無法保存這項匯出偏好，重開後可能需再選一次。原路線未變更。';
  }
  function clearHandoffMap(){if(handoffMap){handoffMap.remove();handoffMap=null;}$('handoff-map').replaceChildren();}
  function drawHandoffMap(result){
    clearHandoffMap();if(!result?.road)return;
    if(!window.L){$('handoff-map').append(node('p',null,'底圖未載入；下方仍列出完整路名及導航途經點。'));return;}
    handoffMap=L.map($('handoff-map'),{minZoom:3,maxZoom:20,scrollWheelZoom:false,preferCanvas:true});
    addGlobalTilesV28(handoffMap);
    const path=result.road.path.map(p=>[p.lat,p.lng]);L.polyline(path,{color:'#1565c0',weight:5,opacity:.85}).addTo(handoffMap);
    const anchors=result.segmented?result.anchors:(result.anchors||[]);
    anchors.forEach((a,i)=>{const text=i===0?'起':i===anchors.length-1?'終':String(i),el=node('span','handoff-map-label',text),icon=L.divIcon({html:el,className:'handoff-map-icon',iconSize:[27,27],iconAnchor:[14,14]});L.marker([a.lat,a.lng],{icon,keyboard:true,title:text+' '+a.label}).bindTooltip(node('span',null,text+' '+a.label)).addTo(handoffMap);});
    handoffMap.fitBounds(L.latLngBounds([...path,...anchors.map(a=>[a.lat,a.lng])]),{padding:[30,30]});handoffMap.invalidateSize();
  }
  function renderHandoffChoices(result){
    const choices=$('handoff-choices');choices.replaceChildren();$('handoff-choice-panel').hidden=result.segmented;
    if(result.segmented)return;
    $('handoff-choice-count').textContent=result.sourceType==='candidate'?'8／8 個關鍵途經點（已查核候選）':(result.selectedIndices||[]).length+'／8 個中途點';
    $('handoff-customize').hidden=result.sourceType!=='candidate';$('handoff-customize').textContent='改選原路線點位（會重設候選）';$('handoff-reset').hidden=!handoffPrefs.some(p=>p.fingerprint===result.fingerprint);
    if(result.sourceType==='candidate'){
      (result.anchors||[]).slice(1,-1).forEach((a,i)=>choices.append(node('li',null,(i+1)+'. '+a.label)));
    }else{
      (result.choices||[]).forEach(c=>{const row=node('label','handoff-choice'),input=node('input');input.type='checkbox';input.checked=!!c.selected;input.disabled=!!c.required;input.setAttribute('aria-label','導航途經點 '+c.label);input.addEventListener('change',()=>{const current=handoffCurrent(),next=new Set(current.selectedIndices||[]);if(input.checked)next.add(c.index);else next.delete(c.index);if(next.size>8){input.checked=false;$('handoff-choice-count').textContent='已達 8 個：先取消一點，再選另一點。';return;}setHandoffSelection([...next]);});row.append(input,node('span',null,c.label+(c.required?'（必經，保留）':'')));choices.append(row);});
    }
    const omitted=result.omitted||[];$('handoff-omitted').textContent=omitted.length?'未另設中途點：'+omitted.map(x=>typeof x==='string'?x:x.label||String(x.index)).join('、')+'。這些仍留在原路線；Google 是否經過需核對。':'原路線資料完整保留；這裡只調整交給 Google 的定位點。';
  }
  function renderHandoff(){
    uxResetCopy();
    handoffSnapshot=null;clearHandoffMap();const box=$('google-route-parts');box.replaceChildren();$('handoff-copy-status').textContent='';$('handoff-manual').hidden=true;$('handoff-manual').open=false;$('handoff-copy').disabled=true;$('handoff-text').value='';$('handoff-open').hidden=true;$('handoff-open').removeAttribute('href');$('handoff-choice-panel').hidden=true;$('handoff-original-text').textContent='';$('handoff-plan-note').textContent='';$('handoff-segment-options').hidden=$('handoff-mode').value!=='segments';
    try{
      const result=handoffCurrent();handoffSnapshot=result;
      $('handoff-title').textContent=result.name;$('handoff-summary').textContent=result.valid?(result.segmented?result.anchors.length+' 個約束位置 · '+result.parts.length+' 段導航':'完整起點 → 終點 · '+(result.anchors.length-2)+' 個中途點 · 1 個 Google 連結'):'選好中途點，即可產生一個完整導航連結';
      $('handoff-original-metrics').textContent='原設定路線：'+result.metrics+(result.preview?'（未保存預覽）':'');
      $('handoff-plan-note').textContent=result.segmented?'進階分段：保留全部約束位置，到各段終點後需開下一段。':result.notice||'Google 依所選途經點重新計算；下圖保留原設定道路供比對。';
      $('handoff-error').hidden=result.valid;$('handoff-error').textContent=result.reason||'';$('handoff-copy').disabled=!result.valid;$('handoff-copy').textContent=result.segmented?'複製 LINE 文字＋分段連結':'複製到 LINE';
      $('handoff-map-note').textContent='藍線＝原設定道路；編號＝交給 Google 的定位點。此圖不是 Google 重算結果。';
      $('handoff-original-text').textContent='路名順序：'+result.roadText+'\n\n'+result.journeyText;
      renderHandoffChoices(result);
      if(result.valid){$('handoff-text').value=result.text;
        if(!result.segmented){const a=$('handoff-open');a.href=result.parts[0].url;a.hidden=false;}
        const displayed=result.segmented?result.parts:[];
        displayed.forEach(part=>{const card=node('section','handoff-part'),title=node('h3',null,'第 '+part.index+'／'+part.total+' 段'),list=node('ol');part.anchors.forEach((a,i)=>list.append(node('li',null,(i===0?'起點：':i===part.anchors.length-1?'終點：':'經過：')+a.label)));const row=node('div','handoff-actions'),link=node('a','btn','Google Maps 開啟第 '+part.index+' 段 ↗');link.href=part.url;link.target='_blank';link.rel='noopener noreferrer';const copy=node('button',null,'複製這段＋連結');copy.addEventListener('click',()=>void copyHandoff(part.index));row.append(link,copy);card.append(title,list,row);box.append(card);});
      }
      if($('google-route-dialog').open)drawHandoffMap(result);
    }catch(error){$('handoff-title').textContent='手機導航／LINE';$('handoff-summary').textContent='';$('handoff-original-metrics').textContent='';$('handoff-error').hidden=false;$('handoff-error').textContent=cleanError(error);}
  }
  function openGoogleRouteV24(){renderHandoff();showDialog('google-route-dialog');drawHandoffMap(handoffSnapshot);}
  function refreshHandoff(){if($('google-route-dialog').open)renderHandoff();}
  function uxResetCopy(){
    ux.copyToken++;ux.copyPending=false;clearTimeout(ux.copyTimer);
    const b=$('handoff-copy');if(b){b.classList.remove('ux-copy-success','ux-copy-error');b.removeAttribute('aria-busy');}
    $('handoff-open')?.classList.remove('ux-opened');
    if($('handoff-open'))$('handoff-open').textContent='開啟 Google Maps ↗';
  }
  function uxCopyLabel(){return handoffSnapshot?.segmented?'複製 LINE 文字＋分段連結':'複製到 LINE';}
  async function copyHandoff(partIndex=null){
    if(ux.copyPending||!handoffSnapshot?.valid)return false;
    let fresh;try{fresh=handoffCurrent();}catch(_){renderHandoff();return false;}
    if(fresh.signature!==handoffSnapshot.signature){renderHandoff();$('handoff-copy-status').textContent='路線已更新，請核對後再複製。';return false;}
    const old=handoffSnapshot,text=partIndex===null?old.text:old.parts.find(p=>p.index===partIndex)?.text;if(!text)return false;
    const token=++ux.copyToken,b=$('handoff-copy');ux.copyPending=true;clearTimeout(ux.copyTimer);
    const current=()=>{try{return token===ux.copyToken&&$('google-route-dialog').open&&handoffSnapshot===old&&handoffCurrent().signature===old.signature;}catch(_){return false;}};
    b.classList.remove('ux-copy-success','ux-copy-error');b.disabled=true;b.setAttribute('aria-busy','true');b.textContent='複製中…';$('handoff-copy-status').textContent='';
    try{
      if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(text);
      if(!current())return false;
      $('handoff-text').value=text;$('handoff-manual').hidden=true;b.classList.add('ux-copy-success');b.textContent='✓ 已複製';
      $('handoff-copy-status').textContent='已複製，可貼到 LINE。';
      ux.copyTimer=setTimeout(()=>{if(current()){b.classList.remove('ux-copy-success');b.textContent=uxCopyLabel();$('handoff-copy-status').textContent='';}},3000);
      return true;
    }catch(_){
      if(!current())return false;
      $('handoff-text').value=text;$('handoff-manual').hidden=false;$('handoff-manual').open=true;
      b.classList.add('ux-copy-error');b.textContent='再試一次複製';$('handoff-copy-status').textContent='無法自動複製，請在下方選取文字後複製。';return false;
    }finally{if(token===ux.copyToken){ux.copyPending=false;b.disabled=!handoffSnapshot?.valid;b.removeAttribute('aria-busy');}}
  }

  function renderRouteText(){renderRouteTextBeforeHandoffV172();refreshHandoff();wbRenderJourney();}
  function bindHandoff(){
    $('handoff-mode').value='single';$('handoff-limit').value='8';$('handoff-turns').checked=false;
    $('journey-handoff').addEventListener('click',openGoogleRoute);$('toolbar-handoff').addEventListener('click',openGoogleRoute);
    for(const id of ['handoff-mode','handoff-limit','handoff-turns'])$(id).addEventListener('change',renderHandoff);
    $('handoff-customize').addEventListener('click',()=>{const p=handoffCurrent();setHandoffSelection(p.sourceType==='candidate'?(p.selectedIndices||[]):(p.choices||[]).filter(c=>c.required).map(c=>c.index));});
    $('handoff-reset').addEventListener('click',()=>setHandoffSelection(null));
    $('handoff-open').addEventListener('click',e=>{try{if(!handoffSnapshot?.valid||handoffCurrent().signature!==handoffSnapshot.signature){e.preventDefault();renderHandoff();$('handoff-copy-status').textContent='路線已更新，請核對後再開啟導航。';}}catch(_){e.preventDefault();renderHandoff();}});
    $('handoff-copy').addEventListener('click',()=>void copyHandoff());$('handoff-close').addEventListener('click',()=>closeDialog('google-route-dialog'));
    $('google-route-dialog').addEventListener('close',()=>{handoffSnapshot=null;clearHandoffMap();});
  }

    // Inserted inside PlannerUI's closure; inspection never writes route/library data.
  const guide={follow:false,heading:null,requestPoint:null,source:'none',context:null,model:null,road:null,routeId:null,focusKey:null};
  const SG=window.StreetGuideGeometry;
  function guideRoad(){const road=roadPresentation(currentRoute());if(guide.road!==road||guide.routeId!==state.routeId){guide.road=road;guide.routeId=state.routeId;guide.model=SG.build(road);}return guide.model;}
  function guideLocation(p){const model=guideRoad(),hit=SG.nearest(model,p);if(!hit||hit.distance>35)return {model,hit:null,info:null};return {model,hit,info:SG.context(model,hit)};}
  function guideHeading(p){const {hit,info}=guideLocation(p);return hit&&!hit.ambiguous?info.heading:null;}
  function guideRequested(p,heading=null,source='selected') {guide.requestPoint=coord(p);guide.heading=Number.isFinite(heading)?((heading%360)+360)%360:null;guide.source=source;guide.focusKey=null;}
  function guideRecenter(){const p=guide.requestPoint||coord(state.selection);if(!p)return;const map=state.maps.leaflet;if(map)map.setView(p,map.getZoom(),{animate:false});guideUpdate();}
  function guideUpdate(){
    if(!$('guide-position'))return;
    const p=guide.requestPoint||coord(state.viewer)||coord(state.selection),{model,hit,info}=guideLocation(p);
    const active=!!hit&&!hit.ambiguous,hasSteps=active&&model.steps.length>0;
    guide.context={model,hit,info,p};
    $('guide-position').textContent=!p?'先點地圖或路線':active?(info.step?.road||'路線位置'):'所選位置';
    $('guide-progress').textContent=!p?'':active?'第 '+(info.index+1)+' / '+model.steps.length+' 步 · 路線向'+SG.compass(info.heading):hit?.ambiguous?'此處路線重疊，請點文字步驟附近的道路':'不在目前路線附近';
    $('guide-next-note').textContent=!p?'選點後，可用下方按鈕沿路查看。':active?(info.next?'約 '+Math.round(info.toNext)+' 公尺後：'+info.next.instruction:'已到路線終點'):hit?.ambiguous?'無法確定所在趟次，沿路移動暫停。':'先點目前的藍色路線，才可沿路前後查看。';
    $('guide-source').textContent=guide.source==='station'?'位置是收錄拍點；鏡頭移動後無法讀回。':'位置是地圖選點；Google 可能顯示附近拍點。';
    $('guide-heading').textContent=Number.isFinite(guide.heading)?'要求街景朝向'+SG.compass(guide.heading)+' '+Math.round(guide.heading)+'°；非即時鏡頭':'目前鏡頭朝向未知；實線箭頭僅表示路線方向。';
    $('guide-follow').setAttribute('aria-pressed',String(guide.follow));$('guide-follow').textContent=guide.follow?'自動跟隨選點：開':'自動跟隨選點：關';
    $('guide-back').disabled=!active||hit.along<.8;$('guide-forward').disabled=!active||hit.along>=model.total-.8;
    $('guide-prev').disabled=!hasSteps||hit.along<.8;$('guide-next').disabled=!hasSteps||hit.along>=model.total-.8;
    $('guide-face-route').disabled=!active||!Number.isFinite(info.heading);$('guide-recenter').disabled=!p;
    $('guide-turn-left').disabled=!p;$('guide-turn-right').disabled=!p;
    $('guide-map-status').textContent=!p?'點路線查看位置':(active?'查看：'+(info.step?.road||'路線位置'):'查看：所選位置')+' · '+(guide.follow?'沿路移動時跟隨':'保留地圖視角');
    $('guide-map-status').title='只代表本工具選定位置，不是即時 GPS 或嵌入街景內移動後的位置。';
    const cards=[...$('steps-list').querySelectorAll('.step-card')];cards.forEach((card,i)=>{card.classList.toggle('guide-active',active&&i===info.index);if(active&&i===info.index)card.setAttribute('aria-current','step');else card.removeAttribute('aria-current');});
    const focusKey=state.routeId+':'+(active?info.index:-1);
    if(guide.focusKey!==focusKey){guide.focusKey=focusKey;const card=active?cards[info.index]:null,box=$('steps-list');if(card&&box){const rect=card.getBoundingClientRect(),parent=box.getBoundingClientRect();box.scrollTop+=rect.top-parent.top-8;}}
    wbSyncSelection();
  }
  function drawViewerMarker(){
    for(const m of state.viewMarkers)m.remove?.();state.viewMarkers=[];
    guideUpdate();const p=guide.requestPoint||coord(state.viewer)||coord(state.selection),map=state.maps.leaflet;if(!p||!map)return;
    const {hit,info}=guide.context||{};
    const wrap=node('div','guide-marker-inner'),dot=node('span','guide-marker-dot',workbenchV26.ready&&workbenchV26.selected>=0?'選 '+(workbenchV26.selected+1):'選');
    if(Number.isFinite(guide.heading)){const cone=node('span','guide-cone');cone.style.transform='rotate('+guide.heading+'deg)';wrap.append(cone);}
    if(hit&&!hit.ambiguous&&Number.isFinite(info.heading)){const arrow=node('span','guide-route-arrow','▲');arrow.style.transform='rotate('+info.heading+'deg)';wrap.append(arrow);}
    wrap.append(dot);
    const marker=L.marker(p,{icon:L.divIcon({className:'guide-marker',html:wrap,iconSize:[42,42],iconAnchor:[21,21]}),interactive:false,zIndexOffset:2400}).addTo(map);
    marker.bindTooltip('選點位置；實線箭頭＝路線方向，要求街景朝向。街景內移動不會同步。');state.viewMarkers.push(marker);
  }
  function guideInspect(p,label){
    // Bypass editing handlers deliberately: viewing must not insert/move a waypoint.
    selectLocationV9(p,{label});$('selected-position').classList.remove('visible');
    guideFollowIfOutside();guideUpdate();
  }
  function guideMove(delta,kind='meters'){
    guideUpdate();const {model,hit}=guide.context||{};if(!hit||hit.ambiguous)return false;
    const next=kind==='step'?SG.stepTarget(model,hit.along,delta):hit.along+delta,p=SG.at(model,next);
    const info=SG.context(model,p);guideInspect(p,(info.step?.road||'沿路查看')+' · 沿路位置');return true;
  }
  function guideAim(delta){const p=guide.requestPoint||coord(state.selection);if(!p)return;const heading=delta==='route'?guideHeading(p):((guide.heading??guideHeading(p)??0)+delta+360)%360;showLegacyStreet(p,{heading});drawViewerMarker();}
  function bindStreetGuide(){
    $('guide-prev').addEventListener('click',()=>guideMove(-1,'step'));$('guide-next').addEventListener('click',()=>guideMove(1,'step'));
    $('guide-back').addEventListener('click',()=>guideMove(-30));$('guide-forward').addEventListener('click',()=>guideMove(30));
    $('guide-recenter').addEventListener('click',guideRecenter);$('guide-face-route').addEventListener('click',()=>guideAim('route'));
    $('guide-turn-left').addEventListener('click',()=>guideAim(-90));$('guide-turn-right').addEventListener('click',()=>guideAim(90));
    $('guide-follow').addEventListener('click',()=>{guide.follow=!guide.follow;guideFollowIfOutside();guideUpdate();});
    $('guide-details').addEventListener('toggle',resizeMaps);
    state.maps.leaflet?.on('dragstart',()=>{guide.follow=false;guideUpdate();});
    const container=$('leaflet-map');container.addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){guide.follow=false;guideUpdate();}});
    $('guide-reset').addEventListener('click',()=>{if(guide.requestPoint){showLegacyStreet(guide.requestPoint,{heading:guide.heading});drawViewerMarker();}});
    guideUpdate();
  }

function guideFollowIfOutside(){const map=state.maps.leaflet,p=guide.requestPoint;if(guide.follow&&map&&p&&!map.getBounds().pad(-.12).contains(p))map.panTo(p,{animate:false});}

    // One UX controller; existing routing and persistence remain authoritative.
  const ux={ready:false,tab:'library',scroll:{library:0,edit:0},expanded:{},activeStop:{},routeKey:'',copyToken:0,copyPending:false,copyTimer:null,openTimer:null,streetTimer:null};
  function uxCancelStreetFrame(){clearTimeout(ux.streetTimer);ux.streetTimer=null;}
  function uxQueueStreetFrame(frame,url){
    // Map selection is immediate; only the last rapid selection loads imagery.
    uxCancelStreetFrame();frame.hidden=true;
    ux.streetTimer=setTimeout(()=>{frame.src=url;frame.hidden=false;ux.streetTimer=null;},160);
  }
  function uxHasDraft(){return !!(stopLookup||clickEdit||roadPreview||mapEdit);}
  function uxSetTab(tab){
    if(!ux.ready||!['library','edit'].includes(tab))return;
    const body=document.querySelector('.side-body');ux.scroll[ux.tab]=body.scrollTop;ux.tab=tab;
    for(const key of ['library','edit']){$('ux-'+key+'-view').hidden=key!==tab;const b=$('ux-tab-'+key);b.setAttribute('aria-selected',String(key===tab));b.tabIndex=key===tab?0:-1;}
    body.scrollTop=ux.scroll[tab];uxRefresh();
  }
  function uxEditRoute(id){if(id!==state.routeId){selectRoute(id);if(state.routeId!==id)return false;}uxSetTab('edit');return startAdjust();}
  function uxDecorateStops(){
    const list=$('route-stops'),rows=[...list.querySelectorAll('.route-stop-row')],n=rows.length;
    list.classList.toggle('ux-expanded',!!ux.expanded[state.routeId]);
    let toggle=$('ux-vias-toggle');if(!toggle){toggle=node('button','ux-vias-toggle');toggle.id='ux-vias-toggle';toggle.addEventListener('click',()=>{ux.expanded[state.routeId]=!ux.expanded[state.routeId];uxDecorateStops();});}
    toggle.textContent='途經點（'+Math.max(0,n-2)+'） '+(ux.expanded[state.routeId]?'收合 ▴':'展開 ▾');toggle.hidden=n<3;toggle.setAttribute('aria-expanded',String(!!ux.expanded[state.routeId]));
    if(rows.length)rows[0].after(toggle);
    rows.forEach((row,i)=>{
      const middle=i>0&&i<n-1;row.classList.toggle('ux-middle-stop',middle);row.classList.toggle('ux-endpoint-stop',!middle);row.classList.toggle('ux-point-active',ux.activeStop[state.routeId]===i||!middle);
      row.hidden=middle&&!ux.expanded[state.routeId];
      if(middle&&!row.querySelector('.ux-stop-summary')){const b=node('button','ux-stop-summary');b.addEventListener('click',()=>{ux.activeStop[state.routeId]=ux.activeStop[state.routeId]===i?null:i;uxDecorateStops();});row.prepend(b);}
      const b=row.querySelector('.ux-stop-summary');if(b){b.textContent='P'+(i+1)+' · '+(row.querySelector('input')?.value||'途經點');b.setAttribute('aria-expanded',String(ux.activeStop[state.routeId]===i));}
    });
  }
  function uxDecorateRoutes(){
    for(const row of $('route-list').children){
      const actions=row.querySelector('.library-actions');if(actions&&!actions.closest('details')){const d=node('details','ux-route-more'),s=node('summary',null,'更多操作');d.append(s,actions);row.append(d);}
      const card=row.querySelector('.route-card');row.hidden=!!$('ux-filter').value&&!String(card?.textContent||'').toLocaleLowerCase().includes($('ux-filter').value.trim().toLocaleLowerCase());
    }
    const visible=[...$('route-list').children].filter(x=>!x.hidden).length;$('ux-route-count').textContent=visible+' 條路線';
  }
  function uxRefreshV24(){
    if(!ux.ready)return;
    const routes=allRoutes(),key=JSON.stringify(routes.map(r=>[r.id,routeCaption(r)]));
    if(key!==ux.routeKey){ux.routeKey=key;const select=$('ux-route-select');select.replaceChildren();for(const r of routes){const o=node('option',null,routeCaption(r));o.value=r.id;select.append(o);}}
    $('ux-route-select').value=state.routeId||'';$('ux-current-rename').disabled=!currentRoute();
    const r=currentRoute(),road=r&&roadPresentation(r),draft=uxHasDraft();
    $('ux-footer-metrics').textContent=road?kmLabel(road.distanceMeters)+' · '+(isHybridRoad(road)?'混合估計 ':'模型 ')+minuteLabel(road.durationSeconds):'尚未計算道路';
    $('ux-footer-metrics').title='目前顯示道路的模型估計，未完整計入尖峰、紅燈與待轉。';
    $('ux-footer-normal').hidden=draft;$('ux-footer-draft').hidden=!draft;
    $('ux-footer-edit').textContent=ux.tab==='edit'?'查看路線庫':'編輯路線';
    $('ux-footer-accept').disabled=roadPreview?.status!=='ready'||!!stopLookup;
    $('ux-footer-draft-note').textContent=mapEdit?'地圖改道，尚未採用':stopLookup?'正在選擇位置':roadPreview?.status==='loading'?'道路重算中…':roadPreview?.status==='error'?'計算失敗，原方案保留':'路線修改，尚未採用';
    uxDecorateRoutes();uxDecorateStops();
  }
  function bindUXV24(){
    const aside=document.querySelector('.sidebar'),head=aside.querySelector('.side-head'),body=aside.querySelector('.side-body'),sections=[...body.children],compare=$('compare-button');
    head.replaceChildren(node('h2',null,'我的路線'));const add=node('button',null,'＋ 新增');add.id='ux-new-route';head.append(add);
    const current=node('div','ux-current');current.innerHTML='<select id="ux-route-select" aria-label="目前路線"></select><button id="ux-current-rename" aria-label="改名目前路線">✎ 改名</button>';
    const tabs=node('div','ux-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','路線工作區');
    for(const [key,label]of [['library','路線庫'],['edit','編輯目前路線']]){const b=node('button',null,label);b.id='ux-tab-'+key;b.setAttribute('role','tab');b.setAttribute('aria-controls','ux-'+key+'-view');b.addEventListener('click',()=>uxSetTab(key));b.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const next=['ArrowLeft','Home'].includes(e.key)?'library':'edit';uxSetTab(next);$('ux-tab-'+next).focus();}});tabs.append(b);}
    body.before(current,tabs);const lib=node('div','ux-view'),edit=node('div','ux-view');lib.id='ux-library-view';edit.id='ux-edit-view';
    for(const [el,key]of [[lib,'library'],[edit,'edit']]){el.setAttribute('role','tabpanel');el.setAttribute('aria-labelledby','ux-tab-'+key);}
    const libtools=node('div','ux-library-tools'),filter=node('input');filter.id='ux-filter';filter.placeholder='搜尋我的路線';filter.setAttribute('aria-label','搜尋我的路線');libtools.append(filter,compare);lib.append(libtools);const count=node('p','muted');count.id='ux-route-count';lib.append(count);
    const librarySection=$('route-list').closest('section'),save=$('save-status'),retry=$('retry-save').parentElement;
    lib.append(librarySection);
    const more=node('details','ux-settings'),moreSummary=node('summary',null,'資料管理');more.append(moreSummary);
    const saveTools=node('section','section');saveTools.append(node('h3',null,'保存處理'),retry);more.append(saveTools);
    const mapPanel=$('map-edit-panel'),stops=$('stop-planner'),drag=body.querySelector('.drag-start');edit.append(mapPanel,stops);
    const mapButton=node('button','ux-map-adjust','在地圖上調整道路');mapButton.id='ux-map-adjust';mapButton.addEventListener('click',()=>startAdjust());edit.append(mapButton);
    const advanced=node('details','ux-settings');advanced.append(node('summary',null,'進階改道與模型'),drag);edit.append(advanced);
    for(const section of sections)if(section!==librarySection&&section!==mapPanel&&section!==stops&&section!==drag)more.append(section);
    body.replaceChildren(lib,edit,more);
    const footer=node('div','ux-sidebar-footer');footer.innerHTML='<strong id="ux-footer-metrics"></strong><div id="ux-footer-normal"><button id="ux-footer-edit">編輯路線</button><button id="ux-footer-handoff" class="primary">手機導航／LINE</button></div><div id="ux-footer-draft" hidden><p id="ux-footer-draft-note" role="status"></p><div><button id="ux-footer-accept" class="primary" disabled>採用修改</button><button id="ux-footer-cancel">取消</button></div></div>';
    footer.append(save);aside.append(footer);
    // One scroll surface for the modal. Actions occupy their own grid row.
    const dialog=$('google-route-dialog'),modalBody=dialog.querySelector('.handoff-body'),actions=modalBody.querySelector('.handoff-main-actions'),status=$('handoff-copy-status'),foot=node('div','ux-handoff-footer');foot.append(actions,status);dialog.append(foot);
    $('handoff-copy').setAttribute('aria-label','複製 LINE 文字與完整導航連結');$('handoff-open').setAttribute('aria-label','Google Maps 開啟完整導航');
    $('handoff-open').addEventListener('click',e=>{if(e.defaultPrevented)return;const b=$('handoff-open');b.classList.add('ux-opened');b.textContent='已送出開啟要求 ↗';clearTimeout(ux.openTimer);ux.openTimer=setTimeout(()=>{b.classList.remove('ux-opened');b.textContent='開啟 Google Maps ↗';},3000);});
    dialog.addEventListener('close',()=>{uxResetCopy();$('handoff-copy-status').textContent='';});
    $('ux-route-select').addEventListener('change',()=>selectRoute($('ux-route-select').value));filter.addEventListener('input',uxDecorateRoutes);
    $('ux-current-rename').addEventListener('click',()=>{if(currentRoute())renameRoute(state.routeId);});
    $('route-rename-dialog').addEventListener('close',()=>{$('ux-current-rename').focus({preventScroll:true});});
    $('route-rename-input').addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();$('save-route-name').click();}else if(e.key==='Escape'){e.preventDefault();closeDialog('route-rename-dialog');}});
    add.addEventListener('click',()=>{if(uxHasDraft()){toast('請先採用或取消目前修改，再新增路線。');return;}newCommute();});
    for(const id of ['new-commute','copy-route','import-routes'])$(id).addEventListener('click',e=>{if(uxHasDraft()){e.preventDefault();e.stopImmediatePropagation();toast('請先採用或取消目前修改，再執行這項操作。');}},true);
    for(const id of ['compare-button','mode-view'])$(id).addEventListener('click',e=>{if(uxHasDraft()){e.preventDefault();e.stopImmediatePropagation();toast('請先採用或取消目前修改，再執行這項操作。');}},true);
    $('ux-footer-handoff').addEventListener('click',openGoogleRoute);$('ux-footer-edit').addEventListener('click',()=>uxSetTab(ux.tab==='edit'?'library':'edit'));
    $('ux-footer-accept').addEventListener('click',()=>$(mapEdit?'map-edit-accept':'stop-accept').click());
    $('ux-footer-cancel').addEventListener('click',()=>productDiscard());
    const observer=new MutationObserver(()=>uxRefresh());for(const id of ['save-status','stop-state','stop-route-metrics'])observer.observe($(id),{childList:true,subtree:true,characterData:true});
    ux.ready=true;uxSetTab('library');uxRefresh();
  }

// Public browser persistence. One Web Lock serializes each shared key.
// Each write merges the tab's change against its previous view and the latest store.
// Route objects remain atomic: conflicting geometry is never field-by-field merged.
const PlannerStorageV28=(()=>{
  const copy=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  class Conflict extends Error{constructor(){super('另一個分頁已修改相同資料；本頁修改已保留，請下載備份再重新讀取。');this.kind='conflict';}}
  function choose(base,local,remote){
    if(equal(local,base))return copy(remote);
    if(equal(remote,base)||equal(local,remote))return copy(local);
    throw new Conflict();
  }
  function mergeMap(base={},local={},remote={}){
    const result={};
    for(const key of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])){
      if(['__proto__','constructor','prototype'].includes(key))throw new Error('不支援的資料欄位');
      const value=choose(base[key],local[key],remote[key]);
      if(value!==undefined)result[key]=value;
    }
    return result;
  }
  function mergeSet(base=[],local=[],remote=[]){
    const b=new Set(base),l=new Set(local),r=new Set(remote);
    return [...new Set([...remote,...local])].filter(k=>choose(b.has(k),l.has(k),r.has(k)));
  }
  function mergeLibrary(base,local,remote){
    const result=chooseFields(base,local,remote,new Set(['customRoutes','order','hidden','archived','presetNames','routeMeta','currentId']));
    const keyed=rows=>Object.fromEntries((rows||[]).map(r=>[r.id,r]));
    result.customRoutes=Object.values(mergeMap(keyed(base.customRoutes),keyed(local.customRoutes),keyed(remote.customRoutes)));
    result.hidden=mergeSet(base.hidden,local.hidden,remote.hidden);
    result.archived=mergeSet(base.archived,local.archived,remote.archived);
    result.presetNames=mergeMap(base.presetNames,local.presetNames,remote.presetNames);
    result.routeMeta=mergeMap(base.routeMeta,local.routeMeta,remote.routeMeta);
    // Additions/removals are merged; opposing reorders of common items conflict.
    const common=new Set((base.order||[]).filter(id=>local.order.includes(id)&&remote.order.includes(id)));
    const filtered=a=>a.filter(id=>common.has(id));
    const commonOrder=choose(filtered(base.order),filtered(local.order),filtered(remote.order));
    const orderChanged=!equal(filtered(base.order),filtered(local.order));
    const preferred=orderChanged?local.order:remote.order;
    const order=[...preferred,...local.order,...remote.order],valid=new Set([...result.customRoutes.map(r=>r.id),'A','B']);
    result.order=[...new Set(order)].filter(id=>valid.has(id));
    let cursor=0;result.order=result.order.map(id=>common.has(id)?commonOrder[cursor++]:id);
    // Selection belongs to a tab. It cannot cause a data conflict or remove a route.
    result.currentId=valid.has(local.currentId)?local.currentId:result.order[0]||null;
    return result;
  }
  function chooseFields(base,local,remote,excluded){
    const result={};
    for(const k of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])){
      if(excluded.has(k))continue;const v=choose(base[k],local[k],remote[k]);if(v!==undefined)result[k]=v;
    }
    return result;
  }
  class Store{
    constructor({storage,locks,key,empty,decode,encode,merge,onChange=()=>{}}){
      Object.assign(this,{storage,locks,key,decode,encode,merge,onChange});
      this.pending=0;this.blocked=null;this.chain=Promise.resolve();this.replaceRaw=undefined;
      this.recoveryKey=key+'-recovery-v28-'+Date.now()+'-'+Math.random().toString(36).slice(2);
      this.empty=copy(empty);this.lastUI=copy(empty);this.committed=copy(empty);
      try{const raw=storage.getItem(key);this.initialRaw=raw;this.lastUI=this.committed=this.read(raw);}
      catch(e){this.blocked='corrupt';this.error='既有資料無法讀取，已停止自動覆寫。請下載備份後還原有效備份。';this.preserve({originalRaw:this.initialRaw});}
    }
    read(raw=this.storage.getItem(this.key)){return raw===null?copy(this.empty):this.decode(raw);}
    preserve(payload){
      try{this.storage.setItem(this.recoveryKey,JSON.stringify({...payload,at:new Date().toISOString()}));return true;}
      catch(_){return false;}
    }
    save(value){
      value=copy(value);
      if(this.blocked){this.recoverySaved=this.preserve({originalRaw:this.initialRaw,base:this.failedBase,desired:value,reason:this.blocked});this.onChange();return false;}
      if(equal(value,this.lastUI)&&this.replaceRaw===undefined)return true;
      if(!this.locks?.request){this.blocked='unsupported';this.error='此瀏覽器無法安全協調多分頁保存，請下載備份並改用支援 Web Locks 的瀏覽器。';this.recoverySaved=this.preserve({desired:value});this.onChange();return false;}
      const base=copy(this.lastUI),replaceRaw=this.replaceRaw;this.replaceRaw=undefined;
      // Synchronous recovery journal survives closing before the async lock completes.
      if(!this.preserve({base,desired:value})){this.failedBase=base;this.failedValue=value;this.blocked='storage';this.error='瀏覽器空間不足或拒絕保存，請下載備份。';this.onChange();return false;}
      this.lastUI=value;this.pending++;this.onChange();
      this.chain=this.chain.then(()=>this.locks.request(this.key+'-writer-v28',async()=>{
        if(this.blocked)return;
        const raw=this.storage.getItem(this.key);
        let next;
        if(replaceRaw!==undefined){if(raw!==replaceRaw)throw new Conflict();next=value;}
        else next=this.merge(base,value,this.read(raw));
        const encoded=this.encode(next);this.decode(encoded);
        this.storage.setItem(this.key,encoded);this.committed=copy(next);
      })).catch(e=>{
        this.blocked=e.kind||'storage';this.error=e.message||'未儲存成功，請下載備份。';
        this.failedBase=base;this.failedValue=this.lastUI;
        this.recoverySaved=this.preserve({base,desired:this.lastUI,reason:this.blocked});
      }).finally(()=>{
        this.pending--;
        if(!this.pending&&!this.blocked){try{this.storage.removeItem(this.recoveryKey);}catch(_){}}
        this.onChange();
      });
      return true;
    }
    async flush(){do{const task=this.chain;await task;if(task===this.chain)break;}while(true);return !this.blocked;}
    adopt(){
      if(this.pending||this.blocked)return null;
      try{const next=this.read();this.lastUI=copy(next);this.committed=copy(next);return next;}
      catch(e){this.blocked='corrupt';this.error='另一個分頁的資料無法讀取，已停止自動覆寫。';this.onChange();return null;}
    }
    allowExplicitRestore(){
      if(this.pending)throw Error('請等保存結束再還原。');
      // Keep the recovery source even after an explicitly confirmed replacement.
      if(this.blocked)this.recoveryKey+='-restore-'+Date.now();
      this.replaceRaw=this.storage.getItem(this.key);this.blocked=null;
    }
    retry(){
      if(this.blocked!=='storage'||!this.failedBase||!this.failedValue)return false;
      this.blocked=null;this.lastUI=copy(this.failedBase);return this.save(this.failedValue);
    }
    recoveries(){
      const values={};
      for(let i=0;i<this.storage.length;i++){const k=this.storage.key(i);if(k?.startsWith(this.key+'-recovery-v28-'))values[k]=this.storage.getItem(k);}
      return values;
    }
  }
  return {Store,mergeLibrary,mergeMap,Conflict};
})();

  // Product state is separate from route transactions. No frame internals are read.
  const PRODUCT_PUBLIC=!!data.publicEdition;
  const PRODUCT_DRAFT_KEY=PRODUCT_PUBLIC?'route-workbench-public-drafts-v25':'route-workbench-private-drafts-v25';
  const product={ready:false,category:'saved',drafts:{},newIds:new Set(),draftOK:true,draftTimer:null,restorePending:false,importFile:null,newPlaces:[null,null],newSeq:[0,0],newControllers:[null,null],saveError:false};
  const productRoadCacheV28=new WeakMap();
  function productCachedRoadV28(r){
    // Stable identity while the saved road is unchanged; content-based invalidation
    // also handles in-place edits and equal timestamps. WeakMap avoids retaining routes.
    const key=JSON.stringify([r.roadRoute,r.editShape,r.points,r.waypoints]);
    const previous=productRoadCacheV28.get(r);
    if(previous?.key===key)return previous.value;
    const road=roadOf(r),value=road?{...road,path:r.editShape.nodes.map(coord),points:pointsOf(r)}:null;
    productRoadCacheV28.set(r,{key,value});return value;
  }
  try{const d=JSON.parse(localStorage.getItem(PRODUCT_DRAFT_KEY)||'{}');if(d&&typeof d==='object'&&!Array.isArray(d))product.drafts=d;}catch(_){}
  let publicLibraryV28=null,publicDraftsV28=null;
  if(PRODUCT_PUBLIC){
    publicLibraryV28=new PlannerStorageV28.Store({
      storage:localStorage,locks:navigator.locks,key:LIBRARY_KEY,empty:libraryPayload(),
      decode:raw=>{const e=JSON.parse(raw);if(e?.version!==10||!validLibrary(e.library))throw Error('路線庫格式無法辨識');return e.library;},
      encode:library=>JSON.stringify({version:10,dirty:false,serverRevision:0,library}),
      merge:PlannerStorageV28.mergeLibrary,onChange:productStorageChangedV28
    });
    publicDraftsV28=new PlannerStorageV28.Store({
      storage:localStorage,locks:navigator.locks,key:PRODUCT_DRAFT_KEY,empty:{},
      decode:raw=>{const d=JSON.parse(raw);if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length>100)throw Error('草稿格式無法辨識');return d;},
      encode:d=>{const raw=JSON.stringify(d);if(raw.length>1500000)throw Error('草稿大小超過保存上限');return raw;},
      merge:PlannerStorageV28.mergeMap,onChange:productStorageChangedV28
    });
  }
  function productStorageChangedV28(){
    if(!PRODUCT_PUBLIC||!publicLibraryV28||!publicDraftsV28)return;
    storageProduct.browserSaved=publicLibraryV28.blocked?false:publicLibraryV28.pending?null:true;
    product.draftOK=!publicDraftsV28.blocked;library.dirty=!!(publicLibraryV28.pending||publicLibraryV28.blocked);
    if(product.ready)productRefresh();
  }
  function productStorageBlockedV28(){return publicLibraryV28?.blocked||publicDraftsV28?.blocked;}
  function productStoragePendingV28(){return !!(publicLibraryV28?.pending||publicDraftsV28?.pending);}
  function productRecoveriesV28(){return PRODUCT_PUBLIC?{...publicLibraryV28.recoveries(),...publicDraftsV28.recoveries()}:{};}
  function productSyncPublicV28(){
    if(!PRODUCT_PUBLIC||uxHasDraft()||productStoragePendingV28()||productStorageBlockedV28())return;
    const oldId=state.routeId,latest=publicLibraryV28.adopt(),drafts=publicDraftsV28.adopt();
    if(!latest||!drafts)return;
    if(latest.customRoutes.some(r=>r.id===oldId))latest.currentId=oldId;
    applyLibrary(latest);publicLibraryV28.lastUI=clone(libraryPayload());product.drafts=drafts;render();
  }
  function productRecoveryDownloadV28(raw,key){
    try{
      const record=JSON.parse(raw),backup=productBackup();
      if(key.startsWith(LIBRARY_KEY)&&validLibrary(record.desired))backup.library=record.desired;
      else if(key.startsWith(PRODUCT_DRAFT_KEY)&&record.desired)backup.drafts=record.desired;
      const body=JSON.stringify(backup,null,2),url=URL.createObjectURL(new Blob([body],{type:'application/json'})),a=node('a');
      a.href=url;a.download='路線未保存副本-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(_){toast('此副本無法直接還原，請下載完整備份保留原始資料。');}
  }
  function productRenderRecoveriesV28(){
    const host=$('product-browser-recoveries');if(!host)return;host.replaceChildren();
    for(const [key,raw]of Object.entries(productRecoveriesV28())){
      const item=node('div');let at='';try{at=productLocalTime(JSON.parse(raw).at);}catch(_){}
      item.append(node('p',null,'未完成的保存副本 '+at+'；下載後可從匯入備份還原。'));
      const b=node('button',null,'下載這份副本');b.addEventListener('click',()=>productRecoveryDownloadV28(raw,key));item.append(b);host.append(item);
    }
  }
  function productConsent(){if(!PRODUCT_PUBLIC||product.sessionConsent)return true;try{return localStorage.getItem('route-workbench-location-consent')==='yes';}catch(_){return false;}}
  function ensureProductConsent(){if(productConsent())return true;showDialog('product-consent-dialog');return false;}
  function productRawRoutes(){return [...state.routes,...state.customRoutes];}
  function productMapCoord(value){
    if(!value||!Number.isFinite(value.lat)||!Number.isFinite(value.lng)||Math.abs(value.lat)>85)return null;
    return coord({lat:value.lat,lng:Math.abs(value.lng)<=180?value.lng:((value.lng+180)%360+360)%360-180});
  }
  function productRoutePicker(){
    const routes=allRoutes(),key=JSON.stringify(routes.map(r=>[r.id,routeCaption(r),productCategory(r)])),select=$('ux-route-select');
    if(product.pickerKey!==key||!select.querySelector('optgroup')){
      product.pickerKey=key;select.replaceChildren();
      for(const kind of ['saved','draft']){const rows=routes.filter(r=>productCategory(r)===kind);if(!rows.length)continue;const group=node('optgroup');group.label=kind==='saved'?'已儲存路線':'未完成草稿';for(const r of rows){const option=node('option',null,routeCaption(r)+(kind==='draft'?'〔草稿〕':''));option.value=r.id;group.append(option);}select.append(group);}
    }
    select.value=state.routeId||'';
  }
  function productMeta(id){library.routeMeta??={};return library.routeMeta[id]||{};}
  function libraryPayload(){return {...libraryPayloadV24(),archived:[...(library.archived||[])],routeMeta:clone(library.routeMeta||{}),productVersion:25};}
  function applyLibrary(payload){library.archived=Array.isArray(payload.archived)?[...payload.archived]:[];library.routeMeta=clone(payload.routeMeta||{});applyLibraryV24(payload);}
  function productLocalTime(value){if(!value)return '';const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}):'';}
  function productSaveState(){
    if(productStorageBlockedV28())return publicLibraryV28?.error||publicDraftsV28?.error||'未儲存成功・請下載備份';
    if(productStoragePendingV28())return '正在安全儲存…';
    if(!currentRoute())return '尚未選擇路線';
    if(storageProduct.browserSaved===false||!product.draftOK||product.saveError)return '未儲存成功・副本保留';
    if(roadPreview?.status==='loading')return '正在計算路線…';
    if(roadPreview?.status==='error')return '計算失敗・草稿已保留';
    if(roadPreview?.status==='ready')return '預覽完成・尚未儲存此走法';
    if(uxHasDraft())return '草稿已自動保存';
    if(persistence.blocked)return '版本衝突・請處理';
    if(!PRODUCT_PUBLIC&&!persistence.ready)return storageProduct.browserSaved?'僅此瀏覽器已保存・本機未連線':'本機未連線';
    if(persistence.saving||library.dirty&&!PRODUCT_PUBLIC)return '正在儲存…';
    if(!baselineRoad(currentRoute()))return '草稿・尚未計算';
    return '✓ 已儲存'+(PRODUCT_PUBLIC?'於此瀏覽器':'')+(productMeta(state.routeId).savedAt?'・'+productLocalTime(productMeta(state.routeId).savedAt):'');
  }
  function currentSaveLabel(){return productSaveState();}
  function saveLocal(){
    if(!PRODUCT_PUBLIC)return saveLocalV24();
    return publicLibraryV28.save(libraryPayload());
  }
  function storeRoutes(){
    if(!PRODUCT_PUBLIC){storeRoutesV24();productRefresh();return;}
    mutationEpoch++;saveLocal();refreshSaveBadge();productRefresh();
  }
  let personalFlushV28=null;
  async function flushLibrary(){
    if(PRODUCT_PUBLIC){saveLocal();await publicLibraryV28.flush();await publicDraftsV28.flush();productStorageChangedV28();return;}
    // All callers await the same writer, including changes queued while it is busy.
    if(!personalFlushV28){
      product.saveError=false;
      personalFlushV28=flushLibraryV24().finally(()=>{
        personalFlushV28=null;product.saveError=library.dirty&&!persistence.blocked&&!persistence.saving;productRefresh();
      });
    }
    return personalFlushV28;
  }
  function retrySave(){
    if(!PRODUCT_PUBLIC)return retrySaveV24();
    for(const store of [publicLibraryV28,publicDraftsV28])if(store.blocked&&!store.retry()){toast(store.error+' 可從管理下載副本，再重新讀取或還原備份。');return;}
    void flushLibrary();
  }
  async function reloadLibrary(){
    if(!PRODUCT_PUBLIC)return reloadLibraryV24();
    await publicLibraryV28.flush();await publicDraftsV28.flush();
    if((uxHasDraft()||productStorageBlockedV28())&&!window.confirm('將先下載本頁備份，再載入瀏覽器中最新的路線。尚未採用的修改不會覆蓋另一個分頁；是否繼續？'))return;
    if(uxHasDraft()||productStorageBlockedV28())exportLibrary();
    cancelDragEdit(false);state.mode='view';mapEditEnabled=false;
    publicLibraryV28.blocked=null;publicDraftsV28.blocked=null;productSyncPublicV28();productStorageChangedV28();
  }
  async function hydrateLibrary(){
    if(!PRODUCT_PUBLIC){await hydrateLibraryV12Legacy();}
    else{
      persistence.ready=false;library.dirty=false;
      try{const res=await fetch('/api/session',{cache:'no-store'});if(res.ok){const d=await res.json();persistence.csrf=d.csrf;}}catch(_){}
      productStorageChangedV28();render();
    }
    product.restorePending=true;
    if(product.ready){productRestoreDraft();productRefresh();}
  }
  function productWriteDrafts(){
    if(PRODUCT_PUBLIC){publicDraftsV28.save(product.drafts);return;}
    try{const raw=JSON.stringify(product.drafts);if(raw.length>1500000)throw Error();localStorage.setItem(PRODUCT_DRAFT_KEY,raw);product.draftOK=true;}
    catch(_){product.draftOK=false;}
  }
  function productCaptureDraft(){
    const r=currentRoute();if(!product.ready||!r||!uxHasDraft())return;
    let pts;try{pts=planningControls();}catch(_){return;}if(!Array.isArray(pts)||pts.length<2||pts.length>50)return;
    // Unconfirmed changes outside a map edit boundary must be reviewed again.
    const canRestoreResult=roadPreview?.status==='ready'&&(!mapEdit||!mapEdit.analysis?.outsideChanged||mapEdit.outsideAccepted);
    const next={version:25,base:fingerprint(r),points:clone(pts),profile:$('road-profile').value||'motorcycle',result:canRestoreResult?clone(roadPreview.result):null,newRoute:product.newIds.has(r.id),at:new Date().toISOString()};
    if(JSON.stringify({...product.drafts[r.id],at:null})===JSON.stringify({...next,at:null}))return;
    product.drafts[r.id]=next;
    productWriteDrafts();
  }
  function productRestoreDraft(){
    product.restorePending=false;const r=currentRoute(),d=r&&product.drafts[r.id];if(!r||!d||d.base!==fingerprint(r)||!Array.isArray(d.points)||d.points.length<2||d.points.length>50||d.points.some(p=>!coord(p)))return false;
    cancelDragEdit(false);state.mode='draw';clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'controls',basePoints:clone(controlsOf(r)),proposedPoints:clone(d.points),focusIndex:null,reason:'已恢復上次草稿'};
    if(d.newRoute)product.newIds.add(r.id);
    if(d.result)try{const result=validateRoadReply(d.result,d.points,d.profile);roadPreview={routeId:r.id,fingerprint:fingerprint(r),points:clone(d.points),profile:d.profile,status:'ready',result,error:null};}catch(_){}
    product.category=baselineRoad(r)?'saved':'draft';render();if(ux.ready)uxSetTab('edit');return true;
  }
  function productClearDraft(id){delete product.drafts[id];productWriteDrafts();}
  function render(){renderV24();refreshMapEditV27();if(product.ready){clearTimeout(product.draftTimer);productCaptureDraft();productRefresh();}}
  function uxRefresh(){uxRefreshV24();if(product.ready)productRefresh();}
  function selectRoute(id,options={}){
    if(id!==state.routeId&&uxHasDraft())productCaptureDraft();
    if(id!==state.routeId){cancelDragEdit(false);state.mode='view';}
    const result=selectRouteV24(id,options);if(product.ready)productRestoreDraft();return result;
  }
  function setMode(mode){if(mode==='view'&&uxHasDraft()){productCaptureDraft();cancelDragEdit(false);mapEditEnabled=false;state.mode='view';render();return;}return setModeV24(mode);}
  function productDiscard(){
    const id=state.routeId,wasNew=product.newIds.has(id);cancelDragEdit(false);mapEditEnabled=false;productClearDraft(id);
    if(wasNew){product.newIds.delete(id);state.customRoutes=state.customRoutes.filter(r=>r.id!==id);library.order=library.order.filter(x=>x!==id);delete library.routeMeta?.[id];state.routeId=allRoutes()[0]?.id||null;storeRoutes();}
    state.mode='view';render();product.category=currentRoute()&&!baselineRoad(currentRoute())?'draft':'saved';renderRouteList();refreshMapEditV27();
    toast(wasNew?'已放棄這個新草稿。':'已取消修改，回到上次儲存的走法。');
  }
  function confirmDragEdit(){return productSave();}
  function productSave(){
    const r=currentRoute();if(!r||roadPreview?.status!=='ready'||stopLookup){toast('先完成道路計算及位置確認。');return false;}
    if(!r.custom){$('product-save-name').value=routeCaption(r)+'・調整版';showDialog('product-save-dialog');return false;}
    return productCommit();
  }
  function productCommit(name=null){
    const before=state.routeId,epoch=mutationEpoch;confirmDragEditV24();
    if(epoch===mutationEpoch)return false;
    if(name&&currentRoute()){currentRoute().name=currentRoute().label=validName(name);}
    productClearDraft(before);product.newIds.delete(before);library.routeMeta??={};library.routeMeta[state.routeId]={...productMeta(state.routeId),savedAt:new Date().toISOString(),created:true};storeRoutes();product.category='saved';render();toast('✓ 路線已確認，完整走法與估時正在儲存。');return true;
  }
  function productCategory(r){return (library.archived||[]).includes(r.id)?'archive':baselineRoad(r)?'saved':'draft';}
  function renderRouteList(){
    if(!product.ready){renderRouteListV24();return;}
    const box=$('route-list');box.replaceChildren();const needle=normalizePlaceText($('ux-filter').value),visible=productRawRoutes().filter(r=>!library.hidden.includes(r.id)&&productCategory(r)===product.category);
    visible.sort((a,b)=>{const i=library.order.indexOf(a.id),j=library.order.indexOf(b.id);return (i<0?999:i)-(j<0?999:j);});
    for(const r of visible){if(needle&&!normalizePlaceText(routeCaption(r)).includes(needle))continue;const row=node('article','library-route'),button=node('button','route-card');button.setAttribute('aria-pressed',String(state.routeId===r.id));button.append(node('strong',null,routeCaption(r)));const m=routeMetrics(r),draft=product.drafts[r.id];button.append(node('small',null,baselineRoad(r)?kmLabel(m.dist)+' · '+(isHybridRoad(baselineRoad(r))?'混合估計 ':'模型 ')+minuteLabel(m.seconds):'草稿 · '+pointsOf(r).length+' 個位置'),node('small','muted',draft?'有尚未確認的修改':productMeta(r.id).savedAt?'已儲存 '+productLocalTime(productMeta(r.id).savedAt):baselineRoad(r)?'完整道路與逐步說明':'計算後可預覽、儲存'));
      button.disabled=product.category==='archive';button.addEventListener('click',()=>selectRoute(r.id));row.append(button);
      const more=node('details','ux-route-more');more.append(node('summary',null,'⋯ 更多操作'));const actions=node('div','library-actions');
      const operations=product.category==='archive'?[['恢復',()=>productRestore(r.id)],['移到回收區',()=>productTrash(r.id)]]:[['編輯',()=>{selectRoute(r.id);uxSetTab('edit');if(!uxHasDraft())startAdjust();}],['改名',()=>renameRoute(r.id)],['複製',()=>{selectRoute(r.id);copyCurrentRoute();}],['↑',()=>reorderRoute(r.id,-1)],['↓',()=>reorderRoute(r.id,1)],['封存',()=>productArchive(r.id)]];
      for(const [label,fn]of operations){const b=node('button',null,label);b.addEventListener('click',fn);actions.append(b);}more.append(actions);row.append(more);box.append(row);
    }
    if(!box.children.length){const empty=node('div','product-empty');empty.append(node('strong',null,needle?'找不到符合的路線':product.category==='saved'?'建立你的第一條路線':product.category==='draft'?'目前沒有草稿':'目前沒有封存路線'));if(product.category==='saved'&&!needle){const b=node('button','primary','＋ 建立路線');b.addEventListener('click',newCommute);empty.append(b);}box.append(empty);}
    const trash=$('route-trash');trash.replaceChildren();for(const id of library.hidden){const r=productRawRoutes().find(x=>x.id===id);if(!r)continue;const b=node('button',null,'恢復 '+routeCaption(r));b.addEventListener('click',()=>{library.hidden=library.hidden.filter(x=>x!==id);library.archived=(library.archived||[]).filter(x=>x!==id);storeRoutes();render();});trash.append(b);}$('trash-count').textContent=library.hidden.length+' 條';uxDecorateRoutes();productRefresh();
  }
  function productArchive(id){productCaptureDraft();library.archived=[...new Set([...(library.archived||[]),id])];if(id===state.routeId){cancelDragEdit(false);state.routeId=allRoutes()[0]?.id||null;}storeRoutes();render();toast('已封存，可從封存區恢復。');}
  function productRestore(id){library.archived=(library.archived||[]).filter(x=>x!==id);storeRoutes();product.category=productCategory(productRawRoutes().find(r=>r.id===id));render();}
  function productTrash(id){library.hidden=[...new Set([...library.hidden,id])];storeRoutes();render();}
  function productBackup(){return {version:25,exportedAt:new Date().toISOString(),library:libraryPayload(),presetRoutes:state.routes.filter(r=>baselineRoad(r)).map(r=>exportRoute({...routeWithResult(r,baselineRoad(r),controlsOf(r)),id:'P'+r.id,name:routeCaption(r)})),drafts:clone(product.drafts),browserRecovery:productRecoveriesV28(),preferences:{layout:clone(state.layout),journeyFontSize,journeyLayout:clone(journeyLayout),handoff:clone(handoffPrefs)}};}
  function exportLibrary(){const body=JSON.stringify(productBackup(),null,2),url=URL.createObjectURL(new Blob([body],{type:'application/json'})),a=node('a');a.href=url;a.download='我的路線備份-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function productRouteSignature(r){const out=exportRoute(r);delete out.id;return JSON.stringify(out);}
  function productValidateImport(p){
    const scan=(v,depth=0)=>{if(depth>18)throw Error('備份結構過深。');if(v&&typeof v==='object'){if(Array.isArray(v)&&v.length>2000)throw Error('備份項目過多。');for(const [k,x]of Object.entries(v)){if(['__proto__','constructor','prototype','password','apikey','csrf'].includes(k.toLowerCase()))throw Error('備份包含不支援的欄位。');scan(x,depth+1);}}};scan(p);
    if(![5,10,25].includes(p.version)||p.version===5&&(!Array.isArray(p.routes)||!p.routes.every(validSavedRoute))||p.version!==5&&!validLibrary(p.library))throw Error('無法辨識這份路線備份。');
    if(p.version!==5){if((p.library.archived||[]).some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(x)))throw Error('封存資料格式錯誤。');for(const value of Object.values(p.library.presetNames))if(typeof value!=='string'||value.length>160)throw Error('路線名稱格式錯誤。');}
    if(p.drafts&&(!p.drafts||typeof p.drafts!=='object'||Array.isArray(p.drafts)||Object.keys(p.drafts).length>100))throw Error('草稿備份格式錯誤。');return true;
  }
  async function importRoutes(file){if(!file)return;try{if(file.size>3500000)throw Error('備份須小於 3.5 MB。');const p=JSON.parse(await file.text());productValidateImport(p);product.importFile=p;$('product-import-summary').textContent='備份包含 '+(p.version===5?p.routes:p.library.customRoutes).length+' 條自訂路線。新增匯入會跳過相同內容；完整還原會取代目前路線庫與設定，並先下載目前備份。';$('product-restore').disabled=p.version===5;showDialog('product-import-dialog');}catch(e){toast(cleanError(e));}finally{$('import-file').value='';}}
  function productImport(mode){
    const p=product.importFile;if(!p)return false;if(uxHasDraft()){toast('先儲存或取消目前修改，再匯入。');return false;}
    if(PRODUCT_PUBLIC&&productStoragePendingV28()){toast('請等保存結束再匯入。');return false;}
    if(mode==='restore'){
      if(p.version===5||!window.confirm('完整還原會取代目前路線庫與設定。系統將先下載目前備份，是否繼續？'))return false;
      exportLibrary();const restored=clone(p.library),templates=Array.isArray(p.presetRoutes)?p.presetRoutes.filter(r=>['PA','PB'].includes(r.id)&&validSavedRoute(r)&&roadOf(r)):[];
      if(templates.length){const present=new Set(restored.customRoutes.map(x=>x.id));for(const r of templates)if(!present.has(r.id))restored.customRoutes.push(exportRoute(r));restored.order=[...templates.map(r=>r.id),...restored.order.filter(x=>!['A','B'].includes(x))];for(const key of ['hidden','archived'])restored[key]=(restored[key]||[]).map(id=>['A','B'].includes(id)&&!present.has('P'+id)?'P'+id:id);if(!PRODUCT_PUBLIC)restored.hidden=[...new Set([...restored.hidden,'A','B'])];if(['A','B'].includes(restored.currentId))restored.currentId='P'+restored.currentId;}
      if(PRODUCT_PUBLIC){publicLibraryV28.allowExplicitRestore();publicDraftsV28.allowExplicitRestore();}
      applyLibrary(restored);product.drafts=p.version===25&&p.drafts&&typeof p.drafts==='object'?clone(p.drafts):{};productWriteDrafts();
      const prefs=p.version===25?p.preferences:null;if(prefs){const l=prefs.layout||{};for(const [key,min,max]of [['left',210,430],['right',260,600],['street',25,100]])if(Number.isFinite(l[key]))state.layout[key]=Math.min(max,Math.max(min,l[key]));if(typeof l.collapsed==='boolean')state.layout.collapsed=l.collapsed;applyLayout();saveLayout();if(Number.isFinite(prefs.journeyFontSize))setJourneyFont(prefs.journeyFontSize);if(prefs.journeyLayout&&typeof prefs.journeyLayout.expanded==='boolean'&&Number.isFinite(prefs.journeyLayout.height)){journeyLayout={expanded:prefs.journeyLayout.expanded,height:Math.max(48,Math.min(2000,prefs.journeyLayout.height))};saveJourneyLayout();applyJourneyLayout();}if(Array.isArray(prefs.handoff)){handoffPrefs=prefs.handoff.filter(x=>x&&typeof x.fingerprint==='string'&&Array.isArray(x.selectedIndices)&&x.selectedIndices.length<=50&&x.selectedIndices.every(Number.isInteger)).slice(-20);try{localStorage.setItem(handoffPrefKey,JSON.stringify(handoffPrefs));}catch(_){}}}
    }else{
      const incoming=p.version===5?p.routes:p.library.customRoutes,known=new Set(state.customRoutes.map(productRouteSignature)),copies=[];let skipped=0;
      for(const r of incoming){const signature=productRouteSignature(r);if(known.has(signature)){skipped++;continue;}known.add(signature);const copy=exportRoute(r);copy.id=newRouteIdentity('I')+'-'+copies.length;copies.push(copy);}
      if(!capacityAvailable(copies.length))return false;state.customRoutes.push(...copies);library.order.push(...copies.map(r=>r.id));toast('已新增 '+copies.length+' 條，跳過 '+skipped+' 條相同路線。');
    }
    storeRoutes();closeDialog('product-import-dialog');product.importFile=null;render();return true;
  }
  function rankPlaces(rows,q){const query=normalizePlaceText(q),city=(q.match(/(?:臺|台)北|(?:臺|台)中|(?:臺|台)南|新北|桃園|高雄|基隆|新竹|嘉義|彰化|南投|宜蘭|花蓮|(?:臺|台)東|屏東|苗栗|雲林|澎湖|金門|連江/)||[])[0];const score=p=>(normalizePlaceText(p.name)===query?100:normalizePlaceText(p.name).startsWith(query)?60:0)+(city&&normalizePlaceText(p.address).includes(normalizePlaceText(city))?35:0)+(p.local?10:0);return rows.map((p,i)=>({p,i,s:score(p)})).sort((a,b)=>b.s-a.s||a.i-b.i).map(x=>x.p);}
  function searchRefinementV28(box,query,rows,fieldId,visible=true){
    let help=box.nextElementSibling;
    if(!help?.classList.contains('search-refinement-v28')){
      help=node('details','search-refinement-v28');box.insertAdjacentElement('afterend',help);
    }
    help.replaceChildren();help.hidden=!visible||!query||!!parseCoord(query);
    if(help.hidden)return;
    const exact=rows.some(p=>normalizePlaceText(p.name)===normalizePlaceText(query));
    help.append(node('summary',null,!rows.length?'找不到位置？試試其他寫法':exact?'搜尋結果與道路入口說明':'結果名稱不同？核對或重新搜尋'));
    help.append(node('p',null,'免費搜尋可能只有相近結果。可改用當地名稱＋城市、完整地址，或輸入「緯度,經度」；不會自動選取第一筆。'));
    help.append(node('p',null,'例如 Tokyo Station 可改查「東京駅」。車站建物、步行通道與樓梯不等於可騎乘入口，請配合街景與地圖核對。'));
    const edit=node('button',null,'修改搜尋文字');edit.type='button';edit.addEventListener('click',()=>{$(fieldId)?.focus();$(fieldId)?.select();});help.append(edit);
  }
  function productCancelNewSearch(index){
    product.newSeq[index]++;product.newControllers[index]?.abort();product.newControllers[index]=null;
  }
  async function productSearchNew(index){
    productCancelNewSearch(index);
    const field=$('product-new-'+index),q=field.value.trim(),box=$('product-new-results-'+index),seq=product.newSeq[index];
    product.newPlaces[index]=null;box.replaceChildren();searchRefinementV28(box,q,[],field.id,false);if(!q)return;
    const controller=new AbortController();product.newControllers[index]=controller;
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
    box.textContent='搜尋中…';
    try{
      const p=parseCoord(q);let rows=p?[{...p,name:q,address:'座標',kind:'coordinate'}]:localPlaceResults(q);
      if(!p&&!rows.some(r=>r.privateMatch)){
        if(!ensureProductConsent()){box.textContent='同意位置服務後再搜尋。';return;}
        let token=persistence.csrf;
        if(!token){const h=await fetch(PRODUCT_PUBLIC?'/api/session':'/api/routes',{signal:controller.signal});if(!h.ok)throw Error('規劃服務未就緒');token=(await h.json()).csrf;}
        const res=await fetch('/api/place-search',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':token,'X-Planner-Consent':productConsent()?'yes':'no'},body:JSON.stringify({query:q,scope:'world'}),signal:controller.signal});
        const a=await res.json();if(!res.ok)throw Error(a.message||'搜尋失敗');
        if(!Array.isArray(a.results))throw Error('搜尋結果格式不完整');
        rows=rankPlaces(uniquePlaces([...rows,...a.results.filter(coord)]),q);
      }
      if(seq!==product.newSeq[index])return;
      box.replaceChildren();
      for(const p of rows.slice(0,8)){
        const b=node('button','stop-result');b.type='button';
        b.append(node('strong',null,p.name),node('span',null,placeKind(p.kind)),node('span',null,p.address||'未提供地址'),node('small','muted',p.lat.toFixed(5)+', '+p.lng.toFixed(5)));
        b.addEventListener('click',()=>{productCancelNewSearch(index);product.newPlaces[index]=clone(p);field.value=p.name;box.replaceChildren(node('p','product-selected','✓ 已選：'+p.name+' · '+placeKind(p.kind)));searchRefinementV28(box,q,[],field.id,false);selectLocation(p,{viewOnly:true,label:p.name});});
        box.append(b);
      }
      if(!rows.length)box.textContent='找不到位置，可改用當地名稱加城市、完整地址或「緯度,經度」。';
      searchRefinementV28(box,q,rows,field.id);
    }catch(e){
      if(seq===product.newSeq[index])box.textContent=timedOut?'搜尋逾時，請再按搜尋重試。':cleanError(e)+'；請稍後重試。';
    }finally{clearTimeout(timer);if(product.newControllers[index]===controller)product.newControllers[index]=null;}
  }
  function newCommute(){for(let i=0;i<2;i++)productCancelNewSearch(i);if(uxHasDraft()){productCaptureDraft();cancelDragEdit(false);}product.newPlaces=[coord(state.home)?{...coord(state.home),name:state.home.address||'住家'}:null,coord(state.office)?{...coord(state.office),name:state.office.address||'公司'}:null];$('product-new-name').value='新路線';for(let i=0;i<2;i++){$('product-new-'+i).value=product.newPlaces[i]?.name||'';$('product-new-results-'+i).replaceChildren();searchRefinementV28($('product-new-results-'+i),'',[],'product-new-'+i,false);}$('product-new-error').textContent='';showDialog('product-new-dialog');}
  function productCreate(){
    if(!capacityAvailable())return false;const pts=product.newPlaces;if(pts.some(p=>!coord(p))){$('product-new-error').textContent='起點與終點都需要先搜尋並點選一筆結果。';return false;}if(distance(pts[0],pts[1])<1){$('product-new-error').textContent='起點與終點相同，請重新選擇。';return false;}
    const r={id:newRouteIdentity(),name:validName($('product-new-name').value).trim()||'新路線',custom:true,points:pts.map((p,i)=>({...coord(p),label:p.name,road:p.name,turnKind:i?'arrival':'start'})),keepDestination:true,workflow:{phase:'planning'},modelInputs:{}};
    state.customRoutes.push(r);library.order.push(r.id);state.routeId=r.id;product.newIds.add(r.id);storeRoutes();closeDialog('product-new-dialog');product.category='draft';uxSetTab('edit');state.mode='draw';clickEdit={routeId:r.id,fingerprint:fingerprint(r),kind:'recompute',basePoints:clone(r.points),target:null};productCaptureDraft();render();fitRoute();void requestRoadPreview();return true;
  }
  function renderPointLedger(r){const box=$('point-ledger');box.replaceChildren();const l=pointLedger(r);box.append(node('p',null,l.markedSignals||l.twoStageTurns?'已標號誌 '+l.markedSignals+' 處／待轉 '+l.twoStageTurns+' 次':'號誌與待轉尚未盤點'),node('p','muted','僅統計你標註的路口，不代表全程總數。'));}
  function openGoogleRoute(){if(!currentRoute()||!roadPresentation(currentRoute())){toast('先計算並確認路線，即可建立手機導航連結。');uxSetTab('edit');return;}return openGoogleRouteV24();}
  function productRefresh(){
    if(!product.ready)return;const r=currentRoute(),draft=uxHasDraft(),ready=roadPreview?.status==='ready',label=productSaveState();
    productRoutePicker();
    if($('save-status').textContent!==label)$('save-status').textContent=label;$('save-status').classList.toggle('product-error',label.includes('失敗')||!!persistence.blocked);$('save-status').classList.toggle('product-pending',draft||persistence.saving);
    $('ux-footer-draft-note').textContent=roadPreview?.status==='loading'?'正在計算；上次儲存的走法保留':roadPreview?.status==='error'?'計算失敗，可重試；草稿已保存':ready?'新走法尚未儲存':'草稿自動保存，確認後再儲存路線';
    $('ux-footer-accept').textContent=r&&!r.custom?'儲存為新路線':'儲存路線';$('ux-footer-accept').disabled=!ready||!!stopLookup;$('ux-footer-cancel').textContent=product.newIds.has(state.routeId)?'放棄草稿':'取消修改';
    $('ux-footer-handoff').disabled=!r||!baselineRoad(r);$('ux-footer-edit').disabled=!r;$('ux-footer-normal').hidden=draft;$('ux-footer-draft').hidden=!draft;
    for(const id of ['mode-draw','show-all-routes','toolbar-handoff','fit-route'])$(id).disabled=!r;$('compare-button').disabled=!productRawRoutes().some(x=>!library.hidden.includes(x.id));
    $('product-storage-note').textContent=PRODUCT_PUBLIC?'路線保存在這個瀏覽器，換裝置請下載／匯入備份。':'個人路線保存在本機與瀏覽器。';
    const caveat=$('product-route-caveat');if(caveat){const road=r&&baselineRoad(r);caveat.hidden=!road;caveat.textContent=isHybridRoad(road)?'混合估時；部分巷道機車通行仍須核對現場標誌。':'模型估時，未含完整尖峰、紅燈與待轉。';}
    const failed=storageProduct.browserSaved===false||!product.draftOK||persistence.blocked||library.dirty&&!persistence.saving||!!productStorageBlockedV28(); $('product-save-recovery').hidden=!failed;
    if(PRODUCT_PUBLIC&&!productStoragePendingV28()&&Object.keys(productRecoveriesV28()).length){$('product-storage-note').textContent+=' 有未完成的保存副本，請從「管理」下載恢復。';}
    const count={saved:0,draft:0,archive:0};for(const r of productRawRoutes())if(!library.hidden.includes(r.id))count[productCategory(r)]++;
    for(const key of Object.keys(count)){const b=$('product-category-'+key);if(b){b.textContent=({saved:'已儲存',draft:'草稿',archive:'封存'})[key]+' '+count[key];b.setAttribute('aria-pressed',String(product.category===key));}}
    if($('journey-state')&&r){$('journey-state').textContent=label;}wbRefreshChrome();
  }
  function bindProductV25(){
    const hidden=node('div');hidden.hidden=true;hidden.id='product-legacy';document.body.append(hidden);
    const more=document.querySelector('.side-body>.ux-settings');hidden.append(more);const lib=$('ux-library-view');const cats=node('div','product-categories');for(const [key,title]of [['saved','已儲存'],['draft','草稿'],['archive','封存']]){const b=node('button',null,title);b.id='product-category-'+key;b.addEventListener('click',()=>{product.category=key;renderRouteList();});cats.append(b);}lib.prepend(cats);
    const manage=node('button',null,'管理');manage.id='product-data';manage.title='備份、還原與回收區';manage.setAttribute('aria-label','備份與資料管理');document.querySelector('.side-head').append(manage);
    const edit=$('ux-edit-view');const advanced=edit.querySelector('.ux-settings');if(advanced){advanced.querySelector('summary').textContent='進階改道與估時設定';const model=$('time-components').closest('details');if(model)advanced.append(model);}
    const recalc=node('button','primary product-recalculate','計算／更新路線');recalc.id='product-recalculate';recalc.addEventListener('click',()=>void requestRoadPreview());edit.insertBefore(recalc,$('ux-map-adjust'));
    const storage=node('p','product-storage-note');storage.id='product-storage-note';document.querySelector('.ux-sidebar-footer').append(storage);
    const caveat=node('p','product-storage-note');caveat.id='product-route-caveat';document.querySelector('.ux-sidebar-footer').append(caveat);
    const recovery=node('div');recovery.id='product-save-recovery';recovery.innerHTML='<button id="product-save-retry">重試儲存</button><button id="product-save-export">下載備份</button><button id="product-save-reload">重新讀取</button>';document.querySelector('.ux-sidebar-footer').append(recovery);
    const dialogs=node('div');dialogs.innerHTML=`<dialog id="product-data-dialog"><div class="dialog-head"><h2>備份與資料管理</h2><button data-product-close="product-data-dialog" aria-label="關閉資料管理">×</button></div><div class="dialog-body"><p>備份包含路線、未完成草稿與偏好設定。檔案含位置資訊，請妥善保管。</p><button id="product-export" class="primary">下載完整備份</button><button id="product-import">匯入備份…</button><details id="product-trash"><summary>回收區</summary><div id="product-trash-host"></div></details><p id="product-data-scope"></p></div></dialog>
    <dialog id="product-import-dialog"><div class="dialog-head"><h2>匯入方式</h2><button data-product-close="product-import-dialog" aria-label="關閉匯入">×</button></div><div class="dialog-body"><p id="product-import-summary"></p><button id="product-merge" class="primary">新增匯入・跳過重複</button><button id="product-restore">完整還原備份</button></div></dialog>
    <dialog id="product-new-dialog"><div class="dialog-head"><h2>建立路線</h2><button data-product-close="product-new-dialog" aria-label="關閉建立路線">×</button></div><div class="dialog-body"><label>路線名稱<input id="product-new-name" maxlength="160"></label>${[0,1].map((i)=>`<label>${i?'終點':'起點'}<div class="product-new-search"><input id="product-new-${i}" placeholder="地名、地址或緯度,經度" maxlength="160"><button id="product-new-search-${i}">搜尋</button></div></label><div id="product-new-results-${i}" class="product-results"></div>`).join('')}<p id="product-new-error" role="status"></p><button id="product-create" class="primary">計算路線</button></div></dialog>
    <dialog id="product-save-dialog"><div class="dialog-head"><h2>儲存調整後的路線</h2><button data-product-close="product-save-dialog" aria-label="關閉另存">×</button></div><div class="dialog-body"><p>原方案保留，請為調整後的路線命名。</p><label>路線名稱<input id="product-save-name" maxlength="160"></label><button id="product-confirm-save" class="primary">儲存為新路線</button></div></dialog>
    <dialog id="product-consent-dialog"><div class="dialog-head"><h2>位置服務</h2><button data-product-close="product-consent-dialog" aria-label="關閉位置服務">×</button></div><div class="dialog-body"><p>搜尋會將輸入的地名／地址傳給 Photon；道路計算會將起終點及途經點座標傳給 Valhalla。街景由 Google、底圖預設由 OpenStreetMap 提供，會將查看範圍傳送至各自服務；網站可設定其他底圖供應商，來源顯示在地圖上。</p><p>路線保存在你的瀏覽器。此版本不提供即時交通、完整紅燈秒數或自動待轉合法性判斷。</p><button id="product-consent" class="primary">同意使用位置服務</button></div></dialog>`;
    document.body.append(dialogs);document.querySelectorAll('[data-product-close]').forEach(b=>b.addEventListener('click',()=>closeDialog(b.dataset.productClose)));
    const oldTrash=$('route-trash').closest('details');$('product-trash-host').append($('route-trash'));if(oldTrash)hidden.append(oldTrash);$('product-data-scope').textContent=PRODUCT_PUBLIC?'此瀏覽器的私人資料；不提供跨裝置自動同步。':'此電腦的個人資料；公開版不包含這些路線。';
    for(const id of ['product-export','product-save-export'])$(id).addEventListener('click',exportLibrary);$('product-save-retry').addEventListener('click',retrySave);$('product-save-reload').addEventListener('click',reloadLibrary);
    const recoveryList=node('div');recoveryList.id='product-browser-recoveries';$('product-data-dialog').querySelector('.dialog-body').append(recoveryList);
    $('product-data').addEventListener('click',()=>{productRenderRecoveriesV28();showDialog('product-data-dialog');});$('product-import').addEventListener('click',()=>$('import-file').click());$('product-merge').addEventListener('click',()=>productImport('merge'));$('product-restore').addEventListener('click',()=>productImport('restore'));
    $('product-confirm-save').addEventListener('click',()=>{const name=validName($('product-save-name').value).trim();if(!name){$('product-save-name').focus();return;}if(productCommit(name))closeDialog('product-save-dialog');});
    $('product-create').addEventListener('click',productCreate);for(let i=0;i<2;i++){$('product-new-search-'+i).addEventListener('click',()=>productSearchNew(i));$('product-new-'+i).addEventListener('input',()=>{productCancelNewSearch(i);product.newPlaces[i]=null;$('product-new-results-'+i).replaceChildren();searchRefinementV28($('product-new-results-'+i),'',[],'product-new-'+i,false);});$('product-new-'+i).addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();void productSearchNew(i);}});}
    $('product-new-dialog').addEventListener('close',()=>{for(let i=0;i<2;i++)productCancelNewSearch(i);});
    $('product-consent').addEventListener('click',()=>{product.sessionConsent=true;try{localStorage.setItem('route-workbench-location-consent','yes');}catch(_){toast('此次同意有效；瀏覽器無法保存設定，下次會再詢問。');}closeDialog('product-consent-dialog');});
    // Pointer/keyboard actions save transient drafts; a reload never promotes one.
    document.addEventListener('input',()=>{clearTimeout(product.draftTimer);product.draftTimer=setTimeout(productCaptureDraft,200);});window.addEventListener('pagehide',productCaptureDraft);
    window.addEventListener('beforeunload',e=>{productCaptureDraft();if(!product.draftOK||storageProduct.browserSaved===false||productStoragePendingV28()){e.preventDefault();e.returnValue='';}});
    window.addEventListener('storage',e=>{if(PRODUCT_PUBLIC&&[LIBRARY_KEY,PRODUCT_DRAFT_KEY].includes(e.key))productSyncPublicV28();});
    $('ux-filter').addEventListener('input',renderRouteList);
    const pickerLabel=node('label','product-picker-label','目前路線');pickerLabel.htmlFor='ux-route-select';document.querySelector('.ux-current').before(pickerLabel);
    const brand=document.querySelector('.brand-icon');if(brand){brand.textContent='';const img=node('img');img.src=PRODUCT_PUBLIC?'assets/icon.svg':'personal-assets/icon.svg';img.alt='';brand.append(img);}
    $('saved-routes').replaceChildren();$('ux-new-route').textContent='＋ 新增';$('ux-footer-accept').textContent='儲存路線';
    const key=$('key-dialog').querySelector('.dialog-body');const old=node('div');old.hidden=true;while(key.firstChild)old.append(key.firstChild);key.append(node('p',null,'機車路線依道路模型計算；實際禁行、轉向、紅燈與待轉請依現場標誌。'),node('p',null,'街景內移動及旋轉不會同步左側選點。Google 導航會依途經點重新計算，出發前請核對走法。'),node('p',null,'資料：Photon／OpenStreetMap、Valhalla／FOSSGIS、OpenStreetMap 底圖、Google。'),old);
    $('key-dialog').querySelector('h2').textContent='服務與資料來源';
    $('help-dialog').querySelector('.dialog-body').replaceChildren(node('p',null,'1. 新增路線並搜尋起終點。2. 點道路／步驟查看街景。3. 拖動途經點或藍線調整走法。4. 預覽公里、模型時間與完整文字後，按「儲存路線」。5. 用手機導航／LINE 複製連結。'),node('p',null,'修改會自動保留草稿；只有按儲存才會更新正式走法。可在路線庫切換已儲存、草稿及封存。'));
    $('help-dialog').querySelector('h2').textContent='如何規劃路線';
    if(PRODUCT_PUBLIC){for(const id of ['fit-city','search-home','search-office','reference-photo','toggle-stations','photo-mode','previous-station','next-station'])$(id).hidden=true;status('新增路線，搜尋起終點開始規劃。');}
    let previousRange=innerWidth>1100?'wide':innerWidth>760?'tablet':'phone';
    if(previousRange==='tablet'){state.layout.collapsed=true;applyLayout();}
    window.addEventListener('resize',()=>{const range=innerWidth>1100?'wide':innerWidth>760?'tablet':'phone';if(previousRange!==range&&range!=='phone'){state.layout.collapsed=range==='tablet';applyLayout();}previousRange=range;});
    product.ready=true;if(product.restorePending)productRestoreDraft();render();productRefresh();
    if(!PRODUCT_PUBLIC&&!baselineRoad(currentRoute()))product.category='draft';renderRouteList();
  }

// Shared global base layer for planning and navigation export. Tile requests are
// browser-native images: default cache headers/referrer, no bulk fetch or prefetch.
let mapConfigV28=null;
function globalMapConfigV28(){
  if(!mapConfigV28){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    mapConfigV28=fetch('/api/map-config',{cache:'no-store',signal:controller.signal}).then(async response=>{
    if(!response.ok)throw Error('底圖設定暫時無法讀取');
    const c=await response.json(),url=new URL(c.url),attribution=new URL(c.attributionUrl);
    if(url.protocol!=='https:'||attribution.protocol!=='https:'||url.username||url.password||typeof c.attribution!=='string'||!['{z}','{x}','{y}'].every(p=>c.url.includes(p)))throw Error('底圖設定格式不完整');
    return c;
    }).catch(e=>{mapConfigV28=null;throw Error(e.name==='AbortError'?'底圖設定讀取逾時':e.message);}).finally(()=>clearTimeout(timer));
  }
  return mapConfigV28;
}
function addGlobalTilesV28(map){
  const control=L.control({position:'bottomleft'}),box=node('div','global-map-status'),message=node('span',null,'正在載入道路底圖…'),retry=node('button',null,'重試底圖');
  box.setAttribute('role','status');retry.type='button';retry.hidden=true;box.append(message,retry);
  control.onAdd=()=>{L.DomEvent.disableClickPropagation(box);L.DomEvent.disableScrollPropagation(box);return box;};control.addTo(map);
  let tiles=null,failures=0,timer=null;
  const active=()=>Boolean(map.getContainer()?._leaflet_id);
  const failure=text=>{if(!active())return;box.hidden=false;message.textContent=text+'；路線與選點仍保留。';retry.hidden=false;};
  const loading=()=>{clearTimeout(timer);failures=0;box.hidden=false;message.textContent='正在載入道路底圖…';retry.hidden=true;timer=setTimeout(()=>failure('底圖連線較久'),20000);};
  const start=async()=>{
    loading();
    try{
      const config=await globalMapConfigV28();if(!active())return;
      const link=node('a',null,config.attribution);link.href=config.attributionUrl;link.target='_blank';link.rel='noopener noreferrer';
      tiles=L.tileLayer(config.url,{minZoom:3,maxZoom:20,maxNativeZoom:config.maxNativeZoom||19,
        attribution:link.outerHTML,referrerPolicy:'strict-origin-when-cross-origin',keepBuffer:1,updateWhenIdle:true});
      tiles.on('loading',loading);
      tiles.on('tileerror',()=>{failures++;failure('部分道路底圖載入失敗');});
      tiles.on('load',()=>{clearTimeout(timer);if(failures)failure('部分道路底圖載入失敗');else box.hidden=true;});
      tiles.addTo(map);
      if(map===state.maps.leaflet){$('map-provider-note').textContent=config.attribution;$('map-help').textContent='點地圖或路線查看街景；「選」是選取位置，非 GPS。';}
    }catch(e){clearTimeout(timer);failure(e.message||'底圖暫時無法載入');}
  };
  retry.addEventListener('click',()=>{if(tiles){loading();tiles.redraw();}else void start();});
  map.on('unload',()=>clearTimeout(timer));
  void start();return control;
}
function initGlobalMapV28(){
  if(!window.L){$('leaflet-map').replaceChildren(node('div','empty-map','地圖程式未載入。請重新整理；已保存路線仍保留。'));return;}
  $('leaflet-map').replaceChildren();
  const center=coord(state.home)||{lat:25.055,lng:121.49};
  const map=state.maps.leaflet=L.map($('leaflet-map'),{center,zoom:13,worldCopyJump:true,minZoom:3,maxZoom:20,zoomControl:true,preferCanvas:true,attributionControl:true});
  L.control.scale({imperial:false}).addTo(map);
  map.on('click',e=>selectLocation(productMapCoord(e.latlng)));addGlobalTilesV28(map);
}
function openSelectionStreetV28(){
  if(window.innerWidth<=760)mobileTab('street');
  showLegacyStreet(state.selection);
}

  // V26 inspection and onboarding. Route transactions remain owned by product v25.
  const workbenchV26={ready:false,road:null,routeId:null,groups:[],selected:-1,range:null,explicit:null,layer:null,tour:-1,tourRestore:null,tourFocus:null};
  function wbIndex(){
    const road=roadPresentation(currentRoute());
    if(workbenchV26.road===road&&workbenchV26.routeId===state.routeId)return;
    workbenchV26.layer?.remove();Object.assign(workbenchV26,{road,routeId:state.routeId,groups:[],selected:-1,range:null,explicit:null,layer:null});
    (road?.steps||[]).forEach((step,index)=>{const name=step.road||'未命名道路',last=workbenchV26.groups.at(-1);if(last?.name===name)last.end=index;else workbenchV26.groups.push({name,start:index,end:index});});
  }
  function wbValidStep(i){const road=workbenchV26.road,s=road?.steps?.[i];return !!s&&Number.isInteger(s.shapeIndex)&&s.shapeIndex>=0&&s.shapeIndex<road.path.length&&!!coord(road.path[s.shapeIndex]);}
  function wbSelectStep(index,source='step'){
    wbIndex();if(!wbValidStep(index)){toast('這個步驟缺少可定位的道路資料，請重新計算路線。');return false;}
    const road=workbenchV26.road,s=road.steps[index],p=road.path[s.shapeIndex],model=guideRoad(),along=model?.cumulative[s.shapeIndex];
    const before=model&&Number.isFinite(along)?SG.at(model,Math.max(0,along-12)):null,after=model&&Number.isFinite(along)?SG.at(model,Math.min(model.total,along+12)):null;
    const heading=before&&after?SG.bearing(index?before:p,index?p:after):null;
    workbenchV26.explicit={road,index,p};workbenchV26.selected=index;workbenchV26.range=source==='road'?(workbenchV26.groups.find(g=>g.start===index)||{start:index,end:index}):{start:index,end:index};
    // Viewing bypasses all edit handlers; a draft and its preview stay untouched.
    selectLocationV9(p,{label:'第 '+(index+1)+' 步 · '+s.instruction,heading});
    $('selected-position').classList.remove('visible');wbSyncSelection();
    if(innerWidth<=760)mobileTab('street');
    return true;
  }
  function wbRenderJourney(){
    if(!workbenchV26.ready)return;wbIndex();const road=workbenchV26.road;
    const names=$('journey-roads');names.replaceChildren();workbenchV26.groups.forEach((g,i)=>{const li=node('li','journey-road'),button=node('button','wb-road-button');button.type='button';button.dataset.wbStart=g.start;button.dataset.wbEnd=g.end;button.append(node('span','journey-road-number',String(i+1)),node('span',null,g.name));button.setAttribute('aria-label','路段 '+(i+1)+' '+g.name+'，查看第 '+(g.start+1)+' 步街景');button.disabled=!wbValidStep(g.start);button.addEventListener('click',()=>wbSelectStep(g.start,'road'));li.append(button);names.append(li);});
    const list=$('journey-steps');list.replaceChildren();(road?.steps||[]).forEach((s,i)=>{const li=node('li'),button=node('button','wb-step-button');button.type='button';button.dataset.wbStep=i;button.append(node('span','wb-turn-icon',iconFor(s.turnKind)),node('strong',null,(i+1)+'. '+s.instruction),node('span','journey-step-distance','接著約 '+Math.round(s.distanceMeters)+' 公尺'));if(['left','uturn'].includes(s.turnKind))button.append(node('span','journey-turn-note','轉彎／待轉方式請核對現場標誌'));button.disabled=!wbValidStep(i);button.addEventListener('click',()=>wbSelectStep(i));li.append(button);list.append(li);});
    wbSyncSelection();wbRefreshChrome();
  }
  function wbSyncSelection(){
    if(!workbenchV26.ready)return;wbIndex();const w=workbenchV26,road=w.road,p=guide.requestPoint;
    let index=-1;
    if(w.explicit?.road===road&&p&&SG.distance(w.explicit.p,p)<.5)index=w.explicit.index;
    else{w.explicit=null;w.range=null;const c=guide.context;if(c?.hit&&!c.hit.ambiguous&&c.info?.step)index=road?.steps.indexOf(c.info.step)??-1;}
    if(!wbValidStep(index))index=-1;w.selected=index;
    document.querySelectorAll('[data-wb-start]').forEach(b=>{const active=index>=Number(b.dataset.wbStart)&&index<=Number(b.dataset.wbEnd);b.setAttribute('aria-pressed',String(active));});
    document.querySelectorAll('[data-wb-step]').forEach(b=>{const active=Number(b.dataset.wbStep)===index;b.setAttribute('aria-pressed',String(active));if(active)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});
    const cards=[...$('steps-list').querySelectorAll(':scope > .step-card')];cards.forEach((card,i)=>{card.hidden=i!==index;card.classList.toggle('guide-active',i===index);});
    const extra=$('steps-list').querySelector(':scope > details');if(extra)extra.hidden=true;
    const hint=$('wb-current-step-hint');if(hint){hint.hidden=index>=0;hint.textContent=road?'點下方路名、步驟或地圖路線，查看這一段怎麼走。':'先建立路線，完成計算後查看路口。';}
    if(index>=0){const s=road.steps[index];$('step-count').textContent='第 '+(index+1)+'／'+road.steps.length+' 步';$('guide-position').textContent=s.road||'未命名道路';$('guide-progress').textContent='第 '+(index+1)+'／'+road.steps.length+' 步 · 選取位置，非 GPS';$('guide-map-status').textContent='選取第 '+(index+1)+' 步 · '+(s.road||'未命名道路');$('guide-prev').disabled=index===0;$('guide-next').disabled=index===road.steps.length-1;}
    const summary=$('wb-selection-status');if(summary)summary.textContent=index>=0?'已選取第 '+(index+1)+' 步 · '+(road.steps[index].road||'未命名道路')+'；地圖與街景目標已更新。':guide.context?.hit?.ambiguous?'這裡有重疊路段，請從下方步驟選擇要看的那一次。':'點路名或騎乘步驟，在地圖與街景查看同一位置。';
    w.layer?.remove();w.layer=null;
    if(index>=0&&state.maps.leaflet&&!mapEditEnabled){const range=w.range||{start:index,end:index},a=road.steps[range.start].shapeIndex,b=road.steps[range.end+1]?.shapeIndex??road.path.length-1;if(Number.isInteger(b)&&b>=a){const points=road.path.slice(a,b+1);if(points.length>1)w.layer=L.polyline(points,{color:'#e57a13',weight:8,opacity:.95,interactive:false,className:'wb-selected-road'}).addTo(state.maps.leaflet);}}
    document.querySelectorAll('.guide-marker-dot').forEach(el=>el.textContent=index>=0?'選 '+(index+1):'選');
  }
  function wbRefreshChrome(){
    if(!workbenchV26.ready)return;
    const expanded=$('journey-toggle').getAttribute('aria-expanded')==='true';$('toolbar-handoff').hidden=expanded||!currentRoute();
    const open=innerWidth<=760?$('app').classList.contains('mobile-route'):!state.layout.collapsed;$('toggle-left').setAttribute('aria-expanded',String(open));$('toggle-left').setAttribute('aria-controls','wb-sidebar');$('toggle-left').title=open?'收合我的路線':'展開我的路線';
    const r=currentRoute(),road=roadPresentation(r);$('wb-collapsed-summary').textContent=r?routeCaption(r)+(road?' · '+kmLabel(road.distanceMeters)+' · '+minuteLabel(road.durationSeconds):' · 尚未計算'):'尚未選擇路線';
  }
  function wbOpenJourney(){setJourneyExpanded(true);$('journey-details').open=true;if(innerWidth<=760)mobileTab('map');$('journey-step-count').focus({preventScroll:true});}
  const WB_TOUR_KEY='route-workbench-tour-v26';
  const wbTourSteps=[
    {target:'.search',title:'搜尋地點，設定行程',text:'搜尋地名、地址或路口。點結果後可設為起點、終點或途經點；搜尋不會直接更改路線。',picture:['搜尋地點','→','選結果'],view:'map'},
    {target:'.ux-current',title:'在「我的路線」管理方案',text:'這裡切換的是路線方案，不是資料夾。「新增」建立行程，「改名」命名自己的路線。草稿與已儲存路線分開保留。',picture:['我的路線','→','選擇／改名'],view:'route'},
    {target:'#journey-roads',title:'點路名，看對應道路',text:'點任一個路名，地圖會標出選取路段，右側載入街景目標。地圖不會自動縮放；需要時再按「定位選點」。',picture:['路名','→','地圖選點'],view:'journey'},
    {target:'#journey-steps',title:'點騎乘步驟，預看路口',text:'點逐步說明或地圖上的轉彎編號，查看同一個路口。可使用上一個／下一個路口依序看路；查看不會改動已存走法。',picture:['轉彎步驟','→','路口街景'],view:'steps'},
    {target:'#street-guide',title:'選點位置，不是 GPS',text:'「選」是工作台選取的路線位置。嵌入街景可能顯示附近拍點；在其中轉頭或走動，不會回傳位置。這裡沒有啟用 GPS。',picture:['選取位置','≠','我的位置'],view:'street'},
    {target:'.ux-sidebar-footer',title:'確認修改，再儲存與分享',text:'編輯草稿自動保留；道路預覽完成後，按「儲存路線」才採用新走法。下方路線區可複製文字或開啟手機導航。Google 仍會重新計算。',picture:['預覽','→','儲存／分享'],view:'route'}
  ];
  function wbHelp(section='start'){
    const body=$('help-dialog').querySelector('.dialog-body');body.querySelectorAll('[data-wb-help-panel]').forEach(p=>p.hidden=p.dataset.wbHelpPanel!==section);body.querySelectorAll('[data-wb-help]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.wbHelp===section)));showDialog('help-dialog');
  }
  function wbOnMobileTab(mode){if(!workbenchV26.ready)return;if(innerWidth<=760&&['route','street','steps'].includes(mode))setJourneyExpanded(false,false);wbRefreshChrome();}
  function wbInviteLayout(){
    const height=$('wb-tour-invite')?.getBoundingClientRect().height||0;
    const value=height+'px',root=document.documentElement;
    if(root.style.getPropertyValue('--wb-invite-height')===value)return;
    root.style.setProperty('--wb-invite-height',value);resizeMaps();
    if(workbenchV26.tour>=0)requestAnimationFrame(wbTourPosition);
  }
  function wbTourStart(){
    closeDialog('help-dialog');if($('wb-tour-invite'))$('wb-tour-invite').hidden=true;wbInviteLayout();const w=workbenchV26;if(w.tour>=0)return;
    w.tourRestore={collapsed:state.layout.collapsed,tab:ux.tab,expanded:$('journey-toggle').getAttribute('aria-expanded')==='true',details:$('journey-details').open,height:journeyLayout.height,mobile:[...$('app').classList].find(c=>/^mobile-(map|route|street|steps)$/.test(c))||'mobile-map'};
    w.tourFocus=$('help-button');w.tour=0;$('wb-tour').hidden=false;wbTourRender();$('wb-tour-next').focus({preventScroll:true});
  }
  function wbTourRender(){
    const w=workbenchV26;if(w.tour<0)return;document.querySelectorAll('.wb-tour-target').forEach(e=>e.classList.remove('wb-tour-target'));const s=wbTourSteps[w.tour];
    if(s.view==='route'){state.layout.collapsed=false;applyLayout();uxSetTab('library');if(innerWidth<=760)mobileTab('route');}
    else if(s.view==='street'){if(innerWidth<=760)mobileTab('street');}
    else if(innerWidth<=760)mobileTab('map');
    if(['journey','steps'].includes(s.view)){setJourneyExpanded(true);if(s.view==='steps')$('journey-details').open=true;}
    const target=document.querySelector(s.target);target?.classList.add('wb-tour-target');if(s.view==='steps')$('journey-body').scrollTop=$('journey-details').offsetTop-$('journey-body').offsetTop;else if(s.view==='journey')$('journey-body').scrollTop=0;
    $('wb-tour-count').textContent='操作導覽 '+(w.tour+1)+'／'+wbTourSteps.length;$('wb-tour-title').textContent=s.title;$('wb-tour-description').textContent=s.text;
    const ex=$('wb-tour-picture');ex.replaceChildren();s.picture.forEach((x,i)=>ex.append(node(i%2?'b':'span',null,x)));
    $('wb-tour-back').disabled=w.tour===0;$('wb-tour-next').textContent=w.tour===wbTourSteps.length-1?'完成導覽':'下一步';wbTourPosition();wbRefreshChrome();
  }
  function wbTourPosition(){
    if(workbenchV26.tour<0)return;const card=$('wb-tour'),target=document.querySelector(wbTourSteps[workbenchV26.tour].target),rect=target?.getBoundingClientRect();
    card.style.width=Math.min(370,innerWidth-24)+'px';card.style.maxHeight=Math.max(180,innerHeight-32)+'px';const h=card.getBoundingClientRect().height;
    let left=Math.min(innerWidth-card.offsetWidth-12,Math.max(12,(rect?.left||12))),top=(rect?.bottom||80)+12;
    if(top+h>innerHeight-12)top=Math.max(12,(rect?.top||innerHeight)-h-12);
    if(innerWidth<=760){left=12;top=workbenchV26.tour>=2&&workbenchV26.tour<=3?12:Math.max(12,innerHeight-h-12);}
    card.style.left=left+'px';card.style.top=Math.min(Math.max(12,top),Math.max(12,innerHeight-h-12))+'px';
  }
  function wbTourEnd(completed=false){
    const w=workbenchV26;if(w.tour<0)return;w.tour=-1;$('wb-tour').hidden=true;document.querySelectorAll('.wb-tour-target').forEach(e=>e.classList.remove('wb-tour-target'));
    const saved=w.tourRestore;if(saved){state.layout.collapsed=saved.collapsed;applyLayout();uxSetTab(saved.tab);setJourneyExpanded(saved.expanded);$('journey-details').open=saved.details;if(Number.isFinite(saved.height)&&saved.expanded)setJourneyHeight(saved.height);if(innerWidth<=760)mobileTab(saved.mobile.replace('mobile-',''));}
    try{localStorage.setItem(WB_TOUR_KEY,completed?'completed':'dismissed');}catch(_){}wbRefreshChrome();if(!document.querySelector('dialog[open]'))w.tourFocus?.focus({preventScroll:true});
  }
  function bindWorkbenchV26(){
    const legacy=$('product-legacy');for(const id of ['open-key','fit-city','fit-taiwan','ux-footer-handoff','ux-footer-edit']){const el=$(id);el.hidden=true;legacy.append(el);}
    $('fit-route').title='顯示目前路線全程';$('map-center-view').textContent='定位選點';$('map-center-view').title='移動地圖到工作台選取位置；不是 GPS';$('map-center-view').setAttribute('aria-label','定位選取位置');
    document.querySelector('.sidebar').id='wb-sidebar';
    $('help-button').textContent='ⓘ 使用說明';$('help-button').setAttribute('aria-label','使用說明與圖解導覽');
    $('help-dialog').querySelector('h2').textContent='使用說明';
    $('help-dialog').querySelector('.dialog-body').innerHTML='<nav class="wb-help-tabs" aria-label="說明主題"><button data-wb-help="start">圖解導覽</button><button data-wb-help="scope">功能與限制</button><button data-wb-help="privacy">資料與隱私</button></nav><section data-wb-help-panel="start"><div class="wb-help-illustration" aria-hidden="true"><span>路名／步驟</span><b>→</b><span>地圖選點</span><b>→</b><span>街景目標</span></div><h3>一步一步看懂怎麼規劃</h3><p>共 6 步，直接標出頁面上的操作區。可略過，也能隨時回來重看。</p><button id="wb-start-tour" class="primary">開始圖解導覽 →</button></section><section data-wb-help-panel="scope" hidden><h3>規劃、看路、確認走法</h3><p>點路名、騎乘步驟或轉彎標記，可查看同一段道路。估時依資料來源標示，未完整包含尖峰車流、紅燈與待轉。</p><p>街景是工作台要求的位置；Google 可能顯示附近拍點。街景內移動或轉頭不會回傳位置，也不是 GPS 定位。</p><p>Google 手機導航會依中途點重新計算，不能保證完全沿用工作台線形。</p><p>地點搜尋與道路底圖可查看全球；目前路線計算提供機車模型。各地道路與街景覆蓋不同，其他交通方式尚未接入。</p><p>資料來源：Photon／OpenStreetMap、Valhalla／FOSSGIS、OpenStreetMap 底圖、Google。道路通行與待轉請依現場標誌。</p></section><section data-wb-help-panel="privacy" hidden><h3>保存與位置資訊</h3><p id="wb-storage-scope"></p><p>搜尋會傳送輸入文字給搜尋服務；道路計算會傳送起終點與途經點座標給路由服務，街景和底圖也會連線至各供應者。</p><p>只有明確儲存才採用新走法。請在「我的路線 → 管理」下載備份；本工具不提供跨裝置自動同步。</p></section>';
    $('wb-storage-scope').textContent=PRODUCT_PUBLIC?'路線保存在此瀏覽器，清除瀏覽資料可能遺失；公開版不帶入個人路線。':'個人路線保存在本機與瀏覽器；公開版不包含你的住家、公司與私人路線。';
    $('help-dialog').querySelectorAll('[data-wb-help]').forEach(b=>b.addEventListener('click',()=>wbHelp(b.dataset.wbHelp)));
    $('help-button').addEventListener('click',e=>{e.stopImmediatePropagation();wbHelp();},true);$('route-help').addEventListener('click',e=>{e.stopImmediatePropagation();wbHelp('scope');},true);$('wb-start-tour').addEventListener('click',wbTourStart);
    const coach=node('section','wb-tour');coach.id='wb-tour';coach.hidden=true;coach.setAttribute('role','region');coach.setAttribute('aria-label','圖解操作導覽');coach.innerHTML='<div id="wb-tour-picture" class="wb-help-illustration" aria-hidden="true"></div><div role="status" aria-live="polite"><small id="wb-tour-count"></small><h3 id="wb-tour-title"></h3><p id="wb-tour-description"></p></div><div class="wb-tour-actions"><button id="wb-tour-exit">略過導覽</button><div><button id="wb-tour-back">上一步</button><button id="wb-tour-next" class="primary">下一步</button></div></div>';document.body.append(coach);
    $('wb-tour-exit').addEventListener('click',()=>wbTourEnd());$('wb-tour-back').addEventListener('click',()=>{workbenchV26.tour=Math.max(0,workbenchV26.tour-1);wbTourRender();});$('wb-tour-next').addEventListener('click',()=>{if(workbenchV26.tour===wbTourSteps.length-1)wbTourEnd(true);else{workbenchV26.tour++;wbTourRender();}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&workbenchV26.tour>=0){e.preventDefault();e.stopImmediatePropagation();wbTourEnd();}},true);
    window.addEventListener('resize',()=>{wbRefreshChrome();wbTourPosition();});
    $('toggle-left').addEventListener('click',e=>{e.stopImmediatePropagation();if(innerWidth<=760)mobileTab($('app').classList.contains('mobile-route')?'map':'route');else{state.layout.collapsed=!state.layout.collapsed;applyLayout();saveLayout();}wbRefreshChrome();},true);
    for(const [id,delta] of [['guide-prev',-1],['guide-next',1]])$(id).addEventListener('click',e=>{if(workbenchV26.selected<0)return;e.stopImmediatePropagation();wbSelectStep(workbenchV26.selected+delta);},true);
    $('steps-list').addEventListener('click',e=>{const button=e.target.closest('.step-select');if(!button)return;const cards=[...$('steps-list').querySelectorAll(':scope > .step-card')],i=cards.indexOf(button.closest('.step-card'));if(i<0)return;e.stopImmediatePropagation();wbSelectStep(i);},true);
    $('show-route-text').textContent='完整步驟';$('show-route-text').addEventListener('click',e=>{e.stopImmediatePropagation();wbOpenJourney();},true);
    const hint=node('p','wb-current-step-hint');hint.id='wb-current-step-hint';$('steps-list').before(hint);
    const summary=node('p','wb-selection-status');summary.id='wb-selection-status';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');$('journey-roads').before(summary);
    const strip=document.querySelector('.journey-strip'),short=node('span','wb-collapsed-summary');short.id='wb-collapsed-summary';strip.append(short,$('toolbar-handoff'));
    $('toolbar-handoff').textContent='分享';$('toolbar-handoff').setAttribute('aria-label','手機導航與 LINE 分享');
    new MutationObserver(wbRefreshChrome).observe($('journey-toggle'),{attributes:true,attributeFilter:['aria-expanded']});
    const invite=node('aside','wb-tour-invite');invite.id='wb-tour-invite';invite.setAttribute('aria-label','首次使用導覽邀請');invite.innerHTML='<span>第一次使用？用圖解了解怎麼看路。</span><button id="wb-invite-start">開始導覽</button><button id="wb-invite-later">稍後再看</button>';
    document.body.prepend(invite);try{invite.hidden=!!localStorage.getItem(WB_TOUR_KEY);}catch(_){}
    new ResizeObserver(wbInviteLayout).observe(invite);wbInviteLayout();
    $('wb-invite-start').addEventListener('click',wbTourStart);$('wb-invite-later').addEventListener('click',()=>{invite.hidden=true;try{localStorage.setItem(WB_TOUR_KEY,'dismissed');}catch(_){}wbInviteLayout();});
    document.querySelector('[data-mobile="steps"]')?.addEventListener('click',e=>{e.stopImmediatePropagation();wbOpenJourney();},true);
    workbenchV26.ready=true;wbRenderJourney();wbRefreshChrome();
  }

  // V27: an explicit editor lifecycle and bounded retry for temporary route throttling.
  function toggleAdjustV27(){
    if(state.mode!=='draw'&&!mapEditEnabled){startAdjust();return;}
    const changed=!!(roadPreview||mapEdit?.target||stopLookup||clickEdit&&clickEdit.kind!=='maprange');
    if(changed){showDialog('edit-exit-dialog');return;}
    productDiscard();mapEditEnabled=false;state.mode='view';render();toast('已退出調整走法；原路線未變。');
  }
  function exitAdjustV27(keep){
    if(keep){productCaptureDraft();if(!product.draftOK){toast('草稿保存失敗，請先下載備份；目前仍留在編輯模式。');return;}cancelDragEdit(false);mapEditEnabled=false;state.mode='view';render();toast('已保留草稿並退出；回到這條路線可繼續編輯。');}
    else{productDiscard();mapEditEnabled=false;state.mode='view';render();}
    closeDialog('edit-exit-dialog');$('mode-draw').focus();
  }
  async function routingFetchV27(url,options){
    let response=await window.fetch(url,options);
    if(response.status!==429)return response;
    if(roadPreview?.status==='loading'){roadPreview.waitingRetry=true;renderMapEdit();}
    const signal=options.signal;
    await new Promise((resolve,reject)=>{let timer;const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},1800);});
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(roadPreview)roadPreview.waitingRetry=false;
    response=await window.fetch(url,options);return response;
  }
  function refreshMapEditV27(){
    $('mode-draw').textContent=state.mode==='draw'?'結束調整':'調整走法';
    $('mode-draw').title=state.mode==='draw'?'再次點按可退出調整走法':'調整路線經過的道路';
    const d=mapEdit,preview=roadPreview,bar=$('map-edit-bar-status');
    if(!mapEditEnabled)return;
    const row=$('edit-review-row'),retry=$('edit-retry-visible');
    if(row){row.hidden=!(d?.analysis?.outsideChanged&&preview?.status==='ready');$('edit-review-check').checked=!!d?.outsideAccepted;}
    if(retry)retry.hidden=preview?.status!=='error';
    if(preview?.status==='loading'){bar.textContent=preview.waitingRetry?'道路服務忙碌，稍候自動重試一次…':'正在沿道路重新計算…完成後才會更新藍線、公里與時間。';}
    if(preview?.status==='ready')bar.textContent='✓ 計算完成：'+kmLabel(preview.result.distanceMeters)+' · 模型 '+secondsText(preview.result.durationSeconds)+(d?.analysis?.outsideChanged?'。範圍外也有變動，請查看並確認下方項目。':'。查看新藍線後可採用修改。');
    if(preview?.status==='error')bar.textContent='未能完成計算：'+preview.error+' 已保留原路線，可重試或取消。';
    bar.setAttribute('role','status');bar.setAttribute('aria-live','polite');
  }
  function bindEditV27(){
    const dialog=node('dialog');dialog.id='edit-exit-dialog';dialog.className='product-dialog';dialog.setAttribute('aria-labelledby','edit-exit-title');dialog.innerHTML='<h2 id="edit-exit-title">結束這次路線調整？</h2><p>目前的改道尚未儲存成正式路線。你可以保留草稿稍後繼續，或放棄本次修改；已儲存的路線不會改變。</p><div class="edit-exit-actions"><button id="edit-keep-exit" class="primary">保留草稿並退出</button><button id="edit-discard-exit">放棄修改並退出</button><button id="edit-stay">繼續調整</button></div>';document.body.append(dialog);
    $('edit-keep-exit').addEventListener('click',()=>exitAdjustV27(true));$('edit-discard-exit').addEventListener('click',()=>exitAdjustV27(false));$('edit-stay').addEventListener('click',()=>closeDialog('edit-exit-dialog'));dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog('edit-exit-dialog')});
    const row=node('label','map-edit-protected-row warning');row.id='edit-review-row';row.hidden=true;const box=node('input');box.type='checkbox';box.id='edit-review-check';box.addEventListener('change',()=>{if(mapEdit){mapEdit.outsideAccepted=box.checked;renderMapEdit()}});row.append(box,node('span',null,'我已查看「範圍與變更」，接受選定範圍外的道路變動。'));$('map-edit-bar').append(row);
    const retry=node('button',null,'重試道路計算');retry.id='edit-retry-visible';retry.hidden=true;retry.addEventListener('click',()=>{if(mapEdit?.target)void stageMapTarget(mapEdit.target);else void requestRoadPreview()});$('map-edit-bar').append(retry);
    refreshMapEditV27();
  }

  window.PlannerUI={version:25,uiVersion:28,wbSelectStep,wbTourStart,wbTourEnd,wbInspection:()=>({road:clone(workbenchV26.road),index:workbenchV26.selected,groups:clone(workbenchV26.groups),tour:workbenchV26.tour,routeId:workbenchV26.routeId}),productState:()=>({public:!!data.publicEdition,category:product.category,draftCount:Object.keys(product.drafts).length,archived:[...(library.archived||[])],saveState:productSaveState()}),productDiscard,productSave,productArchive,productRestore,productRestoreDraft,productHydrate:hydrateLibrary,productImport,productBackup,uxSetTab,uxRefresh,uxHasDraft,uxPersistence:()=>({dirty:library.dirty,saving:persistence.saving}),uxMapViewport:()=>{const m=state.maps.leaflet;return m?{center:{lat:m.getCenter().lat,lng:m.getCenter().lng},zoom:m.getZoom()}:null;},guideMove,guideAim,guideRecenter,guideUpdate,handoffCurrent,copyHandoff,setHandoffSelection,setJourneyExpanded,setJourneyHeight,journeyLayoutState:()=>({...journeyLayout}),beginMapSelection,stageMapTarget,setMapBoundary,mapEditPreviewDetails,mapEditRelease,chooseMapOccurrence,journeyText,roadNames,roadSequenceText,copyJourney,compare,comparisonRows,openComparisonRoute,planningControls,stageStopControls,reorderStop,removeStop,moveStop,beginStopLookup,searchRoutePoint,chooseStopResult,applyStopResult,useMapForStop,search,closeSearch,selectPlaceResult,insertSelection,setEndpoint,chooseEdit,requestRoadPreview,recalculateRoads,validateRoadReply,roadOf,startAdjust,beginRouteDrag,updateRouteDrag,endRouteDrag,confirmDragEdit,cancelDragEdit,nearestEdge,shapeFor,confirmOrigin,confirmGoal,confirmSegment,finishRoute,confirmExistingPoint,routeText,turnEntries,confirmedPath,renameRoute,removeRoute,restoreRoute,reorderRoute,libraryPayload,applyLibrary,hydrateLibrary,flushLibrary,retrySave,legacyStreetURL,showLegacyStreet,showNearbyStreet,newCommute,pointLedger,toggleAllRoutes,openGoogleRoute,updatePointMeta,selectRoute,selectLocation,selectStation,setMode,addSelectedPoint,movePoint,deletePoint,undo,newCustom,computeGoogle,loadGoogleKey,activateGoogle,forgetGoogle,parseCoord,safeEmbed,exportRoute,routeMetrics,readState:()=>({routeId:state.routeId,mode:state.mode,selection:clone(state.selection),viewer:clone(state.viewer),googleReady:state.googleReady,streetProvider:state.streetProvider,clickEdit:clickEdit?clone(clickEdit):null,roadPreview:roadPreview?{status:roadPreview.status,error:roadPreview.error,result:clone(roadPreview.result)}:null,dragRouteMode:state.dragRouteMode===true,dragEdit:dragEdit?{routeId:dragEdit.routeId,kind:dragEdit.kind,target:clone(dragEdit.target)}:null,library:clone(libraryPayload()),persistence:{ready:persistence.ready,blocked:persistence.blocked,revision:persistence.revision},route:clone(currentRoute()),routeCount:allRoutes().length,showAllRoutes:state.showAllRoutes,undoCount:state.undo.length,layout:clone(state.layout),streetViewport:clone(state.streetViewport||null)}),resizeMaps,measureStreetLayout};
  init();
  bindPlaceSearch();
  bindStops();
  bindJourney();
  bindJourneyDrawer();
  bindMapEditor();
  bindHandoff();
  bindStreetGuide();
  bindUXV24();
  bindProductV25();
  bindWorkbenchV26();
  bindEditV27();
})();
