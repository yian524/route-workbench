"""Bounded Photon search; only explicit queries leave this process.

Docs: https://github.com/komoot/photon/blob/master/docs/api-v1.md
Usage: https://github.com/komoot/photon#demo-server
No map center, saved route, disk cache, query log, API key, or billing.
"""
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from math import asin, ceil, cos, isfinite, sin, sqrt
from threading import Lock
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
import json
import re
import unicodedata

UPSTREAM = 'https://photon.komoot.io/api/'
USER_AGENT = 'RouteWorkbench/25 (self-hosted route planner; Photon/OSM)'
SOURCE = 'Photon / OpenStreetMap'
ATTRIBUTION = {'label': SOURCE, 'url': 'https://photon.komoot.io/',
               'dataLabel': '\u00a9 OpenStreetMap contributors',
               'dataUrl': 'https://www.openstreetmap.org/copyright'}
TW_BBOX = (118.0, 21.0, 123.0, 27.0)
MAX_RESPONSE = 512_000
MAX_RESULTS = 8
# Photon ranks better with a wider candidate list; we re-rank and still return MAX_RESULTS.
FETCH_LIMIT = 15
# Results this close together are treated as the same place when ranking.
CLUSTER_KM = 1.5
CLUSTER_CAP = 5
LANDMARK_KINDS = frozenset({
    'attraction', 'tower', 'monument', 'memorial', 'museum', 'castle', 'palace', 'archaeological_site',
    'place_of_worship', 'cathedral', 'theatre', 'arts_centre', 'stadium', 'station', 'train_station_building',
    'square', 'viewpoint', 'government', 'university', 'zoo', 'aquarium', 'theme_park', 'tomb', 'ruins'})
# CJK street addresses Photon cannot parse: \u81fa\u5317\u5e02\u4e2d\u6b63\u5340\u798f\u5dde\u885716\u865f, \u6771\u4eac\u90fd\u5343\u4ee3\u7530\u533a\u4e38\u306e\u51851\u4e01\u76ee9.
ADDRESS_HINT = re.compile(r'[\u8def\u8857\u6bb5\u5df7\u5f04\u865f\u53f7]|\u5927\u9053|\u4e01\u76ee|\u756a\u5730')
ADMIN_PREFIX = re.compile(r'^(?:(?P<city>[^\s\d]{1,3}?[\u5e02\u7e23\u53bf\u90fd\u5e9c])(?P<district>[^\s\d]{1,4}?[\u5340\u533a\u9109\u4e61\u93ae\u9547\u5e02\u753a\u6751])?'
                          r'|(?P<district2>[^\s\d]{1,4}?[\u5340\u533a\u9109\u4e61\u93ae\u9547]))')
MIN_INTERVAL = 1.1
CACHE_TTL = 900.0
CACHE_LIMIT = 128
TIMEOUT = 20


class SearchFailure(Exception):
    def __init__(self, status, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) - {'query', 'scope'} or 'query' not in payload:
        raise SearchFailure(400, '搜尋格式不正確；請只提供地點名稱與搜尋範圍。')
    query = payload['query']
    if not isinstance(query, str) or any(unicodedata.category(ch).startswith('C') for ch in query):
        raise SearchFailure(400, '搜尋文字不可包含控制字元。')
    query = ' '.join(query.strip().split())
    if not 2 <= len(query) <= 160:
        raise SearchFailure(400, '請輸入 2～160 個字的地址或地點名稱。')
    if re.search(r'(?i)(?:\b[a-z][a-z0-9+.-]*://|\b(?:https?|ftp|file|javascript|data):|\bwww\.|^//|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|\b)|(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}[:/])', query):
        raise SearchFailure(400, '請輸入地址或地點名稱，不要貼網站網址。')
    scope = payload.get('scope', 'tw')
    if scope not in ('tw', 'world'):
        raise SearchFailure(400, '搜尋範圍必須是臺灣或全球。')
    return query, scope


def _text(value, limit=200):
    if not isinstance(value, str):
        return ''
    return ''.join(ch for ch in value if not unicodedata.category(ch).startswith('C')).strip()[:limit]


def _norm(value):
    """Compare names regardless of width, case, spacing and the 台/臺 variant."""
    text = unicodedata.normalize('NFKC', value or '').lower().replace('台', '臺')
    return re.sub(r'[\s,，/／·・\-]', '', text)


def _km(a, b):
    p = 0.017453292519943295
    h = (sin((b['lat'] - a['lat']) * p / 2) ** 2
         + cos(a['lat'] * p) * cos(b['lat'] * p) * sin((b['lng'] - a['lng']) * p / 2) ** 2)
    return 12742 * asin(min(1.0, sqrt(h)))


def rank_results(rows, query):
    """Order by how many results agree on the same spot, then landmark/exact name, then Photon's order.

    A famous place usually comes back as several nearby features (the landmark, its station,
    stops, square); unrelated namesakes elsewhere are isolated. Ties keep Photon's order.
    Photon's own first result stays first when it is a landmark with exactly the queried name.
    """
    if not rows:
        return []
    wanted = _norm(query)
    def key(item):
        index, row = item
        support = sum(1 for other in rows if _km(row, other) <= CLUSTER_KM)
        strong = row['kind'] in LANDMARK_KINDS or _norm(row['name']) == wanted
        return (-min(support, CLUSTER_CAP), 0 if strong else 1, index)
    ordered = [row for _, row in sorted(enumerate(rows), key=key)]
    first = rows[0]
    if first['kind'] in LANDMARK_KINDS and _norm(first['name']) == wanted:
        ordered.remove(first)
        ordered.insert(0, first)
    return ordered[:MAX_RESULTS]


def name_matches(rows, query):
    wanted = _norm(query)
    return any(wanted in _norm(row['name']) or _norm(row['name']) in wanted for row in rows if row['name'])


def variant_query(query):
    """The other spelling of 台/臺, or None."""
    if '臺' in query:
        return query.replace('臺', '台')
    if '台' in query:
        return query.replace('台', '臺')
    return None


def simplified_address(query):
    """('重慶南路一段', ['臺北市', '中正區']) for '臺北市中正區重慶南路一段122號'; None when not an address."""
    if not ADDRESS_HINT.search(query):
        return None
    head = re.sub(r'\s*\d.*$', '', query).strip()
    match = ADMIN_PREFIX.match(head)
    admin = [v for v in (match.groupdict().values() if match else []) if v]
    street = head[match.end():].strip() if match else head
    if len(street) < 2 or street == query:
        return None
    return street, admin


def normalize_reply(data, scope, limit=MAX_RESULTS):
    if not isinstance(data, dict) or not isinstance(data.get('features'), list) or len(data['features']) > 1000:
        raise SearchFailure(502, '地點服務回傳格式不完整，請稍後重試。')
    rows, seen, malformed = [], set(), 0
    for feature in data['features']:
        if not isinstance(feature, dict):
            malformed += 1
            continue
        prop, geometry = feature.get('properties'), feature.get('geometry')
        if not isinstance(prop, dict) or not isinstance(geometry, dict) or geometry.get('type') != 'Point':
            malformed += 1
            continue
        xy = geometry.get('coordinates')
        if not isinstance(xy, list) or len(xy) < 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not isfinite(v) for v in xy[:2]):
            malformed += 1
            continue
        lng, lat = float(xy[0]), float(xy[1])
        if not -180 <= lng <= 180 or not -90 <= lat <= 90:
            malformed += 1
            continue
        countrycode = _text(prop.get('countrycode'), 10).lower()
        if scope == 'tw' and (not (TW_BBOX[0] <= lng <= TW_BBOX[2] and TW_BBOX[1] <= lat <= TW_BBOX[3]) or countrycode not in ('', 'tw')):
            continue
        parts = []
        for key in ('country', 'state', 'county', 'city', 'district', 'locality', 'street', 'housenumber', 'postcode'):
            value = _text(prop.get(key))
            if value and value not in parts:
                parts.append(value)
        address = ' · '.join(parts)[:600]
        kind = _text(prop.get('osm_value') or prop.get('type'), 60) or 'place'
        if prop.get('osm_key') == 'building' and kind == 'train_station':
            kind = 'train_station_building'
        name = _text(prop.get('name'))
        if not name:
            # A building's street address is not the building's name.
            name = '未提供名稱'
            street = _text(prop.get('street'))
            if street:
                name += '（' + street + '附近）'
        identity = (name, address, kind, round(lat, 7), round(lng, 7))
        if identity in seen:
            continue
        seen.add(identity)
        rows.append({'name': name, 'address': address, 'lat': lat, 'lng': lng, 'source': SOURCE, 'kind': kind})
        if len(rows) >= limit:
            break
    if data['features'] and malformed == len(data['features']):
        raise SearchFailure(502, '地點服務沒有回傳有效座標，請稍後重試。')
    return rows


def _retry_seconds(headers):
    value = (headers or {}).get('Retry-After', '')
    try:
        seconds = float(value)
        if not isfinite(seconds):
            raise ValueError()
    except (ValueError, TypeError):
        try:
            stamp = parsedate_to_datetime(value)
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            seconds = (stamp - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            seconds = 60
    return max(30, min(600, ceil(seconds)))


class PlaceSearch:
    def __init__(self, *, opener=None, clock=None, sleeper=None):
        # Injection is for tests; HTTP input cannot override transport or URL.
        self._opener = opener or build_opener(_NoRedirect())
        self._clock = clock or monotonic
        self._sleep = sleeper or sleep
        self._lock = Lock()
        self._cache = OrderedDict()
        self._last_request = None
        self._blocked_until = 0.0

    def _fetch(self, query, scope):
        params = {'q': query, 'limit': str(FETCH_LIMIT)}
        # An English query should expose English names when the provider has
        # them. This changes labels, not an invented translation or extra call.
        if query.isascii() and any(ch.isalpha() for ch in query):
            params['lang'] = 'en'
        if scope == 'tw':
            params.update(bbox=','.join(str(x) for x in TW_BBOX), countrycode='TW')
        # Do not transmit map center or silently restrict worldwide queries.
        req = Request(UPSTREAM + '?' + urlencode(params), headers={
            'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Accept-Encoding': 'identity'})
        try:
            with self._opener.open(req, timeout=TIMEOUT) as response:
                if response.status != 200:
                    raise SearchFailure(502, '地點搜尋服務暫時無法回應，請稍後重試。')
                ctype = response.headers.get('Content-Type', '').split(';')[0].strip().lower()
                if ctype not in ('application/json', 'application/geo+json'):
                    raise SearchFailure(502, '地點服務回傳的內容不是地點資料，請稍後重試。')
                size = response.headers.get('Content-Length')
                if size and (not str(size).isdigit() or int(size) > MAX_RESPONSE):
                    raise SearchFailure(502, '地點服務回傳資料過大，請縮短搜尋文字。')
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise SearchFailure(502, '地點服務回傳資料過大，請縮短搜尋文字。')
                data = json.loads(raw.decode('utf-8'))
                return normalize_reply(data, scope, FETCH_LIMIT)
        except HTTPError as error:
            error.close()
            if error.code == 429:
                retry = _retry_seconds(error.headers)
                self._blocked_until = self._clock() + retry
                raise SearchFailure(429, '免費地點服務目前限制查詢頻率，請稍後重試。', retry) from None
            if 300 <= error.code < 400:
                raise SearchFailure(502, '地點服務網址發生變更，已停止轉送查詢。') from None
            raise SearchFailure(503, '免費地點服務暫時無法使用，請稍後再試。') from None
        except (URLError, TimeoutError, OSError):
            raise SearchFailure(503, '地點搜尋連線逾時或暫時中斷，請稍後再試。') from None
        except (ValueError, UnicodeError, RecursionError):
            raise SearchFailure(502, '地點服務回傳資料無法辨識，請稍後重試。') from None

    def _throttled_fetch(self, query, scope):
        """One upstream call, spaced MIN_INTERVAL from the previous one (caller holds the lock)."""
        now = self._clock()
        if now < self._blocked_until:
            raise SearchFailure(429, '免費地點服務尚在冷卻中，請稍後重試。', ceil(self._blocked_until - now))
        if self._last_request is not None:
            wait = MIN_INTERVAL - (now - self._last_request)
            if wait > 0:
                self._sleep(wait)
        self._last_request = self._clock()
        return self._fetch(query, scope)

    def _lookup(self, query, scope):
        """Up to 3 upstream calls: the query, its 台/臺 variant, then the street of a CJK address."""
        rows = rank_results(self._throttled_fetch(query, scope), query)
        if name_matches(rows, query):
            return rows, None
        alternate = variant_query(query)
        if alternate:
            others = rank_results(self._throttled_fetch(alternate, scope), alternate)
            if name_matches(others, alternate):
                return others, None
        address = simplified_address(query)
        if not address:
            return rows, None
        street, admin = address
        found = self._throttled_fetch(street, scope)
        hints = [_norm(a) for a in admin]
        local = [r for r in found if any(h in _norm(r['address']) for h in hints)] if hints else found
        nearby = rank_results(local or found, street)
        if not nearby:
            return rows, None
        for row in nearby:
            row['address'] = '近似結果（未找到門牌）· ' + row['address']
        merged, seen = [], set()
        for row in nearby + rows:
            key = (row['name'], round(row['lat'], 6), round(row['lng'], 6))
            if key not in seen:
                seen.add(key); merged.append(row)
        return merged[:MAX_RESULTS], street

    def search(self, payload):
        query, scope = validate_payload(payload)
        key = (query, scope)
        with self._lock:
            now = self._clock()
            for expired in [k for k, (stamp, _) in self._cache.items() if stamp <= now]:
                del self._cache[expired]
            if key in self._cache:
                _, value = self._cache[key]
                self._cache.move_to_end(key)
                return {**deepcopy(value), 'cached': True}
            if now < self._blocked_until:
                raise SearchFailure(429, '免費地點服務尚在冷卻中，請稍後重試。', ceil(self._blocked_until - now))
            rows, approximate = self._lookup(query, scope)
            notice = '免費地點資料可能不完整；地點座標不一定是可騎乘的道路入口。'
            if approximate:
                notice = f'找不到這個門牌，先列出「{approximate}」的位置；請在地圖上確認門牌。' + notice
            result = {'results': rows, 'attribution': deepcopy(ATTRIBUTION),
                      'provider': 'photon_osm', 'scope': scope, 'cached': False, 'notice': notice}
            self._cache[key] = (self._clock() + CACHE_TTL, deepcopy(result))
            while len(self._cache) > CACHE_LIMIT:
                self._cache.popitem(last=False)
            return result
