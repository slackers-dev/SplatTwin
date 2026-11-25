"""Pruefung gegen die Vertraege in contracts/ (JSON-Schema).

Dateien, die zwischen den Teilen des Projekts ausgetauscht werden, werden beim Lesen und Schreiben
geprueft: ein falsches Format faellt dort auf, wo es entsteht, und nicht erst im Browser.
"""

import json
from functools import cache
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from splattwin.paths import CONTRACTS


class ContractError(ValueError):
    pass


@cache
def _validators() -> dict[str, Draft202012Validator]:
    schemas = {p.name.removesuffix(".schema.json"): json.loads(p.read_text()) for p in CONTRACTS.glob("*.schema.json")}
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas.values())
    return {name: Draft202012Validator(schema, registry=registry) for name, schema in schemas.items()}


def names() -> list[str]:
    return sorted(_validators())


def validate(name: str, data) -> None:
    """Wirft ContractError, wenn data nicht zum Schema contracts/<name>.schema.json passt."""
    errors = sorted(_validators()[name].iter_errors(data), key=lambda e: list(e.absolute_path))
    if errors:
        e = errors[0]
        where = "/".join(str(p) for p in e.absolute_path) or "(oben)"
        raise ContractError(f"{name}: {where}: {e.message}")


def read(path: Path, name: str):
    data = json.loads(Path(path).read_text())
    validate(name, data)
    return data


def write(path: Path, name: str, data, indent: int = 1) -> None:
    validate(name, data)
    Path(path).write_text(json.dumps(data, indent=indent))
