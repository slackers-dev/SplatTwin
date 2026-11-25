"""Video einer sich drehenden Person -> Gaussian Splat (.ply), aufgerichtet (splat.json).

Aufbau: Handy steht fest, die Person dreht sich an Ort. Weil der Hintergrund
maskiert wird, sieht die Rekonstruktion nur die Person, und aus "Person dreht
sich" wird rechnerisch "Kamera kreist um Person".

Schritte:
  1. frames  scharfe Einzelbilder aus dem Video waehlen
  2. masks   Person freistellen (gelerntes Modell und/oder Hintergrundbild)
  3. colmap  SIFT + Structure from Motion nur auf der Person -> Kameraposen
  4. train   Brush trainiert den Splat, Hintergrund wird transparent

Aufruf:
  splattwin splat video.mov --bg-start 1 --bg-seconds 4 --start 8 --end 30

Zwei Kameras (z.B. Handy und Webcam) filmen dieselbe Drehung:
  splattwin splat handy.mov webcam.mov --bg-start 1 --bg-seconds 4 --start 8 --end 30
Alle Zeiten gelten fuer das erste Video; im ersten Bild schaut die Person in dessen
Kamera. Der Zeitversatz des zweiten Videos kommt aus dem Ton (einmal klatschen).
"""

import argparse
import sys
from pathlib import Path

from splattwin.paths import RUNS
from splattwin.pipeline.align import write_pose
from splattwin.pipeline.dataset import write_dataset
from splattwin.pipeline.frames import Window, read_video
from splattwin.pipeline.sfm import run_colmap
from splattwin.pipeline.sync import audio_offset
from splattwin.pipeline.train import run_brush
from splattwin.vision.segmentation import make_masks


def add_arguments(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("video", type=Path, nargs="+", help="ein Video oder zwei Videos derselben Drehung")
    ap.add_argument(
        "--offset", type=float, help="Sekunden, um die das zweite Video spaeter laeuft (Standard: aus dem Ton)"
    )
    ap.add_argument("--out", type=Path, help="Ausgabeordner (Standard: data/runs/<Videoname>)")
    ap.add_argument("--bg-start", type=float, default=0, help="Sekunde, ab der der leere Hintergrund zu sehen ist")
    ap.add_argument(
        "--bg-seconds", type=float, default=0, help="Sekunde, bis zu der nur der leere Hintergrund zu sehen ist"
    )
    ap.add_argument("--start", type=float, default=0, help="Sekunde, ab der die Person in Pose steht und dreht")
    ap.add_argument("--end", type=float, default=0, help="Sekunde, an der die Drehung endet (Standard: Videoende)")
    ap.add_argument("--frames", type=int, default=120, help="Anzahl Bilder pro Video")
    ap.add_argument("--max-size", type=int, default=1280, help="laengere Bildseite in Pixeln")
    ap.add_argument(
        "--mask",
        choices=["auto", "person", "bgdiff", "both"],
        default="auto",
        help="person: gelerntes Modell, bgdiff: nur Hintergrundbild, both: beides (auto waehlt)",
    )
    ap.add_argument(
        "--bg-thresh", type=int, default=28, help="Schwelle fuer den Unterschied zum Hintergrundbild (0-255)"
    )
    ap.add_argument("--steps", type=int, default=7000, help="Trainingsschritte in Brush")
    ap.add_argument("--height", type=float, default=1.75, help="Koerpergroesse in Metern, fuer den Massstab")
    ap.add_argument(
        "--focal",
        type=float,
        help="Brennweite als Vielfaches der Bildbreite (aus der App); Standard: COLMAP schaetzt sie",
    )
    ap.add_argument("--stop-after", choices=["masks", "colmap"], help="frueher aufhoeren")


def run(args: argparse.Namespace) -> None:
    if len(args.video) > 2:
        sys.exit("Hoechstens zwei Videos.")
    run_dir = (args.out or RUNS / args.video[0].stem).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    window = Window(bg_start=args.bg_start, bg_end=args.bg_seconds, start=args.start, end=args.end)
    sets = []
    letters = iter("abcdefgh")  # ein Buchstabe pro Kamera bzw. pro Brennweite
    for n, video in enumerate(args.video):
        offset = 0.0
        if n == 1:
            offset = args.offset if args.offset is not None else audio_offset(args.video[0], video)
        bg, groups = read_video(video, window, args.frames, args.max_size, offset)
        if sum(len(g) for g in groups) < 20:
            sys.exit(f"Zu wenige Frames in {video.name}. Stimmen --start und --end?")
        for g, frames in enumerate(groups):
            if len(frames) < 8:
                print(f"{video.name}: Abschnitt {g + 1} hat nur {len(frames)} Frames und wird weggelassen.")
                continue
            # Das Hintergrundbild stammt vom Anfang und gilt nur bis zum ersten Wechsel.
            masks = make_masks(frames, bg if g == 0 else None, args.mask, args.bg_thresh)
            sets.append((next(letters), frames, masks))
    write_dataset(sets, run_dir)
    n_frames = sum(len(f) for _, f, _ in sets)
    if args.stop_after == "masks":
        return
    cams = run_colmap(run_dir, n_frames, args.focal)
    if args.stop_after == "colmap":
        return
    if len(cams) < n_frames * 0.5:
        sys.exit("Weniger als die Haelfte der Frames registriert, das Training lohnt sich so nicht.")
    run_brush(run_dir, args.steps)
    write_pose(run_dir, cams, args.height)
