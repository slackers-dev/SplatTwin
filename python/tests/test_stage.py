import asyncio
import json
import os
import struct

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from splattwin import contracts
from splattwin.server import app as server
from splattwin.server import captures
from splattwin.server.stage import Stage, frame_ok, save_skin, skin_current

HERE = ("127.0.0.1", 50000)  # dieser Rechner (oder ein Tunnel, der auch von hier kommt)
LAN = ("192.168.1.23", 50000)
PASSWORDS = {"A": "pw-a", "B": "pw-b"}
PRESENT = "present.localhost:8931"


def frame(joints=17, left=False, right=False, version=1) -> bytes:
    """Bild im Format von web/src/live/protocol.ts (Inhalt egal, nur die Laenge zaehlt)."""
    mask = (1 << joints) - 1
    flags = (4 if left else 0) | (8 if right else 0)
    head = struct.pack("<BBIhhI", version, flags, 1234, 0, 0, mask)
    return head + bytes(joints * 6 + (left + right) * 126)


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    dist, runs = tmp_path / "dist", tmp_path / "runs"
    (runs / "lauf1").mkdir(parents=True)
    (runs / "lauf1" / "splat.ply").write_bytes(b"ply")
    dist.mkdir()
    for page in ("index", "live", "tracking", "control", "login"):
        (dist / f"{page}.html").write_text(f"<h1>{page}</h1>")
    monkeypatch.setattr(captures, "CAPTURES", tmp_path / "captures")
    return dist, runs, tmp_path / "stage"


def client(dirs, where=HERE, host="127.0.0.1:8931", headers=None, app=None):
    """app: dieselbe App wie ein anderer Client (z. B. Presenter und Zuschauer am selben Server)."""
    dist, runs, stage = dirs
    app = app or server.create_app(web_dist=dist, runs=runs, stage_dir=stage, passwords=PASSWORDS)
    return TestClient(app, client=where, base_url=f"http://{host}", headers=headers, follow_redirects=False)


def ws(c, path):
    """WebSocket mit dem Hostnamen des Clients (der Testclient nimmt ihn nur aus einer absoluten Adresse)."""
    return c.websocket_connect(str(c.base_url).replace("http", "ws", 1).rstrip("/") + path)


def login(c, slot="A", password=None):
    return c.post("/api/login", content=json.dumps({"slot": slot, "password": password or PASSWORDS[slot]}))


# ---------------------------------------------------------------------- Bildformat
def test_frame_length_must_match_mask_and_hands():
    assert frame_ok(frame())
    assert frame_ok(frame(joints=5, left=True, right=True))
    assert not frame_ok(frame()[:-1])
    assert not frame_ok(frame() + b"x")
    assert not frame_ok(frame(version=2))
    assert not frame_ok(b"\x01")
    too_many = bytearray(frame())
    too_many[10:14] = (1 << 20).to_bytes(4, "little")  # Gelenk 21 gibt es nicht
    assert not frame_ok(bytes(too_many))


# ---------------------------------------------------------------------- Kanaele
def test_slow_viewer_gets_latest_frame_per_slot(tmp_path):
    async def scenario():
        stage = Stage(tmp_path)
        stream = stage.stream(lambda: True)
        assert await anext(stream) == ("slides", b'{"doc": null, "page": 1, "pages": 0}')
        stage.publish("A", b"1")
        stage.publish("A", b"2")  # 1 ist veraltet, bevor der Zuschauer es abholt
        stage.publish("B", b"x")
        got = [await anext(stream), await anext(stream)]
        waiting = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.01)
        stage.publish("B", b"y")  # weckt den wartenden Zuschauer
        got.append(await waiting)
        await stream.aclose()
        return got, stage.viewers

    assert asyncio.run(scenario()) == ([("A", b"2"), ("B", b"x"), ("B", b"y")], 0)


def test_close_ends_all_streams(tmp_path):
    async def scenario():
        stage = Stage(tmp_path)
        stream = stage.stream(lambda: True)
        await anext(stream)  # Folienstand
        waiting = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.01)
        stage.close()
        try:
            await waiting
        except StopAsyncIteration:
            return stage.viewers
        return "Stream lief weiter"

    assert asyncio.run(scenario()) == 0


# ---------------------------------------------------------------------- Folien und Plaetze
def test_slides_survive_a_restart(tmp_path):
    stage = Stage(tmp_path)
    with pytest.raises(ValueError, match="kein PDF"):
        stage.save_pdf(b"hallo", "x.pdf")
    state = stage.save_pdf(b"%PDF-1.4 ...", "Vortrag.pdf")
    assert state["page"] == 1 and state["pages"] == 0 and state["name"] == "Vortrag.pdf"
    assert stage.set_slides(pages=5, page=9)["page"] == 5  # nicht hinter die letzte Folie
    contracts.validate("stage-slides", stage.slides())
    assert Stage(tmp_path).slides() == stage.slides()
    (tmp_path / "slides.pdf").unlink()
    assert Stage(tmp_path).slides()["doc"] is None  # PDF weg: keine Folien


def test_seats_are_checked_and_remembered(tmp_path):
    stage = Stage(tmp_path)
    stage.set_meta("B", {"name": "Kev", "run": "scan-1209"})
    with pytest.raises(contracts.ContractError):
        stage.set_meta("A", {"name": "x", "run": "../etc"})
    assert json.loads(Stage(tmp_path).get("meta:B")) == {"name": "Kev", "run": "scan-1209"}
    assert Stage(tmp_path).get("meta:A") is None


def test_skin_is_only_valid_for_its_splat(tmp_path):
    (tmp_path / "lauf1").mkdir()
    ply = tmp_path / "lauf1" / "splat.ply"
    ply.write_bytes(b"ply")
    with pytest.raises(ValueError):
        save_skin(tmp_path, "lauf1", b"falsch")
    with pytest.raises(ValueError):
        save_skin(tmp_path, "../lauf1", b"SKN1")
    save_skin(tmp_path, "lauf1", b"SKN1 daten")
    assert skin_current(tmp_path, "lauf1")
    later = ply.stat().st_mtime + 10
    os.utime(ply, (later, later))  # Splat neu gerechnet
    assert not skin_current(tmp_path, "lauf1")


# ---------------------------------------------------------------------- Zugang
def test_presenter_login_only_on_present_address(dirs):
    viewer = client(dirs, where=LAN, host="splattwin.example:8931")
    assert viewer.get("/").headers["location"] == "/live.html"
    assert viewer.post("/api/login", content=b"{}").status_code == 403

    c = client(dirs, host=PRESENT)
    assert c.get("/").headers["location"] == "/login.html"
    assert c.get("/tracking.html").headers["location"] == "/login.html"
    assert c.get("/login.html").status_code == 200
    assert login(c, password="falsch").status_code == 401
    res = login(c, "B")
    assert res.json() == {"slot": "B"} and "HttpOnly" in res.headers["set-cookie"]
    assert c.get("/").headers["location"] == "/tracking.html"
    assert c.get("/tracking.html").status_code == 200
    assert c.get("/api/info").json()["slot"] == "B"
    assert c.post("/api/capture?name=x&cam=a&kind=json", content=b"{}").status_code == 403  # nur dieser Rechner
    c.post("/api/logout")
    assert c.get("/tracking.html").headers["location"] == "/login.html"


def test_tunnel_is_not_this_computer(dirs):
    # Ein Tunnel kommt auch von 127.0.0.1, bringt aber einen fremden Namen und Weiterleitungs-Header mit.
    c = client(dirs, host="splattwin.example", headers={"x-forwarded-for": "8.8.8.8"})
    assert c.get("/tracking.html").status_code == 403
    assert c.post("/api/slide", content=b'{"page": 2}').status_code == 403
    c = client(dirs, headers={"cf-connecting-ip": "8.8.8.8"})
    assert c.get("/tracking.html").status_code == 403


def test_cache_rules(dirs):
    c = client(dirs)
    assert c.get("/live.html").headers["cache-control"] == "no-cache"
    assert c.get("/api/info").headers["cache-control"] == "no-store"
    assert server.cache_control("/assets/live-Ab12.js", b"") == b"public, max-age=31536000, immutable"
    assert server.cache_control("/models/Xbot.glb", b"") == b"public, max-age=86400"
    assert server.cache_control("/stage/slides.pdf", b"v=17") == b"public, max-age=86400"
    assert server.cache_control("/stage/slides.pdf", b"") == b"no-cache"


# ---------------------------------------------------------------------- Live ueber WebSockets
def test_frames_go_from_presenter_to_viewers(dirs):
    c = client(dirs, host=PRESENT)
    login(c, "B")
    viewer = client(dirs, where=LAN, host="splattwin.example:8931", app=c.app)
    with ws(viewer, "/ws/stage") as watch:
        assert json.loads(watch.receive_text())["type"] == "slides"
        with ws(c, "/ws/send?slot=A") as send:  # eingeloggt als B: ?slot zaehlt nicht
            assert send.receive_json() == {"type": "hello", "slot": "B"}
            send.send_text(json.dumps({"name": "Kev", "run": "lauf1"}))
            assert json.loads(watch.receive_text()) == {
                "type": "meta",
                "slot": "B",
                "meta": {"name": "Kev", "run": "lauf1"},
            }
            send.send_bytes(b"kaputt")  # falsche Laenge: verworfen
            send.send_bytes(frame(joints=3))
            assert watch.receive_bytes() == b"\x01" + frame(joints=3)  # Platz B = 1 davor
            assert send.receive_json() == {"type": "info", "viewers": 1}


def test_only_presenters_may_send(dirs):
    viewer = client(dirs, where=LAN, host="splattwin.example:8931")
    with pytest.raises(WebSocketDisconnect), ws(viewer, "/ws/send"):
        pass
    here = client(dirs)
    with ws(here, "/ws/send?slot=B") as send:  # dieser Rechner waehlt den Platz
        assert send.receive_json() == {"type": "hello", "slot": "B"}


def test_slides_from_the_control_page(dirs):
    c = client(dirs, host=PRESENT)
    login(c)
    assert c.post("/api/slides?name=v.pdf", content=b"kein pdf").status_code == 400
    state = c.post("/api/slides?name=v.pdf", content=b"%PDF-1.4").json()
    assert c.post("/api/slide", content=b'{"pages": 3}').json()["pages"] == 3
    assert c.post("/api/slide", content=b'{"page": 2}').json()["page"] == 2
    viewer = client(dirs, where=LAN, host="splattwin.example:8931")
    assert viewer.get(f"/stage/slides.pdf?v={state['doc']}").content == b"%PDF-1.4"


def test_skin_upload_and_download(dirs):
    here = client(dirs)
    assert here.get("/runs/lauf1/skin.bin").status_code == 404
    assert here.post("/api/skin?run=lauf1", content=b"SKN1 daten").json()["bytes"] == 10
    viewer = client(dirs, where=LAN, host="splattwin.example:8931")
    assert viewer.get("/runs/lauf1/skin.bin").content == b"SKN1 daten"
    assert viewer.post("/api/skin?run=lauf1", content=b"SKN1").status_code == 403
