"""Einstieg fuer alles auf der Kommandozeile: `uv run splattwin <befehl>`.

serve       lokaler Server fuer die Seiten (Tracking, Aufnahme, Viewer, Buehne)
process     eine Aufnahme ganz durchrechnen (Splat, Kopf, Gelenke)
splat       Video -> Splat (einzelner Schritt)
merge-head  Kopf-Splat auf Koerper-Splat setzen (einzelner Schritt)
rig         Gelenke im Splat bestimmen (einzelner Schritt)
"""

import argparse

from splattwin import paths


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="splattwin", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="command", required=True, metavar="befehl")

    p = sub.add_parser("serve", help="lokaler Server (Seiten, Kalibrierung, Aufnahmen, Buehne)")
    p.add_argument("port", type=int, nargs="?", default=8931)
    p.add_argument("--lan", action="store_true", help="auch im lokalen Netz erreichbar (Buehne, Presenter-Login)")
    p.add_argument("--public", action="store_true", help="hinter einem Tunnel mit HTTPS (Login-Cookie nur ueber HTTPS)")

    p = sub.add_parser("process", help="Aufnahme ganz durchrechnen")
    p.add_argument("capture", help="Name der Aufnahme oder Pfad zu data/captures/<name>.json")

    from splattwin.pipeline import splat

    p = sub.add_parser(
        "splat", help="Video -> Splat", description=splat.__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    splat.add_arguments(p)

    p = sub.add_parser("merge-head", help="Kopf-Splat auf Koerper-Splat setzen")
    p.add_argument("body", help="Lauf mit dem Koerper (Name oder Ordner)")
    p.add_argument("head", help="Lauf mit dem Kopf (Name oder Ordner)")

    p = sub.add_parser("rig", help="Gelenke im Splat bestimmen (rig.json)")
    p.add_argument("run", help="Lauf (Name oder Ordner)")

    args = ap.parse_args(argv)
    if args.command == "serve":
        from splattwin.server.app import serve

        serve(args.port, args.lan, args.public)
    elif args.command == "process":
        from splattwin.pipeline import process

        process.run(args.capture)
    elif args.command == "splat":
        splat.run(args)
    elif args.command == "merge-head":
        from splattwin.pipeline import merge_head

        merge_head.run(paths.run_dir(args.body), paths.run_dir(args.head))
    elif args.command == "rig":
        from splattwin.pipeline import rig

        rig.run(paths.run_dir(args.run))
