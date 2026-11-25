import asyncio
import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from splattwin.paths import CONTRACTS
from splattwin.server import app as server
from splattwin.server import captures
from splattwin.server.live import Live, parse_frame

FRAME = (CONTRACTS / "examples" / "live-frame.json").read_bytes()
CAPTURE = (CONTRACTS / "examples" / "capture.json").read_bytes()
HERE = ("127.0.0.1", 50000)  # dieser Rechner
LAN = ("192.168.1.23", 50000)  # ein Geraet im WLAN


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    dist, runs = tmp_path / "dist", tmp_path / "runs"
    (runs / "lauf1" / "frames").mkdir(parents=True)
    (runs / "lauf1" / "splat.json").write_text('{"x": 1}')
    (runs / "lauf1" / "frames" / "a_0000.png").write_bytes(b"png")
    dist.mkdir()
    (dist / "index.html").write_text("<h1>Start</h1>")
    (dist / "live.html").write_text("<h1>Live</h1>")
    (dist / "tracking.html").write_text("<h1>Tracking</h1>")
    (tmp_path / "geheim.txt").write_text("nein")
    monkeypatch.setattr(captures, "CAPTURES", tmp_path / "captures")
    return dist, runs


def client(dirs, where=HERE, lan=False):
    dist, runs = dirs
    return TestClient(server.create_app(lan=lan, web_dist=dist, runs=runs), client=where, follow_redirects=False)


def test_pages_and_runs(dirs):
    c = client(dirs)
    assert c.get("/").text == "<h1>Start</h1>"
    assert c.head("/index.html").status_code == 200  # so prueft die Mac-App, ob der Server laeuft
    assert c.get("/runs/lauf1/splat.json").json() == {"x": 1}
    assert c.get("/runs/lauf1/splat.json").headers["cache-control"] == "no-store"
    assert c.get("/runs/../geheim.txt").status_code == 404
    assert c.get("/runs/%2e%2e/geheim.txt").status_code == 404


def test_not_built(tmp_path):
    c = TestClient(server.create_app(web_dist=tmp_path / "fehlt", runs=tmp_path), client=HERE)
    assert "nicht gebaut" in c.get("/").text
    assert c.head("/index.html").status_code == 200


def test_live_frame_is_checked(dirs):
    c = client(dirs)
    assert c.post("/api/live", content=FRAME).json() == {"viewers": 0}
    res = c.post("/api/live", content=b'{"t": 1}')
    assert res.status_code == 400 and "live-frame" in res.json()["error"]


def test_errors_are_json_for_the_pages(dirs):
    c = client(dirs)
    assert c.post("/api/nichts").json() == {"error": "unbekannter Pfad"}
    res = c.post("/api/calibrate?cam=C")
    assert res.status_code == 400 and "cam" in res.json()["error"]
    res = c.post("/api/chessboard?cam=A", content=b"kein Bild")
    assert res.status_code == 400 and res.json() == {"error": "Bild konnte nicht gelesen werden"}


def test_chessboard_view(dirs):
    img = np.full((240, 320), 255, np.uint8)
    jpeg = cv2.imencode(".jpg", img)[1].tobytes()
    res = client(dirs).post("/api/chessboard?cam=B&reset=1", content=jpeg)
    assert res.json() == {"found": False, "accepted": False, "count": 0}


def test_capture_metadata_is_checked(dirs, tmp_path):
    c = client(dirs)
    assert c.post("/api/capture?name=scan-1&cam=a&kind=json", content=CAPTURE).json() == {"saved": "scan-1.json"}
    assert json.loads((tmp_path / "captures" / "scan-1.json").read_bytes())["name"] == "scan-1209"
    assert c.post("/api/capture?name=scan-2&cam=a&kind=json", content=b'{"name": "x"}').status_code == 400
    assert c.post("/api/capture?name=../x&cam=a&kind=json", content=CAPTURE).json() == {
        "error": "ungueltige Angaben zur Aufnahme"
    }


def test_info(dirs):
    assert client(dirs).get("/api/info").json() == {"lan": False, "urls": [], "viewers": 0}


def test_devices_in_the_network_may_only_watch(dirs):
    c = client(dirs, where=LAN, lan=True)
    assert c.get("/").headers["location"] == "/live.html"
    assert c.get("/live.html").text == "<h1>Live</h1>"
    assert c.get("/runs/lauf1/splat.json").status_code == 200
    assert c.get("/tracking.html").status_code == 403
    assert c.get("/runs/lauf1/frames/a_0000.png").status_code == 403
    assert c.post("/api/live", content=FRAME).status_code == 403
    assert c.get("/api/docs").status_code == 403


@pytest.mark.parametrize(
    "path,allowed",
    [
        ("/live.html", True), ("/assets/live-Ab12_x.js", True), ("/models/Xbot.glb", True),
        ("/runs/scan-1/splat.ply", True), ("/api/live", True), ("/", True),
        ("/tracking.html", False), ("/api/calibrate", False), ("/runs/scan-1/frames/a_0001.png", False),
        ("/runs/../data/x", False),
    ],
)  # fmt: skip
def test_remote_paths(path, allowed):
    assert bool(server.REMOTE_ALLOWED.fullmatch(path)) is allowed


def test_slow_viewer_gets_latest_frame_only():
    async def scenario():
        live = Live()
        live.publish(b"1")
        live.publish(b"2")
        stream = live.stream()
        first = await anext(stream)  # Tracker laeuft: das letzte Bild sofort
        assert live.viewers == 1
        live.publish(b"3")
        live.publish(b"4")  # 3 ist veraltet, bevor der Zuschauer es abholt
        second = await anext(stream)
        waiting = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.01)
        live.publish(b"5")  # weckt den wartenden Zuschauer
        third = await waiting
        await stream.aclose()
        return first, second, third, live.viewers

    assert asyncio.run(scenario()) == (b"data: 2\n\n", b"data: 4\n\n", b"data: 5\n\n", 0)


def test_close_ends_all_streams():
    async def scenario():
        live = Live()
        stream = live.stream()
        waiting = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.01)
        live.close()
        try:
            await waiting
        except StopAsyncIteration:
            return live.viewers
        return "Stream lief weiter"

    assert asyncio.run(scenario()) == 0


def test_parse_frame_removes_newlines():
    assert b"\n" not in parse_frame(FRAME)
    with pytest.raises(ValueError):
        parse_frame(b" " * (70 * 1024))
