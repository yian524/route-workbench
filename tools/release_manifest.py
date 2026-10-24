"""Refresh asset cache-busting versions in index.html and write MANIFEST.json.

Usage:
  python tools/release_manifest.py          # refresh ?v= hashes and rewrite MANIFEST.json
  python tools/release_manifest.py --check  # verify both are current (exit 1 if not)

MANIFEST.json lists the SHA-256 of every deployable file, so a deployment can be
checked against the reviewed release. tests/, tools/ and docs/ are not deployed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {'.git', 'tests', 'tools', 'docs', '__pycache__'}
SKIP_FILES = {'MANIFEST.json', '.gitignore', '.privacy-blocklist.txt'}
ASSET_REF = re.compile(r'(assets/[A-Za-z0-9._-]+)\?v=([0-9a-f]{12})')


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def deployable_files():
    for path in sorted(ROOT.rglob('*')):
        rel = path.relative_to(ROOT)
        if path.is_file() and not SKIP_DIRS.intersection(rel.parts) and rel.name not in SKIP_FILES:
            yield rel


def refreshed_index() -> str:
    html = (ROOT / 'index.html').read_text('utf-8')
    return ASSET_REF.sub(lambda m: f'{m.group(1)}?v={sha256(ROOT / m.group(1))[:12]}', html)


def manifest() -> dict:
    return {'version': 25, 'uiVersion': 28, 'publicOnly': True,
            'files': {rel.as_posix(): sha256(ROOT / rel) for rel in deployable_files()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    index_now = (ROOT / 'index.html').read_text('utf-8')
    if args.check:
        problems = []
        if refreshed_index() != index_now:
            problems.append('index.html asset ?v= hashes are stale')
        try:
            stored = json.loads((ROOT / 'MANIFEST.json').read_text('utf-8'))
        except (OSError, ValueError):
            stored = None
        if stored != manifest():
            problems.append('MANIFEST.json does not match the files')
        for problem in problems:
            print('FAIL:', problem)
        if problems:
            sys.exit(1)
        print(f"OK: {len(stored['files'])} files match MANIFEST.json; asset versions current")
        return
    (ROOT / 'index.html').write_text(refreshed_index(), 'utf-8')
    data = manifest()
    (ROOT / 'MANIFEST.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(f"Wrote MANIFEST.json with {len(data['files'])} files")


if __name__ == '__main__':
    main()
