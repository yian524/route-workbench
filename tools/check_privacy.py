"""Pre-push privacy scan. Run before every `git push`; exits 1 if anything is found.

Checks every file git would publish (tracked + untracked-not-ignored), or every file
when the folder is not a git repository:
  1. Generic patterns: e-mail addresses, Taiwan mobile numbers, API keys / tokens /
     private keys, Windows user-profile and synced-drive paths, precise coordinates.
  2. Your own terms from `.privacy-blocklist.txt` (one per line, # for comments).
     That file is git-ignored on purpose: the words you want to keep private must
     never be committed themselves.

Binary files (images) cannot be scanned; review screenshots by eye before committing.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCKLIST = ROOT / '.privacy-blocklist.txt'
TEXT_SUFFIXES = {'.html', '.js', '.css', '.json', '.py', '.md', '.txt', '.svg', ''}

GENERIC = {
    'e-mail address': r'[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
    'Taiwan mobile number': r'(?<!\d)09\d{2}-?\d{3}-?\d{3}(?!\d)',
    'Google API key': r'AIza[0-9A-Za-z_-]{30,}',
    'GitHub / OpenAI style token': r'\b(?:ghp|gho|github_pat|sk)-?_?[A-Za-z0-9]{20,}',
    'OAuth refresh/access token': r'"(?:refresh_token|access_token|client_secret)"\s*:',
    'private key': r'-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'user-profile path': r'(?i)(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"\']+|/c/Users/|AppData[\\/])',
    'synced-drive path': r'其他電腦|我的筆記型電腦',
    # A lat/lng pair with 5+ decimals that is not a round placeholder such as 25.00000.
    'precise coordinate': r'(?<![\d.])-?\d{1,2}\.(?!0{5,}\b)\d{5,}\s*[,，]\s*-?\d{1,3}\.\d{5,}',
}
ALLOW_LINES = (
    'example.com', 'Copyright (c) 2010-2023, Volodymyr Agafonkin',
)


def candidate_files():
    try:
        tracked = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-co', '--exclude-standard'],
                                 capture_output=True, text=True, encoding='utf-8', check=True).stdout.splitlines()
        return [ROOT / f for f in tracked]
    except (OSError, subprocess.CalledProcessError):
        return [p for p in ROOT.rglob('*') if p.is_file() and '.git' not in p.relative_to(ROOT).parts]


def load_blocklist():
    if not BLOCKLIST.is_file():
        return []
    return [line.strip() for line in BLOCKLIST.read_text('utf-8').splitlines()
            if line.strip() and not line.lstrip().startswith('#')]


def main():
    terms = load_blocklist()
    patterns = {name: re.compile(rx) for name, rx in GENERIC.items()}
    findings, skipped = [], []
    for path in candidate_files():
        rel = path.relative_to(ROOT).as_posix()
        if rel == '.privacy-blocklist.txt' or rel == 'tools/check_privacy.py':
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            skipped.append(rel)
            continue
        text = path.read_text('utf-8', errors='replace')
        for number, line in enumerate(text.splitlines(), 1):
            if any(allowed in line for allowed in ALLOW_LINES):
                continue
            for name, rx in patterns.items():
                for match in rx.finditer(line):
                    findings.append((rel, number, name, match.group(0)[:60]))
            lowered = line.lower()
            for term in terms:
                if term.lower() in lowered:
                    findings.append((rel, number, 'blocklist term', term))
    for rel, number, name, value in findings:
        print(f'FOUND {rel}:{number} [{name}] {value}')
    if skipped:
        print('Not scanned (binary, check by eye):', ', '.join(skipped))
    print(f"Blocklist terms: {len(terms)}{'' if terms else ' (no .privacy-blocklist.txt found)'}")
    if findings:
        print(f'{len(findings)} finding(s). Do not push until they are resolved.')
        sys.exit(1)
    print('OK: no private data patterns found.')


if __name__ == '__main__':
    main()
