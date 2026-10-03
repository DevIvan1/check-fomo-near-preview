"""Usage log for Check fomo: which wallets connect to the site or are searched on it.

POST /api/track   body (JSON, sent as text/plain): {"kind": "connect" | "manual" | "visit" | "search",
                                                    "account": "name.near", "wallet": "HOT Wallet"}

Stored in Upstash Redis (Vercel -> Storage -> Upstash for Redis, connected to this project):
  cf:last   sorted set  "kind|account" -> last time (ms, server clock)
  cf:first  sorted set  "kind|account" -> first time
  cf:count  hash        "kind|account" -> how many times
  cf:wallet hash        account -> wallet name used to connect
Only the account, the kind and the wallet name are stored. IP addresses are never stored: a hash of
the IP lives for two minutes as a rate-limit counter. tools/sync_wallets.py turns the log into a
text file. Nothing here can be read back over HTTP.
"""

import hashlib
import json
import os
import re
import time
import urllib.request
from http.server import BaseHTTPRequestHandler

ACCOUNT = re.compile(r'^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$')
KINDS = ('connect', 'manual', 'visit', 'search')
WALLET_JUNK = re.compile(r'[^A-Za-z0-9 ._()-]')
MAX_BODY = 1024
RATE_PER_MIN = 20  # per IP
MAX_ENTRIES = 50000  # the log stops growing past this (old entries still update)
# Pages served elsewhere that may post here; the site's own domain is always allowed.
EXTRA_ORIGINS = {'https://devivan1.github.io'}


def redis_conf():
    url = os.environ.get('KV_REST_API_URL') or os.environ.get('UPSTASH_REDIS_REST_URL')
    token = os.environ.get('KV_REST_API_TOKEN') or os.environ.get('UPSTASH_REDIS_REST_TOKEN')
    return (url.rstrip('/'), token) if url and token else (None, None)


def pipeline(cmds):
    url, token = redis_conf()
    req = urllib.request.Request(
        url + '/pipeline', data=json.dumps(cmds).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as r:
        out = json.loads(r.read())
    results = []
    for item in out:
        if isinstance(item, dict) and item.get('error'):
            raise RuntimeError(item['error'])
        results.append(item.get('result') if isinstance(item, dict) else None)
    return results


def parse(body):
    """-> (kind, account, wallet) or None for anything malformed."""
    try:
        data = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    kind, acc, wallet = data.get('kind'), data.get('account'), data.get('wallet')
    if kind not in KINDS or not isinstance(acc, str):
        return None
    acc = acc.strip().lower()
    if not (2 <= len(acc) <= 64 and ACCOUNT.match(acc)):
        return None
    wallet = WALLET_JUNK.sub('', wallet)[:40].strip() if isinstance(wallet, str) else ''
    return kind, acc, wallet


def record(kind, acc, wallet, ip, now_ms):
    """Writes one event; returns the HTTP status."""
    minute = int(now_ms // 60000)
    bucket = 'cf:rl:' + hashlib.sha256(f'{ip}|{minute}'.encode()).hexdigest()[:20]
    hits, _, size = pipeline([['INCR', bucket], ['EXPIRE', bucket, 120], ['ZCARD', 'cf:last']])
    if int(hits or 0) > RATE_PER_MIN:
        return 429
    member = f'{kind}|{acc}'
    if int(size or 0) >= MAX_ENTRIES and pipeline([['ZSCORE', 'cf:last', member]])[0] is None:
        return 204  # full: new entries are dropped quietly
    cmds = [
        ['ZADD', 'cf:last', now_ms, member],
        ['ZADD', 'cf:first', 'NX', now_ms, member],
        ['HINCRBY', 'cf:count', member, 1],
    ]
    if wallet and kind == 'connect':
        cmds.append(['HSET', 'cf:wallet', acc, wallet])
    pipeline(cmds)
    return 204


class handler(BaseHTTPRequestHandler):
    def allowed_origin(self):
        origin = self.headers.get('Origin') or ''
        host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or ''
        if origin and (origin in EXTRA_ORIGINS or origin == f'https://{host}'):
            return origin
        return None

    def reply(self, status, origin=None):
        self.send_response(status)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Max-Age', '86400')
        self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_OPTIONS(self):
        origin = self.allowed_origin()
        self.reply(204 if origin else 403, origin)

    def do_GET(self):
        self.reply(405)

    def do_POST(self):
        origin = self.allowed_origin()
        if not origin:
            self.reply(403)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self.reply(413 if length > MAX_BODY else 400, origin)
            return
        parsed = parse(self.rfile.read(length))
        if not parsed:
            self.reply(400, origin)
            return
        if not redis_conf()[0]:
            self.reply(503, origin)  # storage not connected yet
            return
        ip = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip() or self.client_address[0]
        try:
            status = record(*parsed, ip, int(time.time() * 1000))
        except Exception:  # storage down: the page does not care, nothing to retry
            status = 502
        self.reply(status, origin)

    def log_message(self, *args):
        pass
