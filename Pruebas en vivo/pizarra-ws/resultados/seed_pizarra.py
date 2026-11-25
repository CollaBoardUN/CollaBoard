import json, urllib.request, urllib.error, ssl
ctx = ssl._create_unverified_context()
base = 'https://gateway'

def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, context=ctx, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

tokens = []
for i in range(1, 21):
    email = f'pizarra-ws-u{i:02d}@example.invalid'
    pwd = f'PizarraWsUser{i:02d}!2026'
    st, data = req('POST', '/api/auth/register', {'email': email, 'name': f'WS Editor {i:02d}', 'password': pwd, 'confirm_password': pwd})
    if st not in (200, 201):
        st, data = req('POST', '/api/auth/login', {'email': email, 'password': pwd})
        assert st == 200, f'Login user {i} failed: {st} {data}'
    tokens.append(data['access_token'])

owner_tok = tokens[0]
st, existing_boards = req('GET', '/api/boards', token=owner_tok)
assert st == 200
by_name = {b['name']: b['id'] for b in existing_boards}

board_ids = []
for b_idx in range(1, 16):
    bname = f'Pizarra-WS-Room-{b_idx:02d}'
    bid = by_name.get(bname)
    if not bid:
        st, created = req('POST', '/api/boards', {'name': bname}, token=owner_tok)
        assert st in (200, 201), f'Create board {bname} failed: {st} {created}'
        bid = created['id']
    board_ids.append(bid)
    # Crear link de invitacion editor y unir a los otros 19 usuarios
    st, inv = req('POST', f'/api/boards/{bid}/invite', {'role': 'editor'}, token=owner_tok)
    assert st in (200, 201), f'Invite failed: {st} {inv}'
    inv_tok = inv['token']
    for u_tok in tokens[1:]:
        st, _ = req('POST', f'/api/invites/{inv_tok}/accept', {}, token=u_tok)
        assert st in (200, 201), f'Accept invite failed: {st}'

print('SEED_JSON=' + json.dumps({'boards': board_ids, 'tokens': tokens}))