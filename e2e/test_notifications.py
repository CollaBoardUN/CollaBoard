"""Gestión de bandeja y lectura real del chat sobre el despliegue integrado."""
import os
import time
import uuid

import pytest
from playwright.sync_api import expect

from e2e.test_web_ssr import browser, new_context, register_api, create_board_api, with_session, WEB

pytestmark = pytest.mark.skipif(not os.getenv("WEB_SSR_URL"), reason="Define WEB_SSR_URL")


def test_notifications_and_chat_read_receipts(browser):
    errors = []
    a = new_context(browser, errors)
    b = new_context(browser, errors)
    token_a = register_api(a, "Ana Lectura")
    token_b = register_api(b, "Beto Lectura")
    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}
    board = create_board_api(a, token_a, "Lecturas " + uuid.uuid4().hex[:6])
    invite = a.request.post(f"{WEB}/api/boards/{board}/invite", headers=headers_a, data={"role": "editor"}).json()
    assert b.request.post(f"{WEB}/api/invites/{invite['token']}/accept", headers=headers_b).ok
    with_session(a, token_a)
    with_session(b, token_b)
    pa, pb = a.new_page(), b.new_page()
    pa.goto(f"{WEB}/boards/{board}")
    pb.goto(f"{WEB}/boards/{board}")
    pa.get_by_role("button", name="Chat", exact=True).click()
    pb.get_by_role("button", name="Chat", exact=True).click()
    pb.bring_to_front()

    def send(text):
        res = a.request.post(f"{WEB}/api/chat/boards/{board}/messages", headers=headers_a,
            data={"text": text, "client_message_id": str(uuid.uuid4())})
        assert res.status == 201, res.text()

    # First receipt proves the recipient is actively observing this chat.
    send("Mensaje de lectura inicial")
    expect(pb.get_by_role("log").get_by_text("Mensaje de lectura inicial")).to_be_visible()
    expect(pa.get_by_text("Visto por Beto Lectura", exact=True)).to_be_visible(timeout=10000)
    assert b.request.delete(f"{WEB}/api/notifications", headers=headers_b).status == 204
    send("Visible sin aviso redundante")
    expect(pb.get_by_role("log").get_by_text("Visible sin aviso redundante")).to_be_visible()
    # Wait for the delivery pipeline to settle, then check that no notice was created.
    pb.wait_for_timeout(2200)
    inbox = b.request.get(f"{WEB}/api/notifications", headers=headers_b).json()
    assert not any(n['payload'].get('preview') == "Visible sin aviso redundante" for n in inbox['items'])

    # Remove bootstrap notices after the asynchronous pipeline has settled.
    assert b.request.delete(f"{WEB}/api/notifications", headers=headers_b).status == 204
    expect(pb.get_by_role("button", name="Notificaciones", exact=True)).to_be_visible(timeout=5000)

    # A closed chat must receive notices, without a false read receipt.
    pb.get_by_role("button", name="Cerrar chat").click()
    send("Pendiente mientras el chat está cerrado")
    started = time.monotonic()
    bell = pb.get_by_role("button", name="Notificaciones, 1 sin leer")
    expect(bell).to_be_visible(timeout=8000)
    print(f"Latencia de aviso con chat cerrado: {time.monotonic() - started:.2f}s")
    bell.click()
    region = pb.get_by_role("region", name="Bandeja de notificaciones")
    expect(region).to_be_visible()
    expect(region.get_by_text("Pendiente mientras el chat está cerrado", exact=True)).to_be_visible(timeout=8000)
    os.makedirs("output", exist_ok=True)
    region.screenshot(path="output/notifications-panel.png")
    expect(pb.get_by_role("complementary", name="Chat del tablero")).not_to_be_visible()
    pb.get_by_role("button", name="Leer todas").click()
    expect(pb.get_by_role("button", name="Notificaciones", exact=True)).to_be_visible()
    expect(region).to_be_visible()
    before_a = a.request.get(f"{WEB}/api/notifications", headers=headers_a).json()
    pb.get_by_role("button", name="Borrar todas").click()
    pb.get_by_role("button", name="Confirmar borrado").click()
    expect(pb.get_by_text("No tienes notificaciones", exact=True)).to_be_visible()
    assert b.request.get(f"{WEB}/api/notifications", headers=headers_b).json()['items'] == []
    if before_a['items']:
        other_id = before_a['items'][0]['id']
        assert b.request.delete(f"{WEB}/api/notifications/{other_id}", headers=headers_b).status == 404
    after_a = a.request.get(f"{WEB}/api/notifications", headers=headers_a).json()
    assert {n['id'] for n in before_a['items']} <= {n['id'] for n in after_a['items']}
    pa.reload()
    pa.get_by_role("button", name="Chat", exact=True).click()
    expect(pa.get_by_text("Visto por Beto Lectura", exact=True).first).to_be_visible(timeout=10000)
    assert not errors, errors
    a.close()
    b.close()
