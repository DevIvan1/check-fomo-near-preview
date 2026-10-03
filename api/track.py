"""Usage log for Check fomo: which wallets connect to the site or are searched on it.

POST /api/track   body (JSON, sent as text/plain): {"kind": "connect" | "manual" | "visit" | "search",
                                                    "account": "name.near", "wallet": "HOT Wallet",
                                                    "by": "who-searched.near"}   (by: searches only)
GET  /api/track   -> {"ok": true, "storage": true | false}   (is the storage connected; no data;
                     while it is not, also the names of storage-like variables, never their values)

Storage: the Redis database connected to the Vercel project (Vercel -> Storage). Either a plain Redis
(REDIS_URL = redis://user:password@host:port, Redis Cloud) or Upstash's REST API (KV_REST_API_URL +
KV_REST_API_TOKEN); Vercel's names with or without a custom prefix are found. Keys:
  cf:last   sorted set  member -> last time (ms, server clock)
  cf:first  sorted set  member -> first time
  cf:count  hash        member -> how many times
  cf:wallet hash        account -> wallet name used to connect
  member: "connect|account", "manual|account", "visit|account" (who uses the site) or
          "search|who|account" (who = the signed-in wallet that searched, "-" when nobody was signed in)
Only accounts, the kind and the wallet name are stored. IP addresses are never stored: a hash of
the IP lives for two minutes as a rate-limit counter. tools/sync_wallets.py (which reuses the storage
code below) turns the log into an Excel table. The log itself cannot be read over HTTP.
"""

import hashlib
import json
import os
import re
import socket
import ssl
import time
import urllib.parse
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

# ---------- storage: Upstash REST or plain Redis (RESP over TCP/TLS), standard library only ----------

REST_VARS = (('KV_REST_API_URL', 'KV_REST_API_TOKEN'), ('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'),
             ('REDIS_REST_URL', 'REDIS_REST_TOKEN'))
URL_VARS = ('REDIS_URL', 'KV_URL', 'REDIS_TLS_URL')
LOCAL = ('http://127.0.0.1', 'redis://127.0.0.1')  # unencrypted only for local tests


class StorageError(Exception):
    pass


def named(env, base):
    """Variables called `base` or `<PREFIX>_base`, the exact name first."""
    return sorted((n for n in env if n == base or n.endswith('_' + base)), key=lambda n: (n != base, n))


def storage_conf(env=None):
    """-> ('rest', url, token) | ('tcp', parsed redis url) | None."""
    env = os.environ if env is None else env
    for url_name, token_name in REST_VARS:
        for name in named(env, url_name):
            url, token = env.get(name), env.get(name[:len(name) - len(url_name)] + token_name)
            if url and token and url.startswith(('https://',) + LOCAL):
                return ('rest', url.rstrip('/'), token)
    for base in URL_VARS:
        for name in named(env, base):
            u = urllib.parse.urlsplit(env.get(name) or '')
            if u.scheme in ('redis', 'rediss') and u.hostname:
                return ('tcp', {
                    'host': u.hostname, 'port': u.port or 6379, 'tls': u.scheme == 'rediss',
                    'user': urllib.parse.unquote(u.username or ''), 'password': urllib.parse.unquote(u.password or ''),
                    'db': int(u.path.strip('/') or 0) if u.path.strip('/').isdigit() else 0,
                })
    return None


def storage_var_names():
    """Names (never values) of storage-looking variables: helps to see what Vercel passed in."""
    return sorted(n for n in os.environ if any(k in n.upper() for k in ('KV_', 'REDIS', 'UPSTASH')))


def resp_encode(cmd):
    parts = [f'*{len(cmd)}\r\n'.encode()]
    for arg in cmd:
        b = str(arg).encode()
        parts += [f'${len(b)}\r\n'.encode(), b, b'\r\n']
    return b''.join(parts)


def resp_read(f):
    line = f.readline()
    if not line.endswith(b'\r\n'):
        raise StorageError('connection closed')
    kind, rest = line[:1], line[1:-2]
    if kind == b'+':
        return rest.decode()
    if kind == b'-':
        return StorageError(rest.decode(errors='replace'))
    if kind == b':':
        return int(rest)
    if kind == b'$':
        n = int(rest)
        return None if n < 0 else f.read(n + 2)[:-2].decode('utf-8', 'replace')
    if kind == b'*':
        n = int(rest)
        return None if n < 0 else [resp_read(f) for _ in range(n)]
    raise StorageError('unexpected reply')


def tcp_pipeline(c, cmds, timeout):
    pre = []
    if c['password']:
        pre.append(['AUTH', c['user'], c['password']] if c['user'] else ['AUTH', c['password']])
    if c['db']:
        pre.append(['SELECT', c['db']])
    sock = socket.create_connection((c['host'], c['port']), timeout=timeout)
    try:
        if c['tls']:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=c['host'])
        sock.sendall(b''.join(resp_encode(cmd) for cmd in pre + cmds))
        f = sock.makefile('rb')
        replies = [resp_read(f) for _ in pre + cmds]
    finally:
        sock.close()
    for r in replies:
        if isinstance(r, StorageError):
            raise r
    return replies[len(pre):]


def rest_pipeline(url, token, cmds, timeout):
    req = urllib.request.Request(
        url + '/pipeline', data=json.dumps(cmds).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'check-fomo'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    results = []
    for item in out:
        if isinstance(item, dict) and item.get('error'):
            raise StorageError(item['error'])
        results.append(item.get('result') if isinstance(item, dict) else None)
    return results


def pipeline(cmds, conf=None, timeout=5):
    """Runs Redis commands in one round trip; replies in RESP2 shapes (lists of strings, ints)."""
    conf = conf or storage_conf()
    if not conf:
        raise StorageError('storage is not connected')
    if conf[0] == 'rest':
        return rest_pipeline(conf[1], conf[2], cmds, timeout)
    return tcp_pipeline(conf[1], cmds, timeout)


# ---------- events ----------


def valid_account(acc):
    if not isinstance(acc, str):
        return None
    acc = acc.strip().lower()
    return acc if 2 <= len(acc) <= 64 and ACCOUNT.match(acc) else None


def parse(body):
    """-> (kind, account, wallet, by) or None for anything malformed."""
    try:
        data = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    kind, acc, wallet = data.get('kind'), valid_account(data.get('account')), data.get('wallet')
    if kind not in KINDS or not acc:
        return None
    wallet = WALLET_JUNK.sub('', wallet)[:40].strip() if isinstance(wallet, str) else ''
    by = (valid_account(data.get('by')) or '-') if kind == 'search' else ''
    return kind, acc, wallet, by


def record(kind, acc, wallet, by, ip, now_ms):
    """Writes one event; returns the HTTP status."""
    minute = int(now_ms // 60000)
    bucket = 'cf:rl:' + hashlib.sha256(f'{ip}|{minute}'.encode()).hexdigest()[:20]
    hits, _, size = pipeline([['INCR', bucket], ['EXPIRE', bucket, 120], ['ZCARD', 'cf:last']])
    if int(hits or 0) > RATE_PER_MIN:
        return 429
    member = f'search|{by}|{acc}' if kind == 'search' else f'{kind}|{acc}'
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

    def reply(self, status, origin=None, body=b''):
        self.send_response(status)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Max-Age', '86400')
        self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if body:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.allowed_origin()
        self.reply(204 if origin else 403, origin)

    def do_GET(self):
        ok = storage_conf() is not None
        info = {'ok': True, 'storage': ok}
        if not ok:
            info['variables'] = storage_var_names()
        self.reply(200, None, json.dumps(info).encode())

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
        if storage_conf() is None:
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
