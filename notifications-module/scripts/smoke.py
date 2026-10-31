#!/usr/bin/env python3
"""Smoke test de contrato con Auth real + NotificationAPI real + worker real.
No destruye información: crea dos usuarios efímeros y un evento de prueba.
"""
import json, os, sys, time, uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
for line in (ROOT / '.env').read_text().splitlines() if (ROOT / '.env').is_file() else []:
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"\''))
SERVICE_TOKEN = os.getenv('NOTIFICATIONS_SERVICE_TOKEN')
if not SERVICE_TOKEN:
    sys.exit('Falta NOTIFICATIONS_SERVICE_TOKEN en .env')
AUTH = os.getenv('TEST_AUTH_URL', 'http://localhost:8001')
API = os.getenv('TEST_NOTIFICATIONS_URL', 'http://localhost:4100')

def call(method, url, payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = Request(url, method=method, data=data, headers={
        'Accept': 'application/json',
        **({'Content-Type':'application/json'} if data else {}),
        **(headers or {}),
    })
    try:
        with urlopen(req, timeout=8) as result:
            return result.status, json.load(result)
    except HTTPError as err:
        try: parsed = json.load(err)
        except Exception: parsed = {'detail': err.reason}
        return err.code, parsed

def register(name):
    payload = {'name': name, 'email': f'notif-test-{uuid.uuid4().hex}@example.com',
               'password': 'Test-Password-Fuerte-2026!', 'confirm_password':'Test-Password-Fuerte-2026!'}
    code, result = call('POST', AUTH + '/auth/register', payload)
    assert code == 201, ('registro', code, result)
    return result['user']['id'], result['access_token']

alice, alice_token = register('Smoke Alice')
bob, bob_token = register('Smoke Bob')
event = {'event_id':str(uuid.uuid4()),'type':'chat.message.created','occurred_at':'2026-10-30T12:00:00Z',
         'actor_id':alice, 'board_id':str(uuid.uuid4()),'recipient_ids':[alice,bob,bob],
         'payload':{'board_name':'Prueba P2','actor_name':'Smoke Alice','preview':'Hola desde prueba C#'}}
headers = {'X-Service-Token':SERVICE_TOKEN}
code, response = call('POST', API+'/internal/events', event, headers)
assert code == 202, ('evento', code, response)
code, response = call('POST', API+'/internal/events', event, headers)
assert code == 202 and response['duplicate'], ('idempotencia entrada',code,response)
for _ in range(40):
    code, inbox = call('GET', API+'/api/notifications',headers={'Authorization':'Bearer '+bob_token})
    if code == 200 and any(x['type']=='chat.message.created' and x['board_id']==event['board_id'] for x in inbox['items']):
        break
    time.sleep(1)
else:
    sys.exit(f'El evento no llegó al worker en 40 s. Última respuesta: {code}, {inbox}')
matching = [x for x in inbox['items'] if x['board_id']==event['board_id']]
assert len(matching) == 1, ('notificaciones duplicadas',matching)
n = matching[0]
code, result = call('GET', API+'/api/notifications',headers={'Authorization':'Bearer '+alice_token})
assert code == 200 and all(x['board_id'] != event['board_id'] for x in result['items']), 'Notificación enviada al autor'
code, result = call('PATCH', API+'/api/notifications/'+n['id']+'/read',headers={'Authorization':'Bearer '+alice_token})
assert code == 404, ('falla aislamiento entre usuarios',code,result)
code, result = call('PATCH', API+'/api/notifications/'+n['id']+'/read',headers={'Authorization':'Bearer '+bob_token})
assert code == 200 and result['read_at'], ('marcar leída',code,result)
print('OK: evento aceptado 202, repetición idempotente, worker entrega, autor excluido,')
print('    privacidad 404, marcar leída persistente; evento=',event['event_id'])
