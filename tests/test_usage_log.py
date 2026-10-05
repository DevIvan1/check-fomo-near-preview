"""Usage log end to end, offline: api/track.py against a fake Redis (Upstash REST and plain Redis over
TCP), then tools/sync_wallets.py (the Excel table).

Run:  python tests/test_usage_log.py
"""

import http.client
import http.server
import importlib.util
import json
import os
import pathlib
import socketserver
import sys
import tempfile
import threading
import unittest
import zipfile
from xml.etree import ElementTree

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


RESP_PASSWORD = 'resp-pass'


class FakeResp(socketserver.StreamRequestHandler):
    """The same fake database, spoken over the Redis protocol (what REDIS_URL points to)."""
    db = FakeRedis.db

    def handle(self):
        authed = False
        while True:
            line = self.rfile.readline()
            if not line:
                return
            args = []
            for _ in range(int(line[1:-2])):
                n = int(self.rfile.readline()[1:-2])
                args.append(self.rfile.read(n + 2)[:-2].decode())
            if args[0] == 'AUTH':
                authed = args[-1] == RESP_PASSWORD and (len(args) == 2 or args[1] == 'default')
                self.wfile.write(b'+OK\r\n' if authed else b'-WRONGPASS invalid username-password pair\r\n')
            elif not authed:
                self.wfile.write(b'-NOAUTH Authentication required.\r\n')
            else:
                self.wfile.write(self.encode(FakeRedis.run(self, args)))

    def encode(self, v):
        if v is None:
            return b'$-1\r\n'
        if isinstance(v, int):
            return b':%d\r\n' % v
        if isinstance(v, list):
            return b'*%d\r\n' % len(v) + b''.join(self.encode(x) for x in v)
        b = str(v).encode()
        return b'$%d\r\n' % len(b) + b + b'\r\n'


NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read_xlsx(path):
    """{sheet name: rows}; a cell is its text, its number, or '=FORMULA -> cached value'."""
    with zipfile.ZipFile(path) as z:
        wb = ElementTree.fromstring(z.read('xl/workbook.xml'))
        names = [sh.get('name') for sh in wb.find('m:sheets', NS)]
        out = {}
        for i, name in enumerate(names, 1):
            root = ElementTree.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))
            rows = []
            for row in root.iter('{%s}row' % NS['m']):
                cells = []
                for c in row:
                    t, v, f = c.find('m:is/m:t', NS), c.find('m:v', NS), c.find('m:f', NS)
                    if t is not None:
                        cells.append(t.text)
                    elif f is not None:
                        cells.append('=' + f.text + ' -> ' + (v.text if v is not None else ''))
                    else:
                        cells.append(v.text if v is not None else None)
                rows.append(cells)
            out[name] = rows
        return out


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

    def test_search_remembers_who_searched(self):
        self.post({'kind': 'search', 'account': 'whale.near', 'by': 'Alice.near'})
        self.post({'kind': 'search', 'account': 'whale.near'})
        self.post({'kind': 'search', 'account': 'whale.near', 'by': '<bad>'})
        self.post({'kind': 'connect', 'account': 'bob.near', 'by': 'alice.near'})
        db = FakeRedis.db
        self.assertEqual(db['cf:count']['search|alice.near|whale.near'], 1)
        self.assertEqual(db['cf:count']['search|-|whale.near'], 2, 'no or invalid searcher = anonymous')
        self.assertIn('connect|bob.near', db['cf:last'], '"by" only matters for searches')

    def test_records_connect_search_and_counts(self):
        st, h = self.post({'kind': 'connect', 'account': 'Alice.near', 'wallet': 'HOT Wallet<script>'})
        self.assertEqual(st, 204)
        self.assertEqual(h['Access-Control-Allow-Origin'], 'https://devivan1.github.io')
        self.post({'kind': 'search', 'account': 'bob.near'})
        self.post({'kind': 'search', 'account': 'bob.near'})
        db = FakeRedis.db
        self.assertIn('connect|alice.near', db['cf:last'], 'account is lower-cased')
        self.assertEqual(db['cf:count']['search|-|bob.near'], 2)
        self.assertEqual(db['cf:wallet']['alice.near'], 'HOT Walletscript', 'markup characters are stripped')
        self.assertEqual(db['cf:first']['search|-|bob.near'] <= db['cf:last']['search|-|bob.near'], True)
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
        conn = http.client.HTTPConnection('127.0.0.1', self.api.server_port, timeout=10)
        conn.request('GET', '/api/track')
        r = conn.getresponse()
        self.assertEqual((r.status, json.loads(r.read())), (200, {'ok': True, 'storage': True}), 'only "is storage connected"')

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
            self.assertEqual(sorted(FakeRedis.db['cf:last']), ['search|-|a1.near', 'search|-|a2.near'])
            self.post({'kind': 'search', 'account': 'a1.near'})
            self.assertEqual(FakeRedis.db['cf:count']['search|-|a1.near'], 2, 'known entries still update')
        finally:
            self.track.MAX_ENTRIES = old

    def test_sync_writes_excel_table(self):
        self.post({'kind': 'connect', 'account': 'alice.near', 'wallet': 'HOT Wallet'})
        self.post({'kind': 'visit', 'account': 'alice.near'})
        self.post({'kind': 'search', 'account': 'whale.near', 'by': 'alice.near'})
        self.post({'kind': 'search', 'account': 'shark.near', 'by': 'alice.near'})
        self.post({'kind': 'manual', 'account': 'watcher.near'})
        self.post({'kind': 'search', 'account': 'whale.near'})
        FakeRedis.db['cf:last']['search|old.near'] = 1.0  # an entry from before searches had an author
        FakeRedis.db['cf:first']['search|old.near'] = 1.0
        sync = load('sync_wallets', ROOT / 'tools' / 'sync_wallets.py')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sync.OUT, sync.CACHE, sync.ENV_FILE = tmp / 'КОШЕЛЬКИ.xlsx', tmp / 'cache.json', tmp / '.wallets.env'
            sync.ENV_FILE.write_text(f'KV_REST_API_URL={os.environ["KV_REST_API_URL"]}\nKV_REST_API_READ_ONLY_TOKEN={READ_TOKEN}\n', encoding='utf-8')
            saved = os.environ.pop('KV_REST_API_TOKEN')
            try:
                self.assertEqual(sync.main(), 0)
            finally:
                os.environ['KV_REST_API_TOKEN'] = saved
            book = read_xlsx(sync.OUT)
            self.assertEqual(list(book), ['Пользователи', 'Поиски', 'Сводка'])
            users = book['Пользователи']
            self.assertEqual(users[0][:3], ['№', 'Кошелёк', 'Как вошёл'])
            by_acc = {r[1]: r for r in users[1:]}
            self.assertEqual(set(by_acc), {'alice.near', 'watcher.near'})
            alice = by_acc['alice.near']
            self.assertEqual(alice[2], 'HOT Wallet')
            self.assertEqual(alice[5], '2', 'connect + visit')
            self.assertRegex(alice[6], r"^=COUNTIF\('Поиски'!B:B,B\d+\) -> 2$")
            self.assertRegex(alice[7], r"^=SUMIF\('Поиски'!B:B,B\d+,'Поиски'!D:D\) -> 2$")
            self.assertEqual(set(alice[8].split(', ')), {'whale.near', 'shark.near'})
            self.assertEqual(by_acc['watcher.near'][2], 'без кошелька (вписал адрес)')
            pairs = {(r[1], r[2]) for r in book['Поиски'][1:]}
            self.assertEqual(pairs, {('alice.near', 'whale.near'), ('alice.near', 'shark.near'),
                                     ('(без входа)', 'whale.near'), ('(без входа)', 'old.near')})
            summary = {r[0]: r[1] for r in book['Сводка'] if r and len(r) > 1}
            self.assertEqual(summary['Пользователей (вошли кошельком или вписали адрес)'], "=COUNTA('Пользователи'!B:B)-1 -> 2")
            self.assertTrue(summary['Из них подключили кошелёк'].endswith('-> 1'))
            self.assertTrue(summary['Поисков всего'].endswith('-> 4'))
            # storage down: the last good table stays, with a note
            sync.connection = lambda: ('rest', 'http://127.0.0.1:9', READ_TOKEN)
            sync.RETRY_PAUSE = 0  # retries are tried, without waiting
            self.assertEqual(sync.main(), 2)
            book = read_xlsx(sync.OUT)
            self.assertIn('alice.near', [r[1] for r in book['Пользователи'][1:]])
            self.assertTrue(any(r and r[0] == 'Внимание' and 'Не удалось обновить' in r[1] for r in book['Сводка']))

    def test_sync_without_credentials_explains_setup(self):
        sync = load('sync_wallets2', ROOT / 'tools' / 'sync_wallets.py')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sync.OUT, sync.CACHE, sync.ENV_FILE = tmp / 'out.xlsx', tmp / 'c.json', tmp / 'missing.env'
            saved = {k: os.environ.pop(k) for k in ('KV_REST_API_URL', 'KV_REST_API_TOKEN')}
            try:
                self.assertEqual(sync.main(), 1)
            finally:
                os.environ.update(saved)
            notes = [r[1] for r in read_xlsx(sync.OUT)['Сводка'] if r and len(r) > 1 and r[0] in ('Внимание', 'Настройка')]
            self.assertIn('Учёт ещё не подключён: нет доступа к базе.', notes)

    def test_plain_redis_url_end_to_end(self):
        resp = socketserver.ThreadingTCPServer(('127.0.0.1', 0), FakeResp)
        threading.Thread(target=resp.serve_forever, daemon=True).start()
        saved = {k: os.environ.pop(k) for k in ('KV_REST_API_URL', 'KV_REST_API_TOKEN')}
        url = f'redis://default:{RESP_PASSWORD}@127.0.0.1:{resp.server_address[1]}'
        try:
            os.environ['STORAGE_REDIS_URL'] = url  # Vercel may add a prefix
            self.assertEqual(self.track.storage_conf()[0], 'tcp')
            self.assertEqual(self.post({'kind': 'connect', 'account': 'carol.near', 'wallet': 'Meteor Wallet'})[0], 204)
            self.assertEqual(self.post({'kind': 'search', 'account': 'whale.near', 'by': 'carol.near'})[0], 204)
            self.assertEqual(FakeRedis.db['cf:count']['search|carol.near|whale.near'], 1)
            os.environ['STORAGE_REDIS_URL'] = url.replace(RESP_PASSWORD, 'wrong')
            self.assertEqual(self.post({'kind': 'search', 'account': 'x.near'})[0], 502, 'a wrong password is an error, not a crash')
            del os.environ['STORAGE_REDIS_URL']
            sync = load('sync_wallets4', ROOT / 'tools' / 'sync_wallets.py')
            with tempfile.TemporaryDirectory() as tmp:
                tmp = pathlib.Path(tmp)
                sync.OUT, sync.CACHE, sync.ENV_FILE = tmp / 'w.xlsx', tmp / 'c.json', tmp / '.wallets.env'
                sync.ENV_FILE.write_text('# Redis\nREDIS_URL=' + url + '\nKV_REST_API_URL=\n', encoding='utf-8')
                self.assertEqual(sync.main(), 0)
                book = read_xlsx(sync.OUT)
                carol = [r for r in book['Пользователи'][1:] if r[1] == 'carol.near'][0]
                self.assertEqual(carol[2], 'Meteor Wallet')
                self.assertEqual(carol[8], 'whale.near')
        finally:
            os.environ.pop('STORAGE_REDIS_URL', None)
            os.environ.update(saved)
            resp.shutdown()
            resp.server_close()

    def test_xlsx_text_is_escaped(self):
        sync = load('sync_wallets3', ROOT / 'tools' / 'sync_wallets.py')
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'x.xlsx'
            sync.write_xlsx(path, [{'name': 'T', 'columns': [('a', 10, 'text')], 'rows': [['<b>&"x"\x01']]}])
            self.assertEqual(read_xlsx(path)['T'][1][0], '<b>&"x"', 'markup is text, control characters dropped')

if __name__ == '__main__':
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
