"""Regression tests for the v29 acceptance fixes (offline; no network).

Run: py -3 -X utf8 verify_acceptance_v29.py
Covers search ranking, the 台/臺 retry, the approximate-address fallback, throttling of the
extra upstream calls, and the specific routing failure messages.
"""
import io, json, sys, unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent if (HERE.parent / 'planner_search_v14.py').is_file() else HERE
sys.path.insert(0, str(ROOT))
import planner_search_v14 as search  # noqa: E402
import planner_routing_v12 as routing  # noqa: E402


def feature(name, lat, lng, kind='attraction', **props):
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lng, lat]},
            'properties': {'name': name, 'osm_value': kind, **props}}


class Resp:
    status = 200
    def __init__(self, features): self.raw = json.dumps({'features': features}).encode(); self.headers = {'Content-Type': 'application/json'}
    def read(self, n): return self.raw[:n]
    def __enter__(self): return self
    def __exit__(self, *a): return False


class Opener:
    """Answers by query text; records every upstream query."""
    def __init__(self, answers): self.answers = answers; self.queries = []
    def open(self, req, timeout):
        q = parse_qs(urlsplit(req.full_url).query)['q'][0]; self.queries.append(q)
        return Resp(self.answers.get(q, []))


def searcher(answers):
    waits = []; clock = [0.0]
    def sleep(s): waits.append(s); clock[0] += s
    op = Opener(answers)
    return search.PlaceSearch(opener=op, clock=lambda: clock[0], sleeper=sleep), op, waits


class Ranking(unittest.TestCase):
    def test_cluster_beats_isolated_namesakes(self):
        rows = search.normalize_reply({'features': [
            feature('Sagrada Família', -29.8, -51.2, 'municipality', city='RS'),
            feature('Sagrada Família', -20.4, -40.8, 'village'),
            feature('Sagrada Família', 41.4036, 2.1744, 'stop'), feature('Sagrada Família', 41.4037, 2.1746, 'station'),
            feature('Basílica de la Sagrada Família', 41.4036, 2.1743, 'place_of_worship')]}, 'world', 15)
        self.assertAlmostEqual(search.rank_results(rows, 'Sagrada Família')[0]['lat'], 41.4, places=1)

    def test_photon_first_exact_landmark_is_kept(self):
        rows = search.normalize_reply({'features': [
            feature('CN Tower', 43.6426, -79.3871, 'tower'),
            feature('Shanghai Tower', 31.2335, 121.5056), feature('Shanghai Tower Hotel', 31.2336, 121.5057, 'hotel'),
            feature('Oriental Pearl Tower', 31.2397, 121.4998, 'tower')]}, 'world', 15)
        self.assertEqual(search.rank_results(rows, 'CN Tower')[0]['name'], 'CN Tower')

    def test_results_still_capped_at_8(self):
        rows = search.normalize_reply({'features': [feature(f'P{i}', 25 + i, 121) for i in range(15)]}, 'world', 15)
        self.assertEqual(len(rows), 15)
        self.assertEqual(len(search.rank_results(rows, 'P')), search.MAX_RESULTS)


class Lookup(unittest.TestCase):
    def test_tai_variant_retry(self):
        s, op, waits = searcher({'臺中國家歌劇院': [feature('臺中國家歌劇院', 24.163, 120.6403, 'theatre')]})
        res = s.search({'query': '台中國家歌劇院', 'scope': 'world'})
        self.assertEqual(op.queries, ['台中國家歌劇院', '臺中國家歌劇院'])
        self.assertEqual(res['results'][0]['name'], '臺中國家歌劇院')
        self.assertEqual(waits, [search.MIN_INTERVAL])  # the extra call is still throttled

    def test_address_fallback_filters_city_and_labels_approximate(self):
        s, op, _ = searcher({'重慶南路一段': [
            feature('重慶南路一段', 23.9, 106.6, 'residential', country='中国', city='百色市'),
            feature('重慶南路一段', 25.0402, 121.5121, 'tertiary', country='臺灣', city='臺北市', district='中正區')]})
        res = s.search({'query': '臺北市中正區重慶南路一段122號', 'scope': 'world'})
        self.assertEqual(op.queries[-1], '重慶南路一段')
        self.assertEqual(len(op.queries), 3)  # query, 台 variant, street
        top = res['results'][0]
        self.assertIn('臺北市', top['address']); self.assertTrue(top['address'].startswith('近似結果'))
        self.assertIn('找不到這個門牌', res['notice'])

    def test_matching_query_makes_single_call(self):
        s, op, waits = searcher({'Times Square': [feature('Times Square', 40.758, -73.9855, 'square')]})
        s.search({'query': 'Times Square', 'scope': 'world'})
        self.assertEqual((op.queries, waits), (['Times Square'], []))

    def test_simplified_address_parsing(self):
        self.assertEqual(search.simplified_address('臺北市中正區重慶南路一段122號'), ('重慶南路一段', ['臺北市', '中正區']))
        self.assertEqual(search.simplified_address('新北市板橋區縣民大道二段7號'), ('縣民大道二段', ['新北市', '板橋區']))
        self.assertEqual(search.simplified_address('東京都千代田区丸の内1丁目9')[0], '丸の内')
        self.assertIsNone(search.simplified_address('Times Square'))
        self.assertIsNone(search.simplified_address('重慶南路一段'))


class RoutingMessages(unittest.TestCase):
    def test_no_road_near_point_171(self):
        err = HTTPError(routing.UPSTREAM, 400, 'bad', {}, io.BytesIO(b'{"error_code":171,"error":"No suitable edges near location"}'))
        with patch.object(routing, 'urlopen', side_effect=err):
            with self.assertRaises(routing.RoutingFailure) as ctx:
                routing.fetch_route([{'lat': 48.86, 'lng': 2.30}, {'lat': 48.87, 'lng': 2.31}])
        self.assertEqual(ctx.exception.status, 422); self.assertIn('100 公尺內沒有機車能走的道路', str(ctx.exception))

    def test_distance_over_250km_is_422_not_400(self):
        router = routing.ScooterRouter(fetcher=lambda *a: self.fail('must not call upstream'))
        with self.assertRaises(routing.RoutingFailure) as ctx:
            router.route({'points': [{'lat': 25.0478, 'lng': 121.517}, {'lat': 22.6394, 'lng': 120.3022}]})
        self.assertEqual(ctx.exception.status, 422); self.assertIn('250 公里', str(ctx.exception))

    def test_shape_over_1000_nodes_has_clear_message(self):
        nodes = [{'lat': 25 + i * 1e-4, 'lng': 121.5} for i in range(1200)]
        def enc(v):
            v = ~(v << 1) if v < 0 else v << 1; out = ''
            while v >= 0x20: out += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
            return out + chr(v + 63)
        shape, plat, plng = '', 0, 0
        for n in nodes:
            la, ln = round(n['lat'] * 1e6), round(n['lng'] * 1e6); shape += enc(la - plat) + enc(ln - plng); plat, plng = la, ln
        reply = {'trip': {'status': 0, 'summary': {'length': 13.3, 'time': 1800}, 'legs': [{'shape': shape, 'maneuvers': []}]}}
        with self.assertRaises(routing.RoutingFailure) as ctx:
            routing.normalize(reply, [nodes[0], nodes[-1]])
        self.assertEqual(ctx.exception.status, 422); self.assertIn('1,000 個道路節點', str(ctx.exception))


if __name__ == '__main__':
    unittest.main(verbosity=2)
