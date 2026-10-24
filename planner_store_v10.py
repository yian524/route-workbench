"""Bounded, atomic, local-only route library. No cloud or Google credentials."""
from pathlib import Path
from threading import Lock
import json
import math
import os
import re
import shutil

MAX_BYTES = 2_000_000
ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
CONTROL_ID = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
CONTROL_FIELDS = {'controlId', 'controlRole', 'controlSource'}
CONTROL_ROLES = {'endpoint', 'stop', 'shaping', 'locked', 'legacy'}
_INTERNAL_WRITE = object()

def has_control_metadata(library):
    return any(any(CONTROL_FIELDS.intersection(point) for point in route.get('points', []))
               for route in (library or {}).get('customRoutes', []))

def validate_library(value):
    if not isinstance(value, dict):
        raise ValueError('library must be an object')
    allowed = {'version','customRoutes','hidden','order','presetNames','currentId','home','office','archived','routeMeta','productVersion'}
    if set(value)-allowed or value.get('version') != 10:
        raise ValueError('unsupported library schema')
    routes=value.get('customRoutes', [])
    if not isinstance(routes,list) or len(routes)>100:
        raise ValueError('too many routes')
    ids=set()
    def scan(obj,depth=0):
        if depth>16: raise ValueError('too deeply nested')
        if isinstance(obj,dict):
            if any(str(k).lower() in {'key','apikey','token','password','csrf','__proto__','constructor','prototype'} for k in obj):
                raise ValueError('credential or unsafe field rejected')
            for item in obj.values(): scan(item,depth+1)
        elif isinstance(obj,list):
            if len(obj)>1000: raise ValueError('array too long')
            for item in obj: scan(item,depth+1)
        elif isinstance(obj,str):
            if len(obj)>12000: raise ValueError('text too long')
        elif isinstance(obj,float) and not math.isfinite(obj):
            raise ValueError('nonfinite number')
        elif obj is not None and not isinstance(obj,(str,int,float,bool)):
            raise ValueError('invalid value')
    def coordinate(p):
        if not isinstance(p,dict): raise ValueError('invalid coordinate')
        for key,limit in [('lat',85),('lng',180)]:
            n=p.get(key)
            if isinstance(n,bool) or not isinstance(n,(int,float)) or not math.isfinite(n) or abs(n)>limit:
                raise ValueError('coordinate out of range')
    scan(value)
    for route in routes:
        if not isinstance(route,dict) or not ID.fullmatch(route.get('id','')) or route['id'] in ids or route['id'] in {'A','B'}:
            raise ValueError('invalid route id')
        ids.add(route['id'])
        if not isinstance(route.get('name'),str) or len(route['name'])>160:
            raise ValueError('invalid route name')
        points=route.get('points')
        if not isinstance(points,list) or len(points)>200:
            raise ValueError('invalid route points')
        for p in points: coordinate(p)
        # A route is either entirely legacy or entirely identified. This makes
        # point roles survive reorder/save/reload without guessing missing roles.
        if any(CONTROL_FIELDS.intersection(p) for p in points):
            if len(points)<2: raise ValueError('identified route needs both endpoints')
            control_ids=set()
            for index,p in enumerate(points):
                if not CONTROL_FIELDS.issubset(p): raise ValueError('incomplete control metadata')
                control_id=p['controlId']; role=p['controlRole']; source=p['controlSource']
                if not isinstance(control_id,str) or not CONTROL_ID.fullmatch(control_id) or control_id in control_ids:
                    raise ValueError('invalid or duplicate control id')
                control_ids.add(control_id)
                if not isinstance(role,str) or role not in CONTROL_ROLES:
                    raise ValueError('invalid control role')
                endpoint=index in {0,len(points)-1}
                if (role=='endpoint') != endpoint: raise ValueError('control role does not match endpoint')
                if not isinstance(source,str) or not source.strip() or len(source)>80:
                    raise ValueError('invalid control source')
        if 'editShape' in route:
            shape=route['editShape']
            if not isinstance(shape,dict) or set(shape)-{'nodes','sourcePreset'}:
                raise ValueError('invalid edit shape')
            nodes=shape.get('nodes')
            if not isinstance(nodes,list) or not 2<=len(nodes)<=1000:
                raise ValueError('invalid shape nodes')
            if shape.get('sourcePreset') not in {'A','B',None}:
                raise ValueError('invalid shape source')
            for n in nodes: coordinate(n)
            prior=-1
            for p in points:
                index=p.get('shapeIndex')
                if type(index) is not int or index<prior or index<0 or index>=len(nodes):
                    raise ValueError('invalid shape anchor')
                if abs(nodes[index]['lat']-p['lat'])>0.000001 or abs(nodes[index]['lng']-p['lng'])>0.000001:
                    raise ValueError('shape and point coordinates differ')
                prior=index
        if 'roadRoute' in route:
            road=route['roadRoute']
            allowed_road={'provider','costing','pointKey','distanceMeters','durationSeconds','computedAt','steps','timeNote','segmentSources'}
            osm=isinstance(road,dict) and road.get('provider')=='valhalla_fossgis' and road.get('costing') in {'motor_scooter','motorcycle'}
            hybrid=isinstance(road,dict) and road.get('provider') in {'hybrid_osm_google_v21','hybrid_osm_path_v22'} and road.get('costing')=='motorcycle_mixed'
            if not isinstance(road,dict) or set(road)-allowed_road or not (osm or hybrid) or 'editShape' not in route:
                raise ValueError('invalid road route')
            if 'timeNote' in road and (not isinstance(road['timeNote'],str) or len(road['timeNote'])>160):
                raise ValueError('invalid road time note')
            sources=road.get('segmentSources',[])
            if not isinstance(sources,list) or len(sources)>200 or osm and sources:
                raise ValueError('invalid road segment sources')
            for source in sources:
                allowed_source={'kind','distanceMeters','durationSeconds','pathStart','pathEnd','joinGapMeters'}
                if not isinstance(source,dict) or set(source)-allowed_source or not isinstance(source.get('kind'),str) or not 1<=len(source['kind'])<=80:
                    raise ValueError('invalid road segment source')
                start,end=source.get('pathStart'),source.get('pathEnd')
                if type(start) is not int or type(end) is not int or not 0<=start<=end<len(route['editShape']['nodes']):
                    raise ValueError('invalid road segment range')
                for key in ['distanceMeters','durationSeconds']+(['joinGapMeters'] if 'joinGapMeters' in source else []):
                    n=source.get(key)
                    if isinstance(n,bool) or not isinstance(n,(int,float)) or not math.isfinite(n) or not 0<=n<=1000000:
                        raise ValueError('invalid road segment metric')
            for key in ['distanceMeters','durationSeconds']:
                n=road.get(key)
                if isinstance(n,bool) or not isinstance(n,(int,float)) or not math.isfinite(n) or not 0<=n<=1000000:
                    raise ValueError('invalid road summary')
            if not isinstance(road.get('pointKey'),str) or len(road['pointKey'])>5000 or not isinstance(road.get('computedAt'),str):
                raise ValueError('invalid road provenance')
            steps=road.get('steps')
            if not isinstance(steps,list) or not 1<=len(steps)<=200:
                raise ValueError('invalid road steps')
            nodes=route['editShape']['nodes'];prior=-1
            for step in steps:
                if not isinstance(step,dict):raise ValueError('invalid road step')
                index=step.get('shapeIndex')
                if type(index) is not int or not prior<=index<len(nodes):raise ValueError('invalid road step anchor')
                coordinate(step.get('start'))
                if abs(nodes[index]['lat']-step['start']['lat'])>0.000001 or abs(nodes[index]['lng']-step['start']['lng'])>0.000001:
                    raise ValueError('road step and shape differ')
                for key in ['road','turnKind','instruction','warning']:
                    if not isinstance(step.get(key),str) or len(step[key])>160:raise ValueError('invalid road step text')
                for key in ['distanceMeters','durationSeconds']:
                    n=step.get(key)
                    if isinstance(n,bool) or not isinstance(n,(int,float)) or not math.isfinite(n) or not 0<=n<=1000000:raise ValueError('invalid road step metric')
                prior=index
    for key in ['hidden','order','archived']:
        seq=value.get(key,[])
        if not isinstance(seq,list) or len(seq)>202 or len(seq)!=len(set(seq)) or any(not isinstance(x,str) or not ID.fullmatch(x) for x in seq):
            raise ValueError('invalid route order')
    names=value.get('presetNames',{})
    if not isinstance(names,dict) or set(names)-{'A','B'} or any(not isinstance(x,str) or len(x)>160 for x in names.values()):
        raise ValueError('invalid preset names')
    if 'productVersion' in value and value['productVersion'] != 25: raise ValueError('invalid product version')
    metadata=value.get('routeMeta',{})
    if not isinstance(metadata,dict) or len(metadata)>202: raise ValueError('invalid route metadata')
    for key,item in metadata.items():
        if not ID.fullmatch(key) or not isinstance(item,dict) or set(item)-{'savedAt','created','migration'}: raise ValueError('invalid route metadata')
        if 'savedAt' in item and (not isinstance(item['savedAt'],str) or len(item['savedAt'])>50): raise ValueError('invalid saved time')
        if 'created' in item and not isinstance(item['created'],bool): raise ValueError('invalid created flag')
        if 'migration' in item and (not isinstance(item['migration'],str) or len(item['migration'])>100): raise ValueError('invalid migration')
    for key in ['home','office']:
        if key in value and value[key] is not None: coordinate(value[key])
    return value

class NewerClientRequired(Exception): pass
class Conflict(Exception): pass
class CorruptStore(Exception): pass

class RouteStore:
    def __init__(self,path):
        self.path=Path(path)
        self.lock=Lock()
    def _read(self):
        if not self.path.exists(): return {'version':10,'revision':0,'library':None}
        try:
            if self.path.stat().st_size>MAX_BYTES: raise ValueError()
            data=json.loads(self.path.read_text(encoding='utf-8'))
            if data.get('version')!=10 or type(data.get('revision')) is not int or data['revision']<0:
                raise ValueError()
            validate_library(data['library'])
            return data
        except (ValueError,KeyError,TypeError,UnicodeError,OSError) as error:
            raise CorruptStore('Stored routes need recovery; no overwrite performed') from error
    def read(self):
        with self.lock: return self._read()
    def save(self,revision,library,client_version=_INTERNAL_WRITE):
        if type(revision) is not int or revision<0: raise ValueError('invalid revision')
        validate_library(library)
        with self.lock:
            old=self._read()
            # Enforce against the exact state being replaced while holding the
            # write lock. A pre-lock HTTP read could race a newer client save.
            if client_version is not _INTERNAL_WRITE:
                existing=old.get('library') or {}
                if (existing.get('productVersion')==25 or library.get('productVersion')==25) and client_version!='25':
                    raise NewerClientRequired('Product metadata requires planner v25')
                if (has_control_metadata(existing) or has_control_metadata(library)) and client_version not in {'17','25'}:
                    raise NewerClientRequired('Control roles require planner v17')
                if any(r.get('roadRoute') for r in existing.get('customRoutes',[])) and client_version not in {'12','13','14','15','16','17','25'}:
                    raise NewerClientRequired('Road data requires a compatible planner')
            if old['revision']!=revision: raise Conflict('Another page saved first')
            data={'version':10,'revision':revision+1,'library':library}
            raw=json.dumps(data,ensure_ascii=False,allow_nan=False,indent=2).encode('utf-8')
            if len(raw)>MAX_BYTES: raise ValueError('route library too large')
            temp=self.path.with_suffix('.json.tmp')
            try:
                with temp.open('wb') as out:
                    out.write(raw); out.flush(); os.fsync(out.fileno())
                if self.path.exists():
                    backup=self.path.with_suffix('.json.bak')
                    backup_temp=self.path.with_suffix('.json.bak.tmp')
                    shutil.copy2(self.path,backup_temp)
                    os.replace(backup_temp,backup)
                os.replace(temp,self.path)
            finally:
                if temp.exists(): temp.unlink()
            return data
