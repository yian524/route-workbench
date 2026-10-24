"""Bounded Valhalla scooter routing. No keys, billing or URL proxy."""
from datetime import datetime, timezone
from math import cos, radians, hypot, isfinite
from threading import Lock
from time import monotonic, sleep
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import json

UPSTREAM = 'https://valhalla1.openstreetmap.de/route'
MAX_RESPONSE = 2_000_000
# Travel modes offered by the planner. 'travel' is Valhalla's (travel_mode, travel_type) for every
# maneuver; None accepts any type of that mode (bicycle types vary: road, hybrid, cross, mountain).
# Two-wheelers keep the original rules: no motorways, two-stage turn reminders.
MODES = {
    'motorcycle': {'label': '機車', 'travel': ('drive', 'motorcycle'), 'two_wheeler': True,
                   'warning': 'OpenStreetMap 機車模型；現場車道、禁轉與兩段式待轉仍需核對。',
                   'time': '道路模型時間；未取得臺北早尖峰即時車流與完整號誌／兩段式停等秒數。'},
    'motor_scooter': {'label': '機車', 'travel': ('drive', 'motor_scooter'), 'two_wheeler': True,
                      'warning': 'OpenStreetMap 機車模型；現場車道、禁轉與兩段式待轉仍需核對。',
                      'time': '道路模型時間；未取得臺北早尖峰即時車流與完整號誌／兩段式停等秒數。'},
    'auto': {'label': '汽車', 'travel': ('drive', 'car'), 'two_wheeler': False,
             'warning': 'OpenStreetMap 汽車模型；現場車道、禁轉與單行道仍需核對。',
             'time': '道路模型時間；未含即時車流、紅燈與找停車位時間。'},
    'bicycle': {'label': '自行車', 'travel': ('bicycle', None), 'two_wheeler': False,
                'warning': 'OpenStreetMap 自行車模型；自行車道、禁行路段與路況仍需核對。',
                'time': '自行車模型時間；未含紅燈、坡度與個人騎乘速度差異。'},
    'pedestrian': {'label': '步行', 'travel': ('pedestrian', 'foot'), 'two_wheeler': False,
                   'warning': 'OpenStreetMap 步行模型；人行道、天橋與地下道請依現場標示。',
                   'time': '步行模型時間（約時速 5 公里）；未含等紅燈與上下樓梯時間。'},
}


def mode_info(costing):
    return MODES.get(costing, MODES['motorcycle'])

class RoutingFailure(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status

def coordinate(value):
    if not isinstance(value, dict): raise ValueError('invalid coordinate')
    p = {}
    for key, limit in [('lat',85),('lng',180)]:
        n=value.get(key)
        if isinstance(n,bool) or not isinstance(n,(int,float)) or not isfinite(n) or abs(n)>limit:
            raise ValueError('invalid coordinate')
        p[key]=float(n)
    return p

def meters(a,b):
    return hypot((a['lng']-b['lng'])*cos(radians((a['lat']+b['lat'])/2)), a['lat']-b['lat'])*111195

def decode_shape(value):
    if isinstance(value, dict) and value.get('type')=='LineString':
        nodes=[coordinate({'lat':p[1],'lng':p[0]}) for p in value['coordinates']]
    elif isinstance(value, str) and len(value)<=100000:
        nodes=[];lat=lon=at=0
        while at<len(value):
            deltas=[]
            for _ in range(2):
                result=shift=0
                while True:
                    if at>=len(value) or shift>30: raise ValueError('invalid polyline')
                    part=ord(value[at])-63;at+=1
                    if not 0<=part<=63:raise ValueError('invalid polyline')
                    result|=(part&31)<<shift;shift+=5
                    if part<32:break
                deltas.append(~(result>>1) if result&1 else result>>1)
            lat+=deltas[0];lon+=deltas[1]
            nodes.append(coordinate({'lat':lat/1e6,'lng':lon/1e6}))
            if len(nodes)>1000:raise ValueError('route shape too long')
    else:raise ValueError('unsupported shape')
    if not 2<=len(nodes)<=1000:raise ValueError('invalid shape size')
    return nodes

def maneuver_text(kind,road,costing='motor_scooter'):
    names={0:('unknown','續行'),1:('start','出發'),2:('start','出發'),3:('start','出發'),
        4:('arrival','到達終點'),5:('arrival','到達終點右側'),6:('arrival','到達終點左側'),
        7:('straight','繼續直行'),8:('straight','繼續直行'),9:('right','向右靠'),10:('right','右轉'),11:('right','向右急轉'),
        12:('uturn','向右迴轉'),13:('uturn','向左迴轉'),14:('left','向左急轉'),15:('left','左轉'),16:('left','向左靠'),
        17:('straight','沿匝道直行'),18:('right','往右側匝道'),19:('left','往左側匝道'),20:('right','從右側出口離開'),
        21:('left','從左側出口離開'),22:('straight','保持直行'),23:('right','保持右側'),24:('left','保持左側'),
        25:('merge','匯入'),26:('roundabout','進入圓環'),27:('roundabout','離開圓環'),28:('straight','搭乘渡輪'),
        29:('straight','離開渡輪'),37:('merge','向右匯入'),38:('merge','向左匯入')}
    turn,title=names.get(kind,('unknown','依道路續行'))
    text=title+('，進入「'+road+'」' if road and turn not in {'arrival'} else '')
    if turn in {'left','uturn'} and mode_info(costing)['two_wheeler']:text+='；兩段式待轉及禁止轉彎標誌待現場核對'
    return turn,text

def validate_snaps(result,inputs,max_snap_meters):
    """Never accept a provider's distance alone: verify the adopted road point too."""
    controls=result.get('points',[]);reported=result.get('snapDistancesMeters',[])
    if len(controls)!=len(inputs) or len(reported)!=len(inputs):
        raise RoutingFailure('道路選點資料不完整，原方案保留。',422)
    for original,adopted,distance in zip(inputs,controls,reported):
        if isinstance(distance,bool) or not isinstance(distance,(int,float)) or not isfinite(distance) or distance<0:
            raise RoutingFailure('道路選點距離資料不完整，原方案保留。',422)
        if distance>max_snap_meters or meters(original,coordinate(adopted))>max_snap_meters:
            raise RoutingFailure(f'選點距可接上的道路超過 {max_snap_meters} 公尺，請把點移到道路上。',422)

def normalize(data,inputs,costing='motor_scooter',max_snap_meters=100):
    trip=data.get('trip',{})
    if trip.get('status')!=0 or len(trip.get('legs',[]))!=1:raise RoutingFailure(f"找不到完整的{mode_info(costing)['label']}路徑。",422)
    leg=trip['legs'][0]
    if mode_info(costing)['two_wheeler'] and trip.get('summary',{}).get('has_highway') is True:
        raise RoutingFailure('模型包含高速道路，這次結果不採用；請把途經點移到一般機車道路。',422)
    try:
        original=decode_shape(leg.get('shape'))
        # The provider's first/last geometry nodes define its computed trip.
        # Projecting endpoints onto an interior edge leaves a tail beyond the adopted
        # destination (and misreports its snap distance). Keep geometry and metrics;
        # adopt the actual endpoints, subject to the same strict snap-distance limit.
        # Only intermediate controls are projected monotonically along the geometry.
        positions=[];lower=0.
        for control_index,p in enumerate(inputs):
            if control_index in (0,len(inputs)-1):
                pos=0 if control_index==0 else len(original)-1
                q=original[pos];d=meters(p,q)
                if d>max_snap_meters:
                    raise RoutingFailure(f'起點或終點距可接上的道路超過 {max_snap_meters} 公尺，請把點移到道路上。',422)
                positions.append((d,float(pos),q));lower=float(pos)
                continue
            best=None
            for i in range(max(0,int(lower)),len(original)-1):
                a,b=original[i],original[i+1];scale=cos(radians(p['lat']))
                dx=(b['lng']-a['lng'])*scale;dy=b['lat']-a['lat'];den=dx*dx+dy*dy
                t=max(0.,min(1.,(((p['lng']-a['lng'])*scale*dx+(p['lat']-a['lat'])*dy)/den))) if den else 0.
                pos=i+t
                if pos+1e-7<lower:continue
                q={'lat':a['lat']+(b['lat']-a['lat'])*t,'lng':a['lng']+(b['lng']-a['lng'])*t}
                d=meters(p,q)
                if best is None or d<best[0]:best=(d,pos,q)
            if best is None or best[0]>max_snap_meters:raise RoutingFailure(f'選點距可接上的道路超過 {max_snap_meters} 公尺，請把點移到道路上。',422)
            positions.append(best);lower=best[1]
        merged=[(float(i),p,'node',i) for i,p in enumerate(original)]
        merged.extend((pos,q,'anchor',i) for i,(_,pos,q) in enumerate(positions))
        merged.sort(key=lambda item:item[0])
        nodes=[];anchor_indices={};original_indices={}
        for _,p,kind,i in merged:
            if not nodes or meters(nodes[-1],p)>.05:nodes.append(p)
            (anchor_indices if kind=='anchor' else original_indices)[i]=len(nodes)-1
        if len(nodes)>1000:raise ValueError('too many shape nodes')
        controls=[{**nodes[anchor_indices[i]],'shapeIndex':anchor_indices[i]} for i in range(len(inputs))]
        steps=[]
        for item in leg.get('maneuvers',[]):
            if len(steps)>=200:raise ValueError('too many turns')
            travel_mode,travel_type=mode_info(costing)['travel']
            if item.get('travel_mode',travel_mode)!=travel_mode or travel_type and item.get('travel_type')!=travel_type:raise ValueError('unexpected travel profile')
            old=item['begin_shape_index'];at=original_indices[old]
            road='、'.join(str(n) for n in item.get('street_names',[]))[:160]
            turn,text=maneuver_text(item['type'],road,costing)
            steps.append({'road':road or '未命名道路','turnKind':turn,'instruction':text[:160],
                'shapeIndex':at,'start':nodes[at],'distanceMeters':round(float(item.get('length',0))*1000,1),
                'durationSeconds':float(item.get('time',0)),'confirmed':False,
                'warning':mode_info(costing)['warning']})
        summary=trip['summary'];length=float(summary['length'])*1000;duration=float(summary['time'])
        if not all(isfinite(n) and 0<=n<=1000000 for n in [length,duration]):raise ValueError('invalid summary')
        result={'path':nodes,'points':controls,'steps':steps,'distanceMeters':round(length,1),'durationSeconds':duration,
            'provider':'valhalla_fossgis','costing':costing,'computedAt':datetime.now(timezone.utc).isoformat(),
            'snapDistancesMeters':[round(d,1) for d,_,_ in positions],
            'timeNote':mode_info(costing)['time']}
        validate_snaps(result,inputs,max_snap_meters)
        return result
    except (ValueError,KeyError,TypeError,IndexError,OverflowError) as error:
        if str(error) in ('route shape too long','too many shape nodes'):
            raise RoutingFailure('路線太長（超過 1,000 個道路節點，約 50 公里以上）；請加途經點分段，或縮短路線。',422) from error
        raise RoutingFailure('路線服務回傳的資料不完整，原路線保留。') from error

def fetch_route(points,costing='motor_scooter'):
    payload={'locations':[{'lat':p['lat'],'lon':p['lng'],'type':'via' if 0<i<len(points)-1 else 'break','search_cutoff':100,'rank_candidates':False} for i,p in enumerate(points)],
        'costing':costing,'costing_options':{costing:{'top_speed':45,'use_highways':0,'use_tolls':0,'use_tracks':0,'use_trails':0,'exclude_highways':True}} if mode_info(costing)['two_wheeler'] else {},
        'units':'kilometers','language':'en-US'}
    request=Request(UPSTREAM,data=json.dumps(payload,allow_nan=False).encode(),headers={
        'Content-Type':'application/json','User-Agent':'RouteWorkbench/25 (self-hosted route planner)',
        'X-Client-Id':os.environ.get('PLANNER_CLIENT_ID','route-workbench-local-preview')})
    try:
        with urlopen(request,timeout=22) as response:
            raw=response.read(MAX_RESPONSE+1)
            if len(raw)>MAX_RESPONSE:raise RoutingFailure('路線資料過大，請縮短規劃範圍。')
            return json.loads(raw)
    except HTTPError as error:
        try:engine_error=json.loads(error.read(5000)).get('error_code')
        except (ValueError,OSError):engine_error=None
        if engine_error==150:raise RoutingFailure('路線服務單次最多 10 個位置；請分段計算。',422) from error
        if engine_error==171:raise RoutingFailure(f"選的點附近 100 公尺內沒有{mode_info(costing)['label']}能通行的道路（例如徒步區、公園或建物內），請把點移到可通行的路上。",422) from error
        if engine_error in (154,155):raise RoutingFailure('路線距離超過免費路線服務的單次上限，請加途經點分段規劃。',422) from error
        raise RoutingFailure('免費路線服務暫時限流，請稍後再試。' if error.code==429 else f"路線服務找不到可通行的完整{mode_info(costing)['label']}路徑。",429 if error.code==429 else 422) from error
    except (URLError,TimeoutError,OSError,ValueError) as error:
        raise RoutingFailure('免費路線服務暫時無法連線，原路線保留。',503) from error

class ScooterRouter:
    def __init__(self,fetcher=fetch_route):
        self.fetcher=fetcher;self.lock=Lock();self.last=-100.;self.cache={};self.busy=False
    def route(self,payload):
        if not isinstance(payload,dict) or not {'points'}<=set(payload)<= {'points','profile','maxSnapMeters'}:raise ValueError('invalid routing request')
        costing=payload.get('profile','motor_scooter')
        if costing not in MODES:raise ValueError('invalid routing profile')
        max_snap_meters=payload.get('maxSnapMeters',100)
        if type(max_snap_meters) is not int or max_snap_meters not in {30,100}:raise ValueError('invalid maximum snap distance')
        values=payload['points']
        if not isinstance(values,list) or not 2<=len(values)<=50:raise ValueError('routing requires 2 to 50 points')
        points=[coordinate(p) for p in values]
        if sum(meters(a,b) for a,b in zip(points,points[1:]))>250000:raise RoutingFailure('起點、途經點到終點的直線距離合計超過 250 公里，免費路線服務無法一次計算；請分段規劃。',422)
        key=(costing,max_snap_meters,tuple((p['lat'],p['lng']) for p in points))
        with self.lock:
            now=monotonic();cached=self.cache.get(key)
            if cached and now-cached[0]<300:
                validate_snaps(cached[1],points,max_snap_meters)
                return cached[1]
            if self.busy or now-self.last<1.1:raise RoutingFailure('請等目前計算結束，再稍等 1 秒重試。',429)
            self.busy=True
        try:
            result=None
            # Public server permits ten locations; adjacent chunks share one road point.
            for start in range(0,len(points)-1,9):
                with self.lock:delay=max(0,1.1-(monotonic()-self.last))
                if delay:sleep(delay)
                chunk=points[start:start+10]
                with self.lock:self.last=monotonic()
                part=normalize(self.fetcher(chunk,costing),chunk,costing,max_snap_meters)
                if result is None:result=part;continue
                if meters(result['path'][-1],part['path'][0])>1:
                    raise RoutingFailure('分段交界的道路方向不一致，原方案保留；請移動交界附近的途經點再試。',422)
                offset=len(result['path'])-1
                result['path'].extend(part['path'][1:])
                if len(result['path'])>1000:raise RoutingFailure('道路節點超過保存上限，請縮短路線。',422)
                result['points'].extend({**p,**result['path'][p['shapeIndex']+offset],'shapeIndex':p['shapeIndex']+offset} for p in part['points'][1:])
                result['steps']=[s for s in result['steps'] if s['turnKind']!='arrival']
                for s in part['steps']:
                    step={**s,'shapeIndex':s['shapeIndex']+offset,'start':result['path'][s['shapeIndex']+offset]}
                    if step['turnKind']=='start':step.update(turnKind='straight',instruction='繼續沿「'+step['road']+'」行駛')
                    result['steps'].append(step)
                if len(result['steps'])>200:raise RoutingFailure('轉彎步驟超過保存上限。',422)
                result['distanceMeters']+=part['distanceMeters'];result['durationSeconds']+=part['durationSeconds']
                result['snapDistancesMeters'].extend(part['snapDistancesMeters'][1:])
                result['computedAt']=part['computedAt']
            validate_snaps(result,points,max_snap_meters)
            with self.lock:
                if len(self.cache)>=32:self.cache.clear()
                self.cache[key]=(monotonic(),result)
            return result
        finally:
            with self.lock:self.busy=False
