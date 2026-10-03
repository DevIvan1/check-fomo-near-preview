#!/usr/bin/env python3
"""Writes КОШЕЛЬКИ.txt in the project folder: wallets that connected to Check fomo or were searched on it.

Reads the usage log that api/track.py keeps in Upstash Redis. Windows Task Scheduler runs this every
10 minutes (task "Check fomo - wallets"); it can also be run by hand:  python tools/sync_wallets.py

Credentials go into tools/.wallets.env (never committed, never deployed):
    KV_REST_API_URL=https://<your-db>.upstash.io
    KV_REST_API_READ_ONLY_TOKEN=<read-only token>
(the same names as in Vercel -> Storage -> your Upstash database -> .env.local; a read-only token is enough)
"""

import datetime
import json
import os
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'КОШЕЛЬКИ.txt'
ENV_FILE = ROOT / 'tools' / '.wallets.env'
CACHE = ROOT / 'tools' / '.wallets-cache.json'  # last good data, shown if an update fails

KIND_GROUPS = [
    ('ПОДКЛЮЧИЛИ КОШЕЛЁК', ('connect', 'visit')),
    ('ВОШЛИ БЕЗ КОШЕЛЬКА (вписали свой адрес на странице входа)', ('manual',)),
    ('ИСКАЛИ НА САЙТЕ (вписали адрес в поиск)', ('search',)),
]


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


def clean(s, n):
    return ''.join(ch for ch in str(s) if ch.isprintable())[:n]


def when(ms):
    return datetime.datetime.fromtimestamp(int(float(ms)) / 1000).strftime('%d.%m.%Y %H:%M')


def build(data):
    """-> list of (title, rows); a row: (last_ms, first_ms, count, wallet, account)."""
    by_kind = {}
    for member, last in data['last'].items():
        kind, _, acc = member.partition('|')
        first = data['first'].get(member, last)
        n = int(data['count'].get(member, 1) or 1)
        by_kind.setdefault(kind, {}).setdefault(acc, []).append((float(last), float(first), n))
    groups = []
    for title, kinds in KIND_GROUPS:
        merged = {}
        for kind in kinds:
            for acc, items in by_kind.get(kind, {}).items():
                cur = merged.get(acc, [0.0, float('inf'), 0])
                for last, first, n in items:
                    cur = [max(cur[0], last), min(cur[1], first), cur[2] + n]
                merged[acc] = cur
        rows = [(v[0], v[1], v[2], data['wallet'].get(acc, '') if 'connect' in kinds else '', acc) for acc, v in merged.items()]
        rows.sort(key=lambda r: -r[0])
        groups.append((title, rows))
    return groups


def render(groups, updated, note=None):
    lines = ['Check fomo — кто пользуется сайтом', f'Обновлено: {updated} (автоматически каждые 10 минут)']
    if note:
        lines.append(note)
    lines.append(' · '.join(f'{title.split(" (")[0].capitalize()}: {len(rows)}' for title, rows in groups))
    for title, rows in groups:
        lines += ['', f'{title} — {len(rows)}', '']
        if not rows:
            lines.append('   пока никого')
            continue
        lines.append(f'{"#":>4}  {"последний раз":<16}  {"первый раз":<16}  {"раз":>4}  {"кошелёк-приложение":<18}  аккаунт')
        for i, (last, first, n, wallet, acc) in enumerate(rows, 1):
            lines.append(f'{i:>4}  {when(last):<16}  {when(first):<16}  {n:>4}  {clean(wallet, 18) or "—":<18}  {clean(acc, 64)}')
    lines += ['', '«Вошли без кошелька» и «искали» — просто введённые адреса: это не доказывает, что адрес принадлежит человеку.',
              'Повторное событие с того же браузера учитывается не чаще раза в 6 часов.']
    return '\n'.join(lines) + '\n'


def write(text):
    tmp = OUT.with_name(OUT.name + '.tmp')
    tmp.write_text(text, encoding='utf-8-sig')
    os.replace(tmp, OUT)


def main():
    now = datetime.datetime.now().strftime('%d.%m.%Y %H:%M')
    url, token = read_env()
    if not url:
        write('Check fomo — кто пользуется сайтом\n'
              f'Проверено: {now}\n\n'
              'Учёт ещё не подключён: нет доступа к базе.\n'
              '1) Vercel -> проект -> Storage -> Create Database -> Upstash for Redis -> подключить к проекту.\n'
              f'2) Создать файл {ENV_FILE} с двумя строками из вкладки .env.local базы:\n'
              '   KV_REST_API_URL=...\n   KV_REST_API_READ_ONLY_TOKEN=...\n')
        print('not configured')
        return 1
    try:
        data = fetch(url, token)
        CACHE.write_text(json.dumps({'at': now, 'data': data}), encoding='utf-8')
        write(render(build(data), now))
        print('ok', len(data['last']))
        return 0
    except Exception as e:  # keep showing the last good list
        cached = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else None
        note = f'Не удалось обновить в {now}: {clean(e, 120)}'
        if cached:
            write(render(build(cached['data']), cached['at'], note))
        else:
            write(f'Check fomo — кто пользуется сайтом\n{note}\n')
        print('error', e)
        return 2


if __name__ == '__main__':
    sys.exit(main())
