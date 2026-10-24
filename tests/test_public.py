"""Public-edition tests. Run: python tests/test_public.py

No network: place search and routing upstreams are replaced by stubs.
Covers the HTTP security boundary, the public-only storage mode, bundled data,
release integrity and the privacy scan.
"""
import hashlib, http.client, json, subprocess, sys, threading, time, unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import serve_product_v25 as srv  # noqa: E402
import planner_routing_v12 as routing  # noqa: E402

LEAFLET_1_9_4_SHA256 = 'db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a'  # npm dist/leaflet.js


class StubSearch:
    def __init__(self, *a, **k): pass
    def search(self, payload): return {'results': []}


class PublicServer(unittest.TestCase):
    def setUp(self):
        self.patch = patch.object(srv, 'PlaceSearch', StubSearch); self.patch.start()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), srv.handler_for(ROOT, True))
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.patch.stop()

    def req(self, method='GET', path='/', body=b'', headers=None, host=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.putrequest(method, path, skip_host=True)
        c.putheader('Host', host or f'127.0.0.1:{self.port}')
        for k, v in (headers or {}).items(): c.putheader(k, v)
        if method == 'POST': c.putheader('Content-Length', str(len(body)))
        c.endheaders(body if method == 'POST' else None)
        r = c.getresponse(); out = (r.status, r.read(), dict(r.getheaders())); c.close(); return out

    def post(self, path, payload, extra=None):
        csrf = json.loads(self.req(path='/api/session')[1])['csrf']
        headers = {'Content-Type': 'application/json', 'X-Planner-CSRF': csrf, 'Origin': f'http://127.0.0.1:{self.port}'}
        headers.update(extra or {})
        return self.req('POST', path, json.dumps(payload).encode(), headers)

    def test_health_reports_public_browser_only(self):
        health = json.loads(self.req(path='/health')[1])
        self.assertEqual((health['public'], health['storage'], health['ready']), (True, 'browser-only', True))

    def test_no_server_side_route_store(self):
        self.assertEqual(self.req(path='/api/routes')[0], 404)
        self.assertEqual(self.post('/api/routes', {'version': 10})[0], 404)

    def test_only_page_and_assets_are_served(self):
        for path in ['/serve_product_v25.py', '/MANIFEST.json', '/README.md', '/LICENSE', '/PUBLIC_ONLY',
                     '/.gitignore', '/.privacy-blocklist.txt', '/tests/test_public.py', '/tools/check_privacy.py',
                     '/docs/screenshot.png', '/assets/../serve_product_v25.py', '/assets/..%2fMANIFEST.json',
                     '/assets/..\\..\\serve_product_v25.py', '/assets/script-0.js.map']:
            self.assertEqual(self.req(path=path)[0], 404, path)
        for path in ['/', '/assets/app.css', '/assets/script-2.js', '/assets/data.json']:
            self.assertEqual(self.req(path=path)[0], 200, path)

    def test_security_headers(self):
        _, _, headers = self.req(path='/')
        csp = headers.get('Content-Security-Policy', '')
        for directive in ["default-src 'self'", "script-src 'self'", "frame-ancestors 'self'", "object-src 'none'"]:
            self.assertIn(directive, csp)
        self.assertEqual(headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(headers.get('X-Frame-Options'), 'SAMEORIGIN')

    def test_rejects_rebinding_cross_site_and_missing_csrf(self):
        self.assertEqual(self.req(path='/api/session', host='attacker.example')[0], 403)
        self.assertEqual(self.req(path='/api/session', headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        status = self.req('POST', '/api/place-search', b'{}', {'Content-Type': 'application/json'})[0]
        self.assertEqual(status, 403)

    def test_location_services_need_consent(self):
        self.assertEqual(self.post('/api/place-search', {'query': 'x'})[0], 403)
        self.assertEqual(self.post('/api/scooter-route', {'points': []})[0], 403)

    def test_rate_limit_per_client(self):
        codes = [self.post('/api/place-search', {'query': 'x'}, {'X-Planner-Consent': 'yes'})[0] for _ in range(31)]
        self.assertEqual(codes[:30], [200] * 30)
        self.assertEqual(codes[30], 429)


class Bundle(unittest.TestCase):
    def test_bundled_data_is_empty(self):
        data = json.loads((ROOT / 'assets/data.json').read_text('utf-8'))
        self.assertTrue(data['publicEdition'])
        for key in ['presets', 'stations', 'embeds', 'handoffCandidates', 'signalEvidence']:
            self.assertEqual(data[key], [], key)
        self.assertEqual((data['home'], data['office'], data['computedPresets']), ({}, {}, {}))

    def test_leaflet_is_unmodified_upstream(self):
        raw = (ROOT / 'assets/script-0.js').read_bytes().replace(b'\r\n', b'\n')
        self.assertEqual(hashlib.sha256(raw).hexdigest(), LEAFLET_1_9_4_SHA256)

    def test_manifest_and_asset_versions_current(self):
        r = subprocess.run([sys.executable, str(ROOT / 'tools/release_manifest.py'), '--check'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_privacy_scan_clean(self):
        r = subprocess.run([sys.executable, str(ROOT / 'tools/check_privacy.py')], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class RoutingCapacity(unittest.TestCase):
    def test_single_routing_queue_refuses_concurrent_users(self):
        """Documents a known limit: one route computation at a time (see README)."""
        def slow_fetch(points, costing):
            time.sleep(1.0); raise routing.RoutingFailure('stub', 503)
        router = routing.ScooterRouter(fetcher=slow_fetch); results = []
        def call(i):
            try: router.route({'points': [{'lat': 1 + i, 'lng': 1}, {'lat': 1.01 + i, 'lng': 1.01}]})
            except routing.RoutingFailure as e: results.append(e.status)
        threads = [threading.Thread(target=call, args=(i,)) for i in range(3)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(sorted(results), [429, 429, 503])


if __name__ == '__main__':
    unittest.main(verbosity=2)
