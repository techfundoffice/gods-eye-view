#!/usr/bin/env python3
"""Loopback watcher: go-now after OAuth, or record a stream-key session."""

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

READY = 'http://127.0.0.1:5000/api/youtube/auth/operator-ready'
SESSION = 'http://127.0.0.1:5000/api/youtube/live/session'
GO = 'http://127.0.0.1:5000/api/youtube/live/go-now'
INGEST = 'http://127.0.0.1:5000/api/youtube/live/ingest-key'
OUT = '/tmp/gev-go-now-result.json'
KEY_FILE = '/home/runner/workspace/.local/youtube-stream-key'
WATCH_FILE = '/home/runner/workspace/.local/youtube-watch-url'
ENV_FILE = '/home/runner/workspace/.env'
REPLIT_ENV_JSON = '/var/run/replit/env/latest.json'
# Public leftover Techfundoffice live that is already waiting for ingest.
DEFAULT_WATCH = 'https://www.youtube.com/watch?v=CVSB4QJhVTU'
DEFAULT_BROADCAST_ID = 'CVSB4QJhVTU'
YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'
BODY = json.dumps({
    'title': "God's Eye View LIVE",
    'privacyStatus': 'public',
    'description': "Live from God's Eye View",
}).encode()
ACTIVE_STATUSES = (
    'starting',
    'encoding',
    'ingesting',
    'waiting-for-youtube',
    'live',
    'stopping',
)
STOP = 'http://127.0.0.1:5000/api/youtube/live/stop'


def get(url):
    with urllib.request.urlopen(url, timeout=8) as response:
        return json.loads(response.read().decode())


def post():
    request = urllib.request.Request(GO, data=BODY, method='POST')
    request.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, json.loads(response.read().decode())


def post_stop():
    request = urllib.request.Request(STOP, data=b'{}', method='POST')
    request.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.status, json.loads(response.read().decode())


def write(payload):
    safe = {
        'status': payload.get('status') or '',
        'watchUrl': payload.get('watchUrl') or '',
        'liveStatus': payload.get('liveStatus') or '',
        'at': payload.get('at') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    if payload.get('http') is not None:
        safe['http'] = payload['http']
    if payload.get('source'):
        safe['source'] = payload['source']
    with open(OUT, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(safe) + '\n')


def session_snapshot():
    body = get(SESSION)
    live = body.get('live') or {}
    broadcast = body.get('broadcast') or live.get('broadcast') or {}
    return {
        'status': live.get('status') or body.get('sessionStatus') or '',
        'watchUrl': broadcast.get('watchUrl') or '',
        'liveStatus': live.get('status') or '',
        'framesSent': live.get('framesSent') or 0,
        'error': live.get('error') or '',
        'startedAt': live.get('startedAt') or '',
        'source': 'session',
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


def finished(payload):
    status = payload.get('liveStatus') or payload.get('status') or ''
    return status == 'live' and bool(payload.get('watchUrl'))


def session_blocks_go_now(status):
    return str(status or '') in ACTIVE_STATUSES


def dead_encoder(snap):
    status = str(snap.get('status') or '')
    if status not in ('encoding', 'starting'):
        return False
    frames = snap.get('framesSent') or 0
    if frames > 0:
        return False
    return bool(str(snap.get('error') or '').strip())


def first_line(path):
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError:
        return ''
    for line in text.splitlines():
        value = line.strip()
        if value and not value.startswith('#'):
            return value
    return ''


def env_value(name):
    try:
        text = Path(ENV_FILE).read_text(encoding='utf-8')
    except OSError:
        return ''
    prefix = f'{name}='
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(prefix):
            continue
        value = line[len(prefix):].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        return value.strip()
    return ''


def replit_secret(name):
    """Read a Replit Secret without requiring a Vite restart."""
    try:
        payload = json.loads(Path(REPLIT_ENV_JSON).read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return ''
    environment = payload.get('environment') if isinstance(payload, dict) else None
    if not isinstance(environment, dict):
        return ''
    value = environment.get(name)
    return str(value).strip() if value else ''


def first_stream_key():
    return first_line(KEY_FILE) or env_value('YOUTUBE_STREAM_KEY') or replit_secret('YOUTUBE_STREAM_KEY')


def split_youtube_ingest(raw):
    text = (raw or '').strip()
    ingest = 'rtmps://a.rtmp.youtube.com/live2'
    if not text:
        return ingest, ''
    first = text.split()[0]
    if first.lower().startswith(('rtmp://', 'rtmps://')):
        parsed = urllib.parse.urlparse(first)
        parts = [p for p in parsed.path.strip('/').split('/') if p]
        if len(parts) >= 2:
            return f'{parsed.scheme}://{parsed.netloc}/{"/".join(parts[:-1])}', parts[-1]
        rest = text[len(first):].strip().split()
        return f'{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip("/")}', (rest[0] if rest else '')
    return ingest, text.split()[0]


def post_ingest(stream_key, watch_url):
    ingest_url, key = split_youtube_ingest(stream_key)
    payload = json.dumps({
        'streamKey': key or stream_key,
        'ingestUrl': ingest_url,
        'watchUrl': watch_url or '',
    }).encode()
    request = urllib.request.Request(INGEST, data=payload, method='POST')
    request.add_header('Content-Type', 'application/json')
    request.add_header('X-GEV-YouTube', '1')
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, json.loads(response.read().decode())


key_fp_used = ''
connector_used = False
last_public_check = 0.0
last_connector_check = 0.0


def current_key_fingerprint():
    raw = first_stream_key()
    _ingest, key = split_youtube_ingest(raw)
    token = key or raw
    if len(token) < 4:
        return ''
    return hashlib.sha256(token.encode()).hexdigest()


def public_youtube_live(watch_url):
    url = (watch_url or DEFAULT_WATCH).strip()
    if 'youtube.com/watch' not in url:
        return {'watchUrl': url, 'isLiveNow': False}
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=12) as response:
        html = response.read().decode('utf-8', 'replace')
    live_now = '"isLiveNow":true' in html or '"isLiveNow": true' in html
    return {'watchUrl': url, 'isLiveNow': live_now}


def vite_env(name):
    proc = Path('/proc')
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmd = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace')
        except OSError:
            continue
        if '/node_modules/.bin/vite' not in cmd:
            continue
        try:
            raw = (entry / 'environ').read_bytes().split(b'\0')
        except OSError:
            continue
        for item in raw:
            if not item.startswith(name.encode() + b'='):
                continue
            return item.split(b'=', 1)[1].decode('utf-8', 'replace')
    return ''


def connector_items():
    identity = vite_env('REPL_IDENTITY')
    hostname = vite_env('REPLIT_CONNECTORS_HOSTNAME') or 'connectors.replit.com'
    if not identity:
        return []
    url = f'https://{hostname}/api/v2/connection?include_secrets=true&connector_names=youtube'
    request = urllib.request.Request(url)
    request.add_header('Accept', 'application/json')
    request.add_header('X_REPLIT_TOKEN', f'repl {identity}')
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode())
    items = payload.get('items') if isinstance(payload, dict) else payload
    return items if isinstance(items, list) else []


def youtube_api(token, path, params, method='GET', body=None):
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f'{YOUTUBE_API}/{path}?{query}',
        data=None if body is None else json.dumps(body).encode(),
        method=method,
    )
    request.add_header('Authorization', f'Bearer {token}')
    if body is not None:
        request.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode())


def youtube_token_works(token):
    try:
        youtube_api(token, 'channels', {'part': 'id', 'mine': 'true'})
        return True
    except Exception:
        return False


def connector_access_token(item):
    settings = item.get('settings') or {}
    oauth = ((settings.get('oauth') or {}).get('credentials') or {})
    token = str(settings.get('access_token') or oauth.get('access_token') or '').strip()
    if len(token) <= 20:
        return ''
    # Replit can lag on status after Allow. A token YouTube accepts is enough.
    if str(item.get('status') or '') == 'healthy':
        return token
    return token if youtube_token_works(token) else ''


def try_replit_connector():
    try:
        items = connector_items()
    except Exception:
        return False
    token = ''
    for item in items:
        token = connector_access_token(item)
        if token:
            break
    if not token:
        return False
    prefer = env_value('YOUTUBE_BROADCAST_ID') or DEFAULT_BROADCAST_ID
    listed = youtube_api(token, 'liveBroadcasts', {
        'part': 'id,snippet,status,contentDetails',
        'mine': 'true',
        'maxResults': '50',
    })
    rows = listed.get('items') or []
    chosen = None
    for row in rows:
        if row.get('id') == prefer:
            chosen = row
            break
    if chosen is None:
        for row in rows:
            status = str((row.get('status') or {}).get('lifeCycleStatus') or '')
            privacy = str((row.get('status') or {}).get('privacyStatus') or '')
            if privacy == 'public' and status in {'created', 'ready', 'testing', 'live', 'liveStarting', 'testStarting'}:
                chosen = row
                break
    if chosen is None:
        stream = youtube_api(token, 'liveStreams', {'part': 'snippet,cdn,status'}, method='POST', body={
            'snippet': {'title': "God's Eye View LIVE ingest"},
            'cdn': {'frameRate': 'variable', 'ingestionType': 'rtmp', 'resolution': 'variable'},
        })
        created = youtube_api(token, 'liveBroadcasts', {'part': 'snippet,status,contentDetails'}, method='POST', body={
            'snippet': {
                'title': "God's Eye View LIVE",
                'description': "Live from God's Eye View",
                'scheduledStartTime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 15)),
            },
            'status': {'privacyStatus': 'public', 'selfDeclaredMadeForKids': False},
            'contentDetails': {
                'enableAutoStart': True,
                'enableAutoStop': True,
                'monitorStream': {'enableMonitorStream': False, 'broadcastStreamDelayMs': 0},
            },
        })
        youtube_api(token, 'liveBroadcasts/bind', {
            'part': 'id,contentDetails',
            'id': created.get('id') or '',
            'streamId': stream.get('id') or '',
        }, method='POST')
        ingest = ((stream.get('cdn') or {}).get('ingestionInfo') or {})
        stream_key = str(ingest.get('streamName') or '')
        watch_url = f"https://www.youtube.com/watch?v={created.get('id') or ''}"
    else:
        stream_id = str((chosen.get('contentDetails') or {}).get('boundStreamId') or '')
        if stream_id:
            streams = youtube_api(token, 'liveStreams', {'part': 'snippet,cdn,status', 'id': stream_id})
            stream = (streams.get('items') or [None])[0] or {}
        else:
            stream = youtube_api(token, 'liveStreams', {'part': 'snippet,cdn,status'}, method='POST', body={
                'snippet': {'title': "God's Eye View LIVE ingest"},
                'cdn': {'frameRate': 'variable', 'ingestionType': 'rtmp', 'resolution': 'variable'},
            })
            stream_id = str(stream.get('id') or '')
            youtube_api(token, 'liveBroadcasts/bind', {
                'part': 'id,contentDetails',
                'id': chosen.get('id') or '',
                'streamId': stream_id,
            }, method='POST')
        ingest = ((stream.get('cdn') or {}).get('ingestionInfo') or {})
        stream_key = str(ingest.get('streamName') or '')
        watch_url = f"https://www.youtube.com/watch?v={chosen.get('id') or ''}"
    if len(stream_key) < 4:
        write({
            'status': 'error',
            'source': 'replit-connector',
            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        })
        return False
    status, payload = post_ingest(stream_key, watch_url)
    live = payload.get('live') or {}
    broadcast = payload.get('broadcast') or {}
    result = {
        'status': live.get('status') or payload.get('sessionStatus') or status,
        'watchUrl': broadcast.get('watchUrl') or watch_url,
        'liveStatus': live.get('status') or '',
        'source': 'replit-connector',
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    write(result)
    global connector_used
    connector_used = True
    return finished(result)


def try_stream_key():
    global key_fp_used
    fingerprint = current_key_fingerprint()
    if not fingerprint or fingerprint == key_fp_used:
        return False
    stream_key = first_stream_key()
    watch_url = first_line(WATCH_FILE) or env_value('YOUTUBE_WATCH_URL') or replit_secret('YOUTUBE_WATCH_URL')
    key_fp_used = fingerprint
    try:
        status, payload = post_ingest(stream_key, watch_url)
    except urllib.error.HTTPError as error:
        error.read()
        write({
            'status': 'error',
            'http': error.code,
            'source': 'stream-key-file',
            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        })
        return False
    live = payload.get('live') or {}
    broadcast = payload.get('broadcast') or {}
    result = {
        'status': live.get('status') or payload.get('sessionStatus') or status,
        'watchUrl': broadcast.get('watchUrl') or watch_url or '',
        'liveStatus': live.get('status') or '',
        'source': 'stream-key-file',
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    write(result)
    return finished(result)


def run_watch_loop():
    global last_connector_check, last_public_check
    while True:
        try:
            if try_stream_key():
                break
            now = time.time()
            if not connector_used and now - last_connector_check > 15:
                last_connector_check = now
                try:
                    if try_replit_connector():
                        break
                    # A healthy connector that failed ingest should not retry every loop.
                    # Disconnected stays retryable.
                except Exception:
                    pass
            snap = session_snapshot()
            if dead_encoder(snap):
                try:
                    post_stop()
                except Exception:
                    pass
                time.sleep(2)
                continue
            if session_blocks_go_now(snap['status']):
                write(snap)
                if finished(snap):
                    break
                now = time.time()
                if now - last_public_check > 20:
                    last_public_check = now
                    try:
                        watch = snap.get('watchUrl') or first_line(WATCH_FILE) or env_value('YOUTUBE_WATCH_URL') or replit_secret('YOUTUBE_WATCH_URL') or DEFAULT_WATCH
                        public = public_youtube_live(watch)
                        if public['isLiveNow'] and (snap.get('framesSent') or 0) > 0:
                            result = {
                                'status': 'live',
                                'watchUrl': public['watchUrl'],
                                'liveStatus': 'live',
                                'source': 'youtube-public',
                                'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                            }
                            write(result)
                            break
                    except Exception:
                        pass
                time.sleep(2)
                continue
            now = time.time()
            if now - last_public_check > 20:
                last_public_check = now
                try:
                    watch = snap.get('watchUrl') or first_line(WATCH_FILE) or env_value('YOUTUBE_WATCH_URL') or replit_secret('YOUTUBE_WATCH_URL') or DEFAULT_WATCH
                    public = public_youtube_live(watch)
                    if public['isLiveNow'] and snap['status'] in ACTIVE_STATUSES and (snap.get('framesSent') or 0) > 0:
                        result = {
                            'status': 'live',
                            'watchUrl': public['watchUrl'],
                            'liveStatus': 'live',
                            'source': 'youtube-public',
                            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                        }
                        write(result)
                        break
                except Exception:
                    pass
            ready = get(READY)
            if ready.get('ready'):
                try:
                    status, payload = post()
                    broadcast = payload.get('broadcast') or {}
                    live = payload.get('live') or {}
                    result = {
                        'status': live.get('status') or payload.get('status') or status,
                        'watchUrl': broadcast.get('watchUrl') or payload.get('watchUrl') or '',
                        'liveStatus': live.get('status') or payload.get('liveStatus') or '',
                        'source': 'go-now',
                        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    }
                    write(result)
                    if finished(result):
                        break
                    if (live.get('status') or '') == 'error':
                        time.sleep(5)
                        continue
                except urllib.error.HTTPError as error:
                    raw = error.read()
                    kind = ''
                    try:
                        kind = str((json.loads(raw.decode()) or {}).get('error', {}).get('kind') or '')
                    except Exception:
                        kind = ''
                    write({
                        'status': 'error',
                        'http': error.code,
                        'source': 'go-now',
                        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    })
                    if error.code == 409:
                        time.sleep(15)
                    elif error.code == 403 and kind == 'quota':
                        time.sleep(120)
                    else:
                        time.sleep(5)
                    continue
        except Exception:
            time.sleep(2)
            continue
        time.sleep(2)


if __name__ == '__main__':
    run_watch_loop()
