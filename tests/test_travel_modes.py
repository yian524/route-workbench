"""Regression tests for v30 travel modes (offline; no network).

Run: py -3 -X utf8 verify_travel_modes_v30.py
Car, bicycle and walking routes alongside the two motorcycle models: accepted profiles, Valhalla
travel-type checks, motorway handling, mode-specific texts, request options and storage.
"""
import io, json, sys, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent if (HERE.parent / 'planner_routing_v12.py').is_file() else HERE
sys.path.insert(0, str(ROOT))
import planner_routing_v12 as routing  # noqa: E402
from planner_store_v10 import validate_library  # noqa: E402

A, B = {'lat': 25.0400, 'lng': 121.5000}, {'lat': 25.0410, 'lng': 121.5010}


def polyline(points):
    def enc(v):
        v = ~(v << 1) if v < 0 else v << 1; out = ''
        while v >= 0x20: out += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
        return out + chr(v + 63)
    out, plat, plng = '', 0, 0
    for p in points:
        la, ln = round(p['lat'] * 1e6), round(p['lng'] * 1e6); out += enc(la - plat) + enc(ln - plng); plat, plng = la, ln
    return out


def reply(travel_mode, travel_type, highway=False, turn=15):
    maneuvers = [{'type': 1, 'begin_shape_index': 0, 'street_names': ['甲路'], 'length': 0.1, 'time': 20, 'travel_mode': travel_mode, 'travel_type': travel_type},
                 {'type': turn, 'begin_shape_index': 1, 'street_names': ['乙路'], 'length': 0.05, 'time': 10, 'travel_mode': travel_mode, 'travel_type': travel_type},
                 {'type': 4, 'begin_shape_index': 2, 'street_names': [], 'length': 0, 'time': 0, 'travel_mode': travel_mode, 'travel_type': travel_type}]
    shape = [A, {'lat': 25.0405, 'lng': 121.5005}, B]
    return {'trip': {'status': 0, 'summary': {'length': 0.15, 'time': 30, 'has_highway': highway}, 'legs': [{'shape': polyline(shape), 'maneuvers': maneuvers}]}}


class Profiles(unittest.TestCase):
    def test_all_five_modes_offered(self):
        self.assertEqual(set(routing.MODES), {'motorcycle', 'motor_scooter', 'auto', 'bicycle', 'pedestrian'})

    def test_unknown_profile_rejected(self):
        with self.assertRaises(ValueError):
            routing.ScooterRouter(fetcher=lambda *a: self.fail('no upstream')).route({'points': [A, B], 'profile': 'truck'})

    def test_each_mode_accepts_its_own_valhalla_travel_type(self):
        for costing, mode, ttype in [('motorcycle', 'drive', 'motorcycle'), ('motor_scooter', 'drive', 'motor_scooter'),
                                     ('auto', 'drive', 'car'), ('bicycle', 'bicycle', 'hybrid'), ('bicycle', 'bicycle', 'road'),
                                     ('pedestrian', 'pedestrian', 'foot')]:
            with self.subTest(costing=costing, travel_type=ttype):
                r = routing.normalize(reply(mode, ttype), [A, B], costing)
                self.assertEqual(r['costing'], costing)

    def test_mismatched_travel_type_is_rejected(self):
        with self.assertRaises(routing.RoutingFailure):
            routing.normalize(reply('drive', 'motorcycle'), [A, B], 'auto')
        with self.assertRaises(routing.RoutingFailure):
            routing.normalize(reply('drive', 'car'), [A, B], 'pedestrian')


class ModeRules(unittest.TestCase):
    def test_motorways_rejected_for_two_wheelers_only(self):
        with self.assertRaises(routing.RoutingFailure):
            routing.normalize(reply('drive', 'motorcycle', highway=True), [A, B], 'motorcycle')
        self.assertEqual(routing.normalize(reply('drive', 'car', highway=True), [A, B], 'auto')['costing'], 'auto')

    def test_two_stage_turn_note_only_for_two_wheelers(self):
        moto = routing.normalize(reply('drive', 'motorcycle'), [A, B], 'motorcycle')['steps'][1]['instruction']
        car = routing.normalize(reply('drive', 'car'), [A, B], 'auto')['steps'][1]['instruction']
        walk = routing.normalize(reply('pedestrian', 'foot'), [A, B], 'pedestrian')['steps'][1]['instruction']
        self.assertIn('兩段式待轉', moto)
        self.assertNotIn('兩段式待轉', car); self.assertNotIn('兩段式待轉', walk)

    def test_mode_specific_warning_and_time_note(self):
        for costing, mode, ttype, word in [('auto', 'drive', 'car', '汽車'), ('bicycle', 'bicycle', 'hybrid', '自行車'), ('pedestrian', 'pedestrian', 'foot', '步行')]:
            r = routing.normalize(reply(mode, ttype), [A, B], costing)
            self.assertIn(word, r['steps'][0]['warning'])
            self.assertNotIn('機車', r['steps'][0]['warning'] + r['timeNote'])

    def test_motorcycle_only_options_sent_for_two_wheelers(self):
        bodies = []
        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return json.dumps(reply('drive', 'car')).encode()
        def fake(req, timeout): bodies.append(json.loads(req.data)); return Resp()
        with patch.object(routing, 'urlopen', side_effect=fake):
            routing.fetch_route([A, B], 'motorcycle'); routing.fetch_route([A, B], 'auto'); routing.fetch_route([A, B], 'pedestrian')
        self.assertIn('exclude_highways', bodies[0]['costing_options']['motorcycle'])
        self.assertEqual(bodies[1]['costing_options'], {}); self.assertEqual(bodies[2]['costing_options'], {})
        self.assertEqual([b['costing'] for b in bodies], ['motorcycle', 'auto', 'pedestrian'])


class Storage(unittest.TestCase):
    def library(self, costing):
        nodes = [A, B]
        step = {'road': '甲路', 'turnKind': 'start', 'instruction': '出發', 'warning': 'w', 'shapeIndex': 0, 'start': A,
                'distanceMeters': 150, 'durationSeconds': 30}
        route = {'id': 'R1', 'name': '測試', 'points': [{**A, 'shapeIndex': 0}, {**B, 'shapeIndex': 1}],
                 'editShape': {'nodes': nodes},
                 'roadRoute': {'provider': 'valhalla_fossgis', 'costing': costing, 'pointKey': 'k', 'distanceMeters': 150,
                               'durationSeconds': 30, 'computedAt': '2026-10-24T00:00:00+00:00', 'steps': [step]}}
        return {'version': 10, 'customRoutes': [route]}

    def test_new_modes_can_be_saved(self):
        for costing in ['motorcycle', 'motor_scooter', 'auto', 'bicycle', 'pedestrian']:
            with self.subTest(costing=costing):
                validate_library(self.library(costing))

    def test_unknown_mode_cannot_be_saved(self):
        with self.assertRaises(ValueError):
            validate_library(self.library('truck'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
