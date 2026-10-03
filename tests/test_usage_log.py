"""Usage log end to end, offline: api/track.py against a fake Upstash Redis, then tools/sync_wallets.py.

Run:  python tests/test_usage_log.py
"""

import http.client
import http.server
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WRITE_TOKEN, READ_TOKEN = 'write-token', 'read-token'
WRITES = {'INCR', 'EXPIRE', 'ZADD', 'HINCRBY', 'HSET'}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeRedis(http.server.BaseHTTPRequestHandler):
    """Just enough of the Upstash REST /pipeline API."""
    db = {}

    def do_POST(self):
        token = (self.headers.get('Authorization') or '').removeprefix('Bearer ')
        if token not in (WRITE_TOKEN, READ_TOKEN) or self.path != '/pipeline':
            self.send_response(401)
            self.end_headers()
            return
        cmds = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        out = []
        for c in cmds:
            if token == READ_TOKEN and c[0] in WRITES:
                out.append({'error': 'NOPERM this user has no permissions to run the command'})
            else:
                out.append({'result': self.run(c)})
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def run(self, c):
        db, op, key = self.db, c[0], c[1]
        if op == 'INCR':
            db[key] = db.get(key, 0) + 1
            return db[key]
        if op == 'EXPIRE':
            return 1
        if op == 'ZCARD':
            return len(db.get(key, {}))
        if op == 'ZSCORE':
            v = db.get(key, {}).get(c[2])
            return None if v is None else str(v)
        if op == 'ZADD':
            z = db.setdefault(key, {})
            nx = c[2] == 'NX'
            score, member = (c[3], c[4]) if nx else (c[2], c[3])
            if nx and member in z:
                return 0
            z[member] = float(score)
            return 1
        if op == 'HINCRBY':
            h = db.setdefault(key, {})
            h[c[2]] = int(h.get(c[2], 0)) + int(c[3])
            return h[c[2]]
        if op == 'HSET':
            db.setdefault(key, {})[c[2]] = c[3]
            return 1
        if op in ('ZREVRANGE', 'ZRANGE'):
            items = sorted(db.get(key, {}).items(), key=lambda kv: kv[1], reverse=op == 'ZREVRANGE')
            return [x for m, s in items for x in (m, str(s))]
        if op == 'HGETALL':
            return [x for k, v in db.get(key, {}).items() for x in (k, str(v))]
        raise ValueError(op)

    def log_message(self, *a):
        pass


def serve(handler_cls):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class UsageLogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.redis = serve(FakeRedis)
        os.environ['KV_REST_API_URL'] = f'http://127.0.0.1:{cls.redis.server_port}'
        os.environ['KV_REST_API_TOKEN'] = WRITE_TOKEN
        cls.track = load('track', ROOT / 'api' / 'track.py')
        cls.api = serve(cls.track.handler)

    @classmethod
    def tearDownClass(cls):
        cls.api.shutdown()
        cls.redis.shutdown()

    def setUp(self):
        FakeRedis.db.clear()

    def post(self, body, origin='https://devivan1.github.io', ip='1.2.3.4', method='POST', host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.api.server_port, timeout=10)
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers = {'Content-Type': 'text/plain;charset=UTF-8', 'X-Forwarded-For': ip}
        if origin:
            headers['Origin'] = origin
        if host:
            headers['X-Forwarded-Host'] = host
        conn.request(method, '/api/track', body=data if method == 'POST' else None, headers=headers)
        r = conn.getresponse()
        r.read()
        return r.status, dict(r.getheaders())

    def test_records_connect_search_and_counts(self):
        st, h = self.post({'kind': 'connect', 'account': 'Alice.near', 'wallet': 'HOT Wallet<script>'})
        self.assertEqual(st, 204)
        self.assertEqual(h['Access-Control-Allow-Origin'], 'https://devivan1.github.io')
        self.post({'kind': 'search', 'account': 'bob.near'})
        self.post({'kind': 'search', 'account': 'bob.near'})
        db = FakeRedis.db
        self.assertIn('connect|alice.near', db['cf:last'], 'account is lower-cased')
        self.assertEqual(db['cf:count']['search|bob.near'], 2)
        self.assertEqual(db['cf:wallet']['alice.near'], 'HOT Walletscript', 'markup characters are stripped')
        self.assertEqual(db['cf:first']['search|bob.near'] <= db['cf:last']['search|bob.near'], True)
        self.assertFalse(any('1.2.3.4' in str(k) for k in db), 'the IP is never stored as is')

    def test_rejects_bad_input(self):
        for body in [{'kind': 'hack', 'account': 'a.near'}, {'kind': 'search', 'account': '<img src=x>'},
                     {'kind': 'search', 'account': 'a' * 65}, {'kind': 'search'}, b'not json', b'[1,2]']:
            self.assertEqual(self.post(body)[0], 400, body)
        self.assertEqual(self.post(b'x' * 2000)[0], 413)
        self.assertEqual(FakeRedis.db.get('cf:last'), None)

    def test_origin_check(self):
        self.assertEqual(self.post({'kind': 'search', 'account': 'a.near'}, origin='https://evil.example')[0], 403)
        self.assertEqual(self.post({'kind': 'search', 'account': 'a.near'}, origin=None)[0], 403)
        st, _ = self.post({'kind': 'search', 'account': 'a.near'}, origin='https://check-fomo-near.vercel.app', host='check-fomo-near.vercel.app')
        self.assertEqual(st, 204, 'the site itself')
        self.assertEqual(self.post(b'', method='GET')[0], 405, 'nothing can be read over HTTP')

    def test_rate_limit(self):
        codes = [self.post({'kind': 'search', 'account': f'u{i}.near'}, ip='9.9.9.9')[0] for i in range(25)]
        self.assertEqual(codes.count(204), self.track.RATE_PER_MIN)
        self.assertEqual(codes[-1], 429)
        self.assertEqual(self.post({'kind': 'search', 'account': 'other.near'}, ip='8.8.8.8')[0], 204, 'other IPs are fine')

    def test_cap(self):
        old = self.track.MAX_ENTRIES
        self.track.MAX_ENTRIES = 2
        try:
            for acc in ('a1.near', 'a2.near', 'a3.near'):
                self.post({'kind': 'search', 'account': acc})
            self.assertEqual(sorted(FakeRedis.db['cf:last']), ['search|a1.near', 'search|a2.near'])
            self.post({'kind': 'search', 'account': 'a1.near'})
            self.assertEqual(FakeRedis.db['cf:count']['search|a1.near'], 2, 'known entries still update')
        finally:
            self.track.MAX_ENTRIES = old

    def test_sync_writes_text_file(self):
        self.post({'kind': 'connect', 'account': 'alice.near', 'wallet': 'HOT Wallet'})
        self.post({'kind': 'visit', 'account': 'alice.near'})
        self.post({'kind': 'manual', 'account': 'watcher.near'})
        self.post({'kind': 'search', 'account': 'whale.near'})
        sync = load('sync_wallets', ROOT / 'tools' / 'sync_wallets.py')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sync.OUT, sync.CACHE, sync.ENV_FILE = tmp / 'КОШЕЛЬКИ.txt', tmp / 'cache.json', tmp / '.wallets.env'
            sync.ENV_FILE.write_text(f'KV_REST_API_URL={os.environ["KV_REST_API_URL"]}\nKV_REST_API_READ_ONLY_TOKEN={READ_TOKEN}\n', encoding='utf-8')
            saved = os.environ.pop('KV_REST_API_TOKEN')
            try:
                self.assertEqual(sync.main(), 0)
            finally:
                os.environ['KV_REST_API_TOKEN'] = saved
            text = sync.OUT.read_text(encoding='utf-8-sig')
            self.assertIn('ПОДКЛЮЧИЛИ КОШЕЛЁК — 1', text)
            self.assertRegex(text, r'2\s+HOT Wallet\s+alice\.near', 'connect + visit merged: 2 times')
            self.assertIn('ВОШЛИ БЕЗ КОШЕЛЬКА (вписали свой адрес на странице входа) — 1', text)
            self.assertIn('watcher.near', text)
            self.assertIn('ИСКАЛИ НА САЙТЕ (вписали адрес в поиск) — 1', text)
            self.assertIn('whale.near', text)
            # storage down: the last good list stays, with a note
            sync.read_env = lambda: ('http://127.0.0.1:9', READ_TOKEN)
            self.assertEqual(sync.main(), 2)
            text = sync.OUT.read_text(encoding='utf-8-sig')
            self.assertIn('Не удалось обновить', text)
            self.assertIn('alice.near', text)

    def test_sync_without_credentials_explains_setup(self):
        sync = load('sync_wallets2', ROOT / 'tools' / 'sync_wallets.py')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sync.OUT, sync.CACHE, sync.ENV_FILE = tmp / 'out.txt', tmp / 'c.json', tmp / 'missing.env'
            saved = {k: os.environ.pop(k) for k in ('KV_REST_API_URL', 'KV_REST_API_TOKEN')}
            try:
                self.assertEqual(sync.main(), 1)
            finally:
                os.environ.update(saved)
            self.assertIn('Учёт ещё не подключён', sync.OUT.read_text(encoding='utf-8-sig'))


if __name__ == '__main__':
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
