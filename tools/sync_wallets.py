#!/usr/bin/env python3
"""Writes КОШЕЛЬКИ.xlsx in the project folder: who uses Check fomo and which wallets they searched.

Sheets: «Пользователи» (wallets that signed in: connected a wallet or typed their address),
«Поиски» (who searched which wallet) and «Сводка» (totals and how to read the table).
Reads the usage log that api/track.py keeps in Upstash Redis. Windows Task Scheduler runs this every
10 minutes (task "Check fomo - wallets"); it can also be run by hand:  python tools/sync_wallets.py

Credentials go into tools/.wallets.env (never committed, never deployed):
    KV_REST_API_URL=https://<your-db>.upstash.io
    KV_REST_API_READ_ONLY_TOKEN=<read-only token>
(the same names as in Vercel -> Storage -> your Upstash database -> .env.local; read-only is enough)
"""

import datetime
import json
import os
import pathlib
import sys
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from xlsx_lite import write_xlsx  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'КОШЕЛЬКИ.xlsx'
ENV_FILE = ROOT / 'tools' / '.wallets.env'
CACHE = ROOT / 'tools' / '.wallets-cache.json'  # last good data, shown if an update fails

ANON = '(без входа)'
MANUAL = 'без кошелька (вписал адрес)'
LIST_MAX = 40  # searched wallets listed per user on the first sheet


def read_env():
    env = dict(os.environ)
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    url = env.get('KV_REST_API_URL') or env.get('UPSTASH_REDIS_REST_URL')
    token = (env.get('KV_REST_API_READ_ONLY_TOKEN') or env.get('KV_REST_API_TOKEN')
             or env.get('UPSTASH_REDIS_REST_TOKEN'))
    return (url.rstrip('/'), token) if url and token else (None, None)


def fetch(url, token):
    cmds = [['ZREVRANGE', 'cf:last', 0, -1, 'WITHSCORES'], ['ZRANGE', 'cf:first', 0, -1, 'WITHSCORES'],
            ['HGETALL', 'cf:count'], ['HGETALL', 'cf:wallet']]
    req = urllib.request.Request(url + '/pipeline', data=json.dumps(cmds).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                                          'User-Agent': 'check-fomo-sync'})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read())
    for item in out:
        if isinstance(item, dict) and item.get('error'):
            raise RuntimeError(item['error'])
    pairs = lambda flat: dict(zip(flat[0::2], flat[1::2])) if isinstance(flat, list) else {}
    last, first, count, wallet = (pairs(x.get('result')) for x in out)
    return {'last': last, 'first': first, 'count': count, 'wallet': wallet}


def clean(s, n=200):
    return ''.join(ch for ch in str(s) if ch.isprintable())[:n]


def dt(ms):
    return datetime.datetime.fromtimestamp(float(ms) / 1000).replace(microsecond=0)


def parse_member(member):
    """'connect|acc' -> ('connect', None, acc); 'search|who|acc' -> ('search', who, acc)."""
    parts = str(member).split('|')
    if parts[0] == 'search' and len(parts) in (2, 3):
        return ('search', parts[1] if len(parts) == 3 else '-', parts[-1])
    if parts[0] in ('connect', 'manual', 'visit') and len(parts) == 2:
        return (parts[0], None, parts[1])
    return None


def build(data):
    """-> (users, searches): users sorted by last activity, searches sorted by last time."""
    users, searches = {}, {}

    def user(acc):
        return users.setdefault(acc, {'account': acc, 'first': None, 'last': None, 'visits': 0, 'methods': []})

    def stretch(u, first, last):
        u['first'] = first if u['first'] is None else min(u['first'], first)
        u['last'] = last if u['last'] is None else max(u['last'], last)

    for member, last in data['last'].items():
        p = parse_member(member)
        if not p:
            continue
        kind, who, acc = p
        last = float(last)
        first = float(data['first'].get(member, last))
        n = int(data['count'].get(member, 1) or 1)
        if kind == 'search':
            searches[(who, acc)] = {'who': who, 'target': acc, 'first': first, 'last': last, 'count': n}
            if who != '-':
                stretch(user(who), first, last)
            continue
        u = user(acc)
        stretch(u, first, last)
        u['visits'] += n
        method = (data['wallet'].get(acc) or 'кошелёк') if kind in ('connect', 'visit') else MANUAL
        if method not in u['methods'] and not (method == 'кошелёк' and len(u['methods'])):
            u['methods'].append(method)
    for u in users.values():
        if len(u['methods']) > 1 and 'кошелёк' in u['methods']:
            u['methods'].remove('кошелёк')
    search_list = sorted(searches.values(), key=lambda s: -s['last'])
    for u in users.values():
        mine = [s for s in search_list if s['who'] == u['account']]
        u['searched'] = [s['target'] for s in mine]
        u['search_total'] = sum(s['count'] for s in mine)
        if not u['methods']:
            u['methods'] = ['кошелёк']
    user_list = sorted(users.values(), key=lambda u: -(u['last'] or 0))
    return user_list, search_list


def workbook(users, searches, updated, note=None, setup=None):
    user_rows = []
    for i, u in enumerate(users, 1):
        r = i + 1
        shown = u['searched'][:LIST_MAX]
        more = len(u['searched']) - len(shown)
        user_rows.append([
            i, clean(u['account'], 64), clean('; '.join(u['methods']), 60), dt(u['first']), dt(u['last']), u['visits'],
            {'f': f"COUNTIF('Поиски'!B:B,B{r})", 'v': len(u['searched'])},
            {'f': f"SUMIF('Поиски'!B:B,B{r},'Поиски'!D:D)", 'v': u['search_total']},
            ', '.join(shown) + (f' … и ещё {more}' if more else ''),
        ])
    search_rows = [[i, ANON if s['who'] == '-' else clean(s['who'], 64), clean(s['target'], 64), s['count'], dt(s['first']), dt(s['last'])]
                   for i, s in enumerate(searches, 1)]
    connected = sum(1 for u in users if u['methods'] != [MANUAL])
    anon = sum(s['count'] for s in searches if s['who'] == '-')
    t = lambda v: {'kind': 'text', 'value': v}
    summary = [['Check fomo — кто пользуется сайтом', None], [None, None],
               ['Обновлено', {'kind': 'datetime', 'value': updated}],
               ['Обновляется', t('автоматически каждые 10 минут (Планировщик Windows, задача «Check fomo - wallets»)')]]
    if note:
        summary.append(['Внимание', t(note)])
    for line in setup or []:
        summary.append(['Настройка', t(line)])
    summary += [
        [None, None],
        ['Пользователей (вошли кошельком или вписали адрес)', {'kind': 'int', 'f': "COUNTA('Пользователи'!B:B)-1", 'v': len(users)}],
        ['Из них подключили кошелёк', {'kind': 'int', 'f': f"COUNTA('Пользователи'!C:C)-1-COUNTIF('Пользователи'!C:C,\"{MANUAL}\")", 'v': connected}],
        ['Пар «кто — кого искал»', {'kind': 'int', 'f': "COUNTA('Поиски'!C:C)-1", 'v': len(searches)}],
        ['Поисков всего', {'kind': 'int', 'f': "SUM('Поиски'!D:D)", 'v': sum(s['count'] for s in searches)}],
        ['Из них без входа', {'kind': 'int', 'f': f"SUMIF('Поиски'!B:B,\"{ANON}\",'Поиски'!D:D)", 'v': anon}],
        [None, None],
        ['Как читать', None],
        [t('«Как вошёл»: название кошелька — человек подтвердил вход в своём кошельке.'), None],
        [t(f'«{MANUAL}» — просто ввёл адрес на странице входа: владение адресом не подтверждено.'), None],
        [t(f'«Поиски» — адреса, вписанные в поиск на сайте; «{ANON}» — искал человек, который не вошёл.'), None],
        [t('Одно и то же событие из одного браузера учитывается не чаще раза в 6 часов: «сколько раз» — число таких 6-часовых окон.'), None],
        [t('Время — по часам этого компьютера.'), None],
        [t('Excel не обновляет открытый файл: закройте и откройте его снова. Пока файл открыт, обновление ждёт.'), None],
    ]
    return [
        {'name': 'Пользователи', 'columns': [
            ('№', 6, 'int'), ('Кошелёк', 34, 'text'), ('Как вошёл', 24, 'text'), ('Первый раз', 17, 'datetime'),
            ('Последний раз', 17, 'datetime'), ('Входов и визитов', 11, 'int'), ('Искал кошельков', 11, 'int'),
            ('Поисков всего', 10, 'int'), ('Какие кошельки искал (свежие первыми)', 80, 'wrap')], 'rows': user_rows},
        {'name': 'Поиски', 'columns': [
            ('№', 6, 'int'), ('Кто искал', 34, 'text'), ('Какой кошелёк искал', 34, 'text'), ('Сколько раз', 10, 'int'),
            ('Первый раз', 17, 'datetime'), ('Последний раз', 17, 'datetime')], 'rows': search_rows},
        {'name': 'Сводка', 'table': False, 'columns': [('', 52, 'label'), ('', 30, 'text')], 'rows': summary},
    ]


def save(sheets, active=0):
    tmp = OUT.with_name('~' + OUT.name)
    write_xlsx(tmp, sheets, active)
    try:
        os.replace(tmp, OUT)
    except PermissionError:  # the file is open in Excel: try again on the next run
        tmp.unlink(missing_ok=True)
        return False
    return True


def main():
    now = datetime.datetime.now().replace(microsecond=0)
    url, token = read_env()
    if not url:
        save(workbook([], [], now, note='Учёт ещё не подключён: нет доступа к базе.', setup=[
            'Vercel -> проект -> Storage -> Create Database -> Upstash for Redis -> подключить к проекту.',
            f'Создать файл {ENV_FILE} с двумя строками из вкладки .env.local базы:',
            'KV_REST_API_URL=...   и   KV_REST_API_READ_ONLY_TOKEN=...']), active=2)  # open on the instructions
        print('not configured')
        return 1
    try:
        data = fetch(url, token)
    except Exception as e:  # keep showing the last good table
        cached = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else None
        note = f'Не удалось обновить в {now:%d.%m.%Y %H:%M}: {clean(e, 120)}'
        if cached:
            save(workbook(*build(cached['data']), datetime.datetime.fromisoformat(cached['at']), note))
        else:
            save(workbook([], [], now, note))
        print('error', e)
        return 2
    CACHE.write_text(json.dumps({'at': now.isoformat(), 'data': data}), encoding='utf-8')
    if not save(workbook(*build(data), now)):
        print('locked: the file is open in Excel')
        return 3
    print('ok', len(data['last']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
