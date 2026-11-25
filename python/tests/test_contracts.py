import json

import pytest

from splattwin import contracts
from splattwin.paths import CONTRACTS


@pytest.mark.parametrize("name", contracts.names())
def test_example_matches_schema(name):
    contracts.validate(name, json.loads((CONTRACTS / "examples" / f"{name}.json").read_text()))


def test_every_schema_has_an_example():
    assert {p.stem for p in (CONTRACTS / "examples").glob("*.json")} == set(contracts.names())


def test_error_names_the_field():
    frame = json.loads((CONTRACTS / "examples" / "live-frame.json").read_text())
    frame["pts"] = frame["pts"][:10]
    with pytest.raises(contracts.ContractError, match="live-frame: pts"):
        contracts.validate("live-frame", frame)


def test_capture_written_by_the_app_is_valid():
    # Felder wie CaptureMeta in der Mac-App (CaptureStore.swift)
    meta = {
        "name": "scan-1101",
        "marks": {"bgStart": 0.5, "bgEnd": 3, "faceStart": 4, "faceEnd": 20},
        "offset": 0.012,
        "saved": {"a": {"saved": "scan-1101_a.mov", "width": 2160, "height": 3840, "seconds": 41}},
        "notes": [],
        "height": 1.8,
        "body": "scan-1000",
        "app": {"version": 1, "cameras": []},
    }
    contracts.validate("capture", meta)
