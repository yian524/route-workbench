"""Loopback preview / reverse-proxy app origin. Public mode has no route-store API."""
from __future__ import annotations
import argparse,json,mimetypes,secrets,time,threading,sys,ipaddress,os,re
from collections import deque
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
HERE=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
sys.path.insert(0,str(HERE))
from planner_store_v10 import RouteStore,Conflict,CorruptStore,NewerClientRequired,MAX_BYTES
from planner_routing_v12 import ScooterRouter,RoutingFailure
from planner_search_v14 import PlaceSearch,SearchFailure

def map_configuration(environ=None):
    env=os.environ if environ is None else environ
    default='https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    url=env.get('PLANNER_TILE_URL',default)
    if url!=default and not all(env.get(k) for k in ('PLANNER_TILE_ATTRIBUTION','PLANNER_TILE_ATTRIBUTION_URL')):
        raise ValueError('custom tile provider requires attribution label and URL')
    parsed=urlsplit(url)
    if (parsed.scheme!='https' or not parsed.hostname or not re.fullmatch(r'[a-zA-Z0-9.-]+',parsed.hostname)
            or any(ord(ch)<32 for ch in url) or parsed.port is not None and not 1<=parsed.port<=65535
            or parsed.username or parsed.password or parsed.fragment
            or any(p not in url for p in ('{z}','{x}','{y}'))
            or re.search(r'[{}]',url.replace('{z}','0').replace('{x}','0').replace('{y}','0'))):
        raise ValueError('tile URL must be HTTPS with z/x/y placeholders and no credentials')
    label=env.get('PLANNER_TILE_ATTRIBUTION','© OpenStreetMap contributors')
    attribution=env.get('PLANNER_TILE_ATTRIBUTION_URL','https://www.openstreetmap.org/copyright')
    link=urlsplit(attribution)
    if not 1<=len(label)<=160 or link.scheme!='https' or not link.hostname or link.username or link.password:
        raise ValueError('invalid tile attribution')
    return {'url':url,'attribution':label,'attributionUrl':attribution,'maxNativeZoom':19},f'https://{parsed.netloc}'

def request_client_ip(peer,headers,trusted_proxies):
    """Only an explicitly trusted immediate proxy may supply one overwritten IP."""
    peer=str(ipaddress.ip_address(peer))
    if peer not in trusted_proxies:return peer
    values=headers.get_all('X-Real-IP',[])
    if len(values)!=1 or '%' in values[0]:raise ValueError('trusted proxy must overwrite X-Real-IP')
    return str(ipaddress.ip_address(values[0].strip()))

def handler_for(root,public_mode=False,public_origin=None,trusted_proxies=()):
    root=Path(root).resolve();public_mode=public_mode or (root/'PUBLIC_ONLY').is_file();store=RouteStore(root/'planner_saved_routes_v10.json') if not public_mode else None
    token=secrets.token_urlsafe(32);router=ScooterRouter();search=PlaceSearch();hits={};lock=threading.Lock()
    try:approved=json.loads((root/'routing_consent_v12.json').read_text('utf-8')).get('approved') is True
    except (OSError,ValueError):approved=False
    package=root if (root/'index.html').is_file() else root/('release_public_v25' if public_mode else 'personal_v25')
    origin=urlsplit(public_origin) if public_origin else None
    if origin and (origin.scheme!='https' or not origin.hostname or origin.path not in {'','/'} or origin.query or origin.fragment or origin.username or origin.password):raise ValueError('origin must be an HTTPS origin')
    trusted_proxies=frozenset(str(ipaddress.ip_address(p)) for p in trusted_proxies)
    if trusted_proxies and not origin:raise ValueError('trusted proxies require an explicit HTTPS origin')
    map_config,tile_origin=map_configuration()
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def log_message(self,*args):pass # Never log queries/coordinates.
        def trusted_origins(self):
            return {f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}|({public_origin.rstrip('/')} if public_origin else set())
        def parse_request(self):
            if not super().parse_request():return False
            hosts=self.headers.get_all('Host',[]);allowed={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}|({origin.netloc} if origin else set())
            if len(hosts)==1 and hosts[0].lower() in allowed:return True
            self.reply(403,b'Unrecognized host','text/plain');return False
        def reply(self,status,body,mime='application/json',asset=False,head=False):
            self.send_response(status);self.send_header('Content-Type',mime+('' if mime.startswith('image/') else '; charset=utf-8'));self.send_header('Content-Length',str(len(body)))
            # An early POST rejection may leave its body unread. Do not parse it as
            # the next request on a pooled HTTP/1.1 connection.
            if status>=400 and self.command=='POST':self.close_connection=True;self.send_header('Connection','close')
            self.send_header('Cache-Control','public, max-age=3600' if asset else 'no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','strict-origin-when-cross-origin');self.send_header('X-Frame-Options','SAMEORIGIN')
            self.send_header('Permissions-Policy','camera=(), microphone=(), geolocation=()')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: "+tile_origin+" https://wmts.nlsc.gov.tw https://streetviewpixels-pa.googleapis.com https://streetviewpixels-pa.clients6.google.com; frame-src https://www.google.com; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'")
            self.end_headers()
            if not head and self.command!='HEAD':self.wfile.write(body)
        def json(self,status,value,head=False):self.reply(status,json.dumps(value,ensure_ascii=False,allow_nan=False).encode(),'application/json',head=head)
        def api_allowed(self):
            values=self.headers.get_all('Origin',[])
            return len(values)<=1 and (not values or values[0] in self.trusted_origins()) and self.headers.get('Sec-Fetch-Site')!='cross-site'
        def do_HEAD(self):self.do_GET()
        def do_GET(self):
            path=urlsplit(self.path).path
            if path=='/api/map-config':
                if not self.api_allowed():self.json(403,{'error':'origin_rejected'});return
                self.json(200,map_config);return
            if path in {'/api/session','/api/routes'}:
                if not self.api_allowed():self.json(403,{'error':'origin_rejected'});return
                if path=='/api/routes' and public_mode:self.json(404,{'error':'not_found'});return
                if path=='/api/session':self.json(200,{'csrf':token,'mode':'browser-only' if public_mode else 'personal','version':25});return
                try:self.json(200,{**store.read(),'csrf':token})
                except (CorruptStore,OSError):self.json(503,{'error':'stored_library_needs_recovery'})
                return
            if path=='/health':self.json(200,{'service':'route-workbench','appVersion':25,'storage':'browser-only' if public_mode else 'local-file','public':public_mode,'ready':(package/'index.html').is_file()});return
            if path in {'/','/gallery.html','/planner_v17.html','/planner_v25_product.html'}:target=package/'index.html'
            elif path.startswith('/assets/') or path.startswith('/personal-assets/'):
                name=path.split('/',2)[-1];target=package/'assets'/name
                try:target.resolve().relative_to((package/'assets').resolve())
                except ValueError:self.reply(404,b'Not found','text/plain');return
                if target.suffix not in {'.js','.css','.json','.svg','.png','.jpg','.webp'}:self.reply(404,b'Not found','text/plain');return
            else:self.reply(404,b'Not found','text/plain');return
            if not target.is_file():self.reply(404,b'Not found','text/plain');return
            self.reply(200,target.read_bytes(),mimetypes.guess_type(target)[0] or 'application/octet-stream',asset=path.startswith('/assets/') or path.startswith('/personal-assets/'))
        def do_POST(self):
            path=urlsplit(self.path).path
            if path not in {'/api/routes','/api/scooter-route','/api/place-search'} or public_mode and path=='/api/routes':self.json(404,{'error':'not_found'});return
            tokens=self.headers.get_all('X-Planner-CSRF',[])
            if not self.api_allowed() or len(tokens)!=1 or not tokens[0].isascii() or not secrets.compare_digest(token,tokens[0]):self.json(403,{'error':'origin_or_csrf_rejected'});return
            lengths=self.headers.get_all('Content-Length',[])
            if len(lengths)!=1 or not lengths[0].isdigit() or int(lengths[0])>MAX_BYTES or self.headers.get('Transfer-Encoding'):self.json(413,{'error':'invalid_length'});return
            if self.headers.get_content_type()!='application/json':self.json(415,{'error':'json_required'});return
            if public_mode and path!='/api/routes':
                if self.headers.get('X-Planner-Consent')!='yes':self.json(403,{'error':'consent_required','message':'請先同意傳送位置資訊。'});return
                try:client_ip=request_client_ip(self.client_address[0],self.headers,trusted_proxies)
                except ValueError:self.json(400,{'error':'proxy_header_invalid','message':'代理伺服器來源設定不完整，請聯絡網站管理者。'});return
                with lock:
                    now=time.monotonic();key=client_ip;bucket=hits.setdefault(key,deque())
                    while bucket and bucket[0]<now-60:bucket.popleft()
                    if len(bucket)>=30:self.json(429,{'error':'rate_limited','message':'操作較頻繁，請稍候再試。'});return
                    bucket.append(now)
                    if len(hits)>1000:
                        for k in list(hits):
                            if not hits[k] or hits[k][-1]<now-120:del hits[k]
            try:
                self.connection.settimeout(30);payload=json.loads(self.rfile.read(int(lengths[0])).decode('utf-8'))
                if path=='/api/place-search':self.json(200,search.search(payload));return
                if path=='/api/scooter-route':
                    if not public_mode and not approved:self.json(403,{'error':'consent_required'});return
                    self.json(200,{'route':router.route(payload)});return
                if not isinstance(payload,dict) or set(payload)!={'version','expectedRevision','library'} or payload['version']!=10:raise ValueError()
                clients=self.headers.get_all('X-Planner-Client',[])
                if len(clients)!=1:raise ValueError()
                result=store.save(payload['expectedRevision'],payload['library'],client_version=clients[0]);self.json(200,{'version':10,'revision':result['revision']})
            except SearchFailure as e:self.json(e.status,{'error':'search_failed','message':str(e),'retryAfter':e.retry_after})
            except RoutingFailure as e:self.json(e.status,{'error':'routing_failed','message':str(e)})
            except Conflict:self.json(409,{'error':'revision_conflict'})
            except NewerClientRequired:self.json(409,{'error':'newer_client_required'})
            except (CorruptStore,OSError):self.json(503,{'error':'storage_unavailable','message':'儲存服務暫時無法使用。'})
            except (ValueError,TypeError,KeyError,UnicodeError):self.json(400,{'error':'invalid_request','message':'資料格式不正確，請重新確認。'})
    return Handler

def main():
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8788);p.add_argument('--public',action='store_true');p.add_argument('--origin',help='Exact HTTPS origin used by a trusted reverse proxy');p.add_argument('--trusted-proxy',action='append',default=[],help='Exact immediate proxy IP; it must overwrite X-Real-IP, not append user input');a=p.parse_args()
    if not 1024<=a.port<=65535:p.error('invalid port')
    a.public=a.public or (HERE/'PUBLIC_ONLY').is_file()
    try:handler=handler_for(HERE,a.public,a.origin,a.trusted_proxy)
    except ValueError as e:p.error(str(e))
    server=ThreadingHTTPServer(('127.0.0.1',a.port),handler);print(f'Local preview http://127.0.0.1:{a.port}/ public={a.public}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
if __name__=='__main__':main()
