import http.client
import json
import threading

import pytest

from splattwin.paths import CONTRACTS
from splattwin.server import app
from splattwin.server.live import Live, parse_frame

FRAME = (CONTRACTS / "examples" / "live-frame.json").read_bytes()


@pytest.fixture
def server(tmp_path, monkeypatch):
    dist, runs = tmp_path / "dist", tmp_path / "runs"
    (runs / "lauf1").mkdir(parents=True)
    (runs / "lauf1" / "splat.json").write_text('{"x": 1}')
    dist.mkdir()
    (dist / "index.html").write_text("<h1>Start</h1>")
    (tmp_path / "geheim.txt").write_text("nein")
    monkeypatch.setattr(app, "RUNS", runs)
    monkeypatch.setattr(app, "WEB_DIST", dist)
    srv = app.make_server(0, lan=False, root=dist)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


def get(port, path, method="GET", body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, body=body)
    res = conn.getresponse()
    return res.status, res.read()


def test_pages_and_runs(server):
    assert get(server, "/index.html") == (200, b"<h1>Start</h1>")
    assert get(server, "/runs/lauf1/splat.json") == (200, b'{"x": 1}')
    assert get(server, "/runs/../geheim.txt")[0] == 404
    assert get(server, "/runs/%2e%2e/geheim.txt")[0] == 404


def test_live_frame_is_checked(server):
    status, body = get(server, "/api/live", "POST", FRAME)
    assert status == 200 and json.loads(body) == {"viewers": 0}
    status, body = get(server, "/api/live", "POST", b'{"t": 1}')
    assert status == 400 and b"live-frame" in body


def test_unknown_path(server):
    assert get(server, "/api/nichts", "POST", b"")[0] == 404


@pytest.mark.parametrize(
    "path,allowed",
    [
        ("/live.html", True),
        ("/assets/live-Ab12_x.js", True),
        ("/models/Xbot.glb", True),
        ("/runs/scan-1/splat.ply", True),
        ("/api/live", True),
        ("/", True),
        ("/tracking.html", False),
        ("/api/calibrate", False),
        ("/runs/scan-1/frames/a_0001.png", False),
        ("/runs/../data/x", False),
    ],
)
def test_remote_access_is_limited(path, allowed):
    assert bool(app.REMOTE_ALLOWED.fullmatch(path)) is allowed


def test_slow_viewer_gets_latest_frame_only():
    live, got = Live(), []
    live.publish(b"1")
    live.publish(b"2")

    def write(data):
        got.append(data)
        if len(got) == 2:
            raise BrokenPipeError

    t = threading.Thread(target=live.stream, args=(write,), daemon=True)
    t.start()
    for _ in range(500):  # erst weitersenden, wenn der Zuschauer das letzte Bild hat
        if got:
            break
        threading.Event().wait(0.01)
    live.publish(b"3")
    t.join(timeout=5)
    assert got == [b"data: 2\n\n", b"data: 3\n\n"] and live.viewers == 0


def test_parse_frame_removes_newlines():
    assert b"\n" not in parse_frame(FRAME)
    with pytest.raises(ValueError):
        parse_frame(b" " * (70 * 1024))
