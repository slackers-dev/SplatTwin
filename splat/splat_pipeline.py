"""Video einer sich drehenden Person -> Gaussian Splat (.ply).

Aufbau: Handy steht fest, die Person dreht sich an Ort. Weil der Hintergrund
maskiert wird, sieht die Rekonstruktion nur die Person, und aus "Person dreht
sich" wird rechnerisch "Kamera kreist um Person".

Schritte:
  1. frames  scharfe Einzelbilder aus dem Video waehlen
  2. masks   Person freistellen (gelerntes Modell und/oder Hintergrundbild)
  3. colmap  SIFT + Structure from Motion nur auf der Person -> Kameraposen
  4. train   Brush trainiert den Splat, Hintergrund wird transparent

Aufruf:
  uv run splat_pipeline.py video.mov --bg-start 1 --bg-seconds 4 --start 8 --end 30

Zwei Kameras (z.B. Handy und Webcam) filmen dieselbe Drehung:
  uv run splat_pipeline.py handy.mov webcam.mov --bg-start 1 --bg-seconds 4 --start 8 --end 30
Alle Zeiten gelten fuer das erste Video; im ersten Bild schaut die Person in dessen
Kamera. Der Zeitversatz des zweiten Videos kommt aus dem Ton (einmal klatschen).
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
BRUSH = HERE / "tools/brush/brush-app-aarch64-apple-darwin/brush_app"


def run(cmd):
    print("\n$", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def resize(img, max_size):
    h, w = img.shape[:2]
    s = max_size / max(h, w)
    return img if s >= 1 else cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


# ------------------------------------------------------- Synchronisation (Ton)
def onset_envelope(path):
    """Lautstaerke-Anstiege im Ton, 1000 Werte pro Sekunde. Ein Klatschen gibt eine Spitze."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000",
                          "-f", "s16le", "-"], capture_output=True).stdout
    x = np.abs(np.frombuffer(raw, np.int16).astype(np.float32))
    if len(x) < 8000:
        sys.exit(f"Kein Ton in {path.name}: Versatz von Hand mit --offset angeben.")
    env = x[: len(x) // 8 * 8].reshape(-1, 8).max(axis=1)
    return np.maximum(np.diff(env, prepend=env[0]), 0)


def audio_offset(path_a, path_b):
    """Sekunden, um die ein Ereignis in Video B spaeter liegt als in Video A.
    Kreuzkorrelation der Anstiege: der Versatz, bei dem beide Tonspuren am besten passen."""
    a, b = onset_envelope(path_a), onset_envelope(path_b)
    n = len(a) + len(b)
    corr = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    k = int(np.argmax(corr))
    peak = corr[k] / (np.median(np.abs(corr)) + 1e-9)
    if k > n // 2:
        k -= n
    print(f"Ton: lautester Anstieg in {path_a.name} bei {np.argmax(a) / 1000:.2f}s, "
          f"{path_b.name} laeuft {k / 1000:+.3f}s versetzt (Deutlichkeit {peak:.0f})")
    return k / 1000


# ------------------------------------------------------------------ 1. Frames
def read_video(path, args, offset=0.0):
    """Liefert (Hintergrundbild oder None, Liste von Frame-Gruppen).
    offset verschiebt alle Zeitangaben (zweites Video). Wechselt die Kamera waehrend der
    Drehung sprunghaft den Bildausschnitt (z.B. automatischer Zoom oder Linsenwechsel des
    Handys), gilt danach eine andere Brennweite: die Frames werden dort in Gruppen geteilt."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        sys.exit(f"Video nicht lesbar: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps
    if args.start < args.bg_seconds:
        sys.exit("--start muss nach dem Ende des leeren Hintergrunds (--bg-seconds) liegen.")
    bg0, bg1, start = args.bg_start + offset, args.bg_seconds + offset, args.start + offset
    end = args.end + offset if args.end else total
    # Das Zeitfenster in gleich lange Abschnitte teilen und je den schaerfsten
    # Frame nehmen (Varianz des Laplace-Filters als Schaerfemass).
    window = (end - start) / args.frames
    bg_frames, best = [], {}
    edge_prev, edge_diffs = None, []  # Bildrand ueber die Zeit: dort steht nie die Person
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = i / fps
        i += 1
        if t < bg1:
            if t >= bg0 and i % max(1, int((bg1 - bg0) * fps / 40)) == 0:
                bg_frames.append(resize(frame, args.max_size))
            continue
        if t < start or t >= end:
            continue
        frame = resize(frame, args.max_size)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if i % 5 == 0:
            small = cv2.resize(gray, (160, 90)).astype(np.float32)
            edge = np.concatenate([small[:, :30].ravel(), small[:, -30:].ravel()])
            if edge_prev is not None:
                edge_diffs.append((t, float(np.abs(edge - edge_prev).mean())))
            edge_prev = edge
        sharp = cv2.Laplacian(gray, cv2.CV_64F).var()
        slot = int((t - start) / window)
        if slot not in best or sharp > best[slot][0]:
            best[slot] = (sharp, frame, t)
    cap.release()
    # Ein Sprung ist viel groesser als das uebliche Rauschen am Bildrand.
    typical = np.median([d for _, d in edge_diffs]) if edge_diffs else 0
    jumps = [t for t, d in edge_diffs if d > max(10 * typical, 15)]
    cuts = [t for n, t in enumerate(jumps) if n == 0 or t - jumps[n - 1] > 1.5]
    groups = [[] for _ in range(len(cuts) + 1)]
    for k in sorted(best):
        _, frame, t = best[k]
        if any(abs(t - c) < 0.6 for c in cuts):
            continue  # waehrend des Wechsels ist das Bild unbrauchbar
        groups[sum(t > c for c in cuts)].append(frame)
    if cuts:
        print(f"{path.name}: Bildausschnitt wechselt bei " + ", ".join(f"{c - offset:.1f}s" for c in cuts)
              + " -> getrennte Brennweiten davor und danach")
    frames = [f for g in groups for f in g]
    # Der Median ueber die Zeit entfernt Rauschen aus dem leeren Hintergrund.
    bg = np.median(np.stack(bg_frames), axis=0).astype(np.uint8) if bg_frames else None
    print(f"{path.name}: {total:.1f}s @ {fps:.0f}fps -> {len(frames)} Frames, Hintergrundbild: {'ja' if bg is not None else 'nein'}")
    return bg, groups


# ------------------------------------------------------------------- 2. Masken
def largest_component(mask):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask
    keep = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    return np.where(labels == keep, 255, 0).astype(np.uint8)


def fill_holes(mask):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = np.zeros_like(mask)
    cv2.drawContours(out, contours, -1, 255, cv2.FILLED)
    return out


def bgdiff_mask(frame, bg, thresh):
    """Alles, was sich vom leeren Hintergrundbild unterscheidet."""
    diff = cv2.absdiff(cv2.GaussianBlur(frame, (5, 5), 0), cv2.GaussianBlur(bg, (5, 5), 0)).max(axis=2)
    mask = np.where(diff > thresh, 255, 0).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)


def make_masks(frames, bg, args):
    mode = args.mask
    if mode == "auto":
        mode = "both" if bg is not None else "person"
    if mode in ("bgdiff", "both") and bg is None:
        sys.exit(f"--mask {mode} braucht ein Hintergrundbild (--bg-seconds).")
    session = None
    if mode in ("person", "both"):
        from rembg import new_session, remove
        session = new_session("u2net_human_seg")
    masks = []
    for n, frame in enumerate(frames):
        if mode == "bgdiff":
            mask = fill_holes(largest_component(bgdiff_mask(frame, bg, args.bg_thresh)))
        else:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mask = np.where(remove(rgb, session=session, only_mask=True) > 127, 255, 0).astype(np.uint8)
            if mode == "both":
                # Das Hintergrundbild darf nur wegnehmen, was das Modell faelschlich
                # als Person sieht. Grosszuegig aufgeblasen, damit Stellen, an denen
                # Kleidung und Hintergrund gleich aussehen, keine Loecher reissen.
                near = cv2.dilate(bgdiff_mask(frame, bg, args.bg_thresh),
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
                mask = cv2.bitwise_and(mask, near)
            mask = largest_component(mask)
        masks.append(mask)
        print(f"\rMasken ({mode}): {n + 1}/{len(frames)}", end="", flush=True)
    print()
    return masks


def write_dataset(sets, run_dir):
    """frames/ und masks/ fuer COLMAP, data/images/ (RGBA) fuer Brush.
    sets: pro Video (Buchstabe, Frames, Masken); der Buchstabe steht vorne im Dateinamen."""
    d_frames, d_masks, d_rgba = run_dir / "frames", run_dir / "masks", run_dir / "data/images"
    for d in (d_frames, d_masks, d_rgba):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    erode = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    rows = []
    for cam, frames, masks in sets:
      for n, (frame, mask) in enumerate(zip(frames, masks)):
        name = f"{cam}_{n:04d}.png"
        cv2.imwrite(str(d_frames / name), frame)
        # COLMAP: schwarz = ignorieren. Etwas geschrumpft, weil Merkmale direkt am
        # Umriss halb aus Hintergrund bestehen und sich nicht mit der Person drehen.
        cv2.imwrite(str(d_masks / (name + ".png")), cv2.erode(mask, erode))
        soft = cv2.GaussianBlur(mask, (5, 5), 0)
        cv2.imwrite(str(d_rgba / name), np.dstack([frame, soft]))
      # Kontaktbogen, um die Masken auf einen Blick zu pruefen (eine Zeile pro Video).
      tiles = []
      for i in np.linspace(0, len(frames) - 1, min(8, len(frames))).astype(int):
        scale = 300 / frames[i].shape[0]
        f = cv2.resize(frames[i], None, fx=scale, fy=scale).astype(np.float32)
        m = cv2.resize(masks[i], None, fx=scale, fy=scale)[..., None] / 255
        tiles.append((f * (0.25 + 0.75 * m)).astype(np.uint8))
      rows.append(np.hstack(tiles))
      cover = np.mean([m.mean() / 255 for m in masks])
      print(f"Video {cam}: Person bedeckt im Schnitt {cover:.0%} des Bildes.")
    width = max(r.shape[1] for r in rows)
    sheet = np.vstack([np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in rows])
    cv2.imwrite(str(run_dir / "masken_check.jpg"), sheet)
    print(f"Kontrolle der Masken: {run_dir / 'masken_check.jpg'}")


# ------------------------------------------------------------------- 3. COLMAP
def read_cameras(model_dir):
    """Name -> (Kamerazentrum, Rotation Welt->Kamera) aus einem COLMAP-Modell."""
    txt = model_dir.parent / (model_dir.name + "_txt")
    txt.mkdir(exist_ok=True)
    subprocess.run(["colmap", "model_converter", "--input_path", model_dir, "--output_path", txt,
                    "--output_type", "TXT"], check=True, capture_output=True)
    lines = [l for l in (txt / "images.txt").read_text().split("\n") if not l.startswith("#")]
    cams = {}
    for line in lines[0::2]:  # jede zweite Zeile ist die Punktliste
        p = line.split()
        if len(p) < 10:
            continue
        qw, qx, qy, qz, tx, ty, tz = map(float, p[1:8])
        R = np.array([
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ])
        cams[p[9]] = (-R.T @ np.array([tx, ty, tz]), R)
    return cams


def read_focal(model_dir):
    """Brennweite der ersten Kamera (Pixel) aus cameras.txt, das read_cameras angelegt hat."""
    txt = model_dir.parent / (model_dir.name + "_txt") / "cameras.txt"
    for line in txt.read_text().split("\n"):
        if line and not line.startswith("#"):
            return float(line.split()[4])
    return 0


def orbit_report(cams, n_frames):
    """Bilden die Kameras einen Kreis? Das ist der Test, ob die Idee traegt."""
    print(f"\nRegistriert: {len(cams)} von {n_frames} Frames")
    for cam in sorted({n[0] for n in cams}):
        names = sorted(n for n in cams if n[0] == cam)
        C = np.array([cams[n][0] for n in names])
        c = C - C.mean(axis=0)
        _, s, vt = np.linalg.svd(c, full_matrices=False)
        xy = c @ vt[:2].T  # Projektion in die Ebene der Kamerabahn
        ang = np.unwrap(np.arctan2(xy[:, 1], xy[:, 0]))
        radius = np.linalg.norm(xy, axis=1)
        print(f"Video {cam}: {len(names)} Frames, Kamerabahn {abs(np.degrees(ang[-1] - ang[0])):.0f} Grad Bogen, "
              f"Radius schwankt um {radius.std() / radius.mean():.0%}, "
              f"Abweichung aus der Ebene {s[2] / s[1]:.0%}")
    print("Gut ist: fast alle Frames registriert, etwa 360 Grad, kleine Schwankungen.")


def run_colmap(run_dir, n_frames, focal=None):
    """focal: Brennweite als Vielfaches der Bildbreite (aus der App). Ohne Angabe schaetzt
    COLMAP sie selbst; das ist bei einer Person, die sich vor fester Kamera dreht, schlecht
    bestimmt (Schaetzungen lagen bis 20-fach daneben)."""
    db, sparse = run_dir / "colmap.db", run_dir / "sparse_all"
    db.unlink(missing_ok=True)
    shutil.rmtree(sparse, ignore_errors=True)
    sparse.mkdir()
    # Ein Durchgang pro Video: so bekommt jede Kamera ihre eigene Brennweite.
    names = sorted(f.name for f in (run_dir / "frames").iterdir())
    cams_letters = sorted({n[0] for n in names})
    # Die Brennweite der App gilt nur fuer die erste Kamera bzw. den ersten Abschnitt (a).
    # Fest halten nur, wenn es keine weitere Kamera gibt, deren Brennweite geschaetzt werden muss.
    fixed = focal is not None and cams_letters == ["a"]
    for cam in cams_letters:
        listing = run_dir / f"frames_{cam}.txt"
        listing.write_text("\n".join(n for n in names if n[0] == cam) + "\n")
        params = []
        if focal is not None and cam == "a":
            h, w = cv2.imread(str(run_dir / "frames" / next(n for n in names if n[0] == cam))).shape[:2]
            params = ["--ImageReader.camera_params", f"{focal * w:.2f},{w / 2:.2f},{h / 2:.2f}"]
            print(f"Brennweite aus der App: {focal * w:.0f} px bei {w}x{h}" + (" (fest)" if fixed else " (Startwert)"))
        run(["colmap", "feature_extractor", "--database_path", db, "--image_path", run_dir / "frames",
             "--image_list_path", listing,
             "--ImageReader.mask_path", run_dir / "masks", "--ImageReader.camera_model", "SIMPLE_PINHOLE",
             "--ImageReader.single_camera", 1, "--FeatureExtraction.use_gpu", 0, *params])
    # Erschoepfend statt nur Nachbarn: so wird auch der Kreis geschlossen
    # (letzter Frame sieht wieder dasselbe wie der erste).
    run(["colmap", "exhaustive_matcher", "--database_path", db, "--FeatureMatching.use_gpu", 0])
    run(["colmap", "mapper", "--database_path", db, "--image_path", run_dir / "frames", "--output_path", sparse,
         "--Mapper.ba_refine_focal_length", 0 if fixed else 1])
    models = [(read_cameras(m), m) for m in sorted(sparse.iterdir()) if (m / "images.bin").exists()]
    if not models:
        sys.exit("COLMAP hat kein Modell gefunden: zu wenig Merkmale auf der Person.")
    cams, best = max(models, key=lambda x: len(x[0]))
    out = run_dir / "data/sparse/0"
    shutil.rmtree(out, ignore_errors=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(best, out)
    orbit_report(cams, n_frames)
    print(f"Brennweite im Modell: {read_focal(best):.0f} px")
    return cams


# ------------------------------------------------------- Ausrichtung des Splats
def read_ply_positions(path):
    data = path.read_bytes()
    head, body = data.split(b"end_header\n", 1)
    lines = head.decode().split("\n")
    count = next(int(l.split()[2]) for l in lines if l.startswith("element vertex"))
    props = [l.split()[2] for l in lines if l.startswith("property float")]
    arr = np.frombuffer(body, np.float32, count * len(props)).reshape(count, len(props))
    return arr[:, [props.index(a) for a in "xyz"]]


def write_pose(run_dir, cams, height):
    """COLMAP legt Lage und Massstab der Welt willkuerlich fest. Aus der Kamerabahn
    folgt, wo oben und vorne ist: die Bahnebene steht senkrecht zur Drehachse der
    Person, und im ersten Bild schaut die Person in die Kamera."""
    names = sorted(cams)  # das erste Bild von Video a kommt zuerst
    C = np.array([cams[n][0] for n in names])
    Rs = [cams[n][1] for n in names]
    cam_up = np.mean([-R[1] for R in Rs], axis=0)  # Kamera-y zeigt nach unten
    up = np.zeros(3)
    for cam in sorted({n[0] for n in names}):
        Cc = np.array([cams[n][0] for n in names if n[0] == cam])
        normal = np.linalg.svd(Cc - Cc.mean(axis=0))[2][2]
        # Lange Bahnen bestimmen die Ebene genauer als kurze Stuecke: nach Laenge gewichten.
        up += (normal if normal @ cam_up > 0 else -normal) * len(Cc) ** 2
    up /= np.linalg.norm(up)
    # Mittelpunkt: der Punkt, der allen Blickachsen am naechsten liegt.
    A, b = np.zeros((3, 3)), np.zeros(3)
    for c, R in zip(C, Rs):
        P = np.eye(3) - np.outer(R[2], R[2])
        A += P
        b += P @ c
    center = np.linalg.solve(A, b)
    front = C[0] - center
    front -= (front @ up) * up
    front /= np.linalg.norm(front)
    rot = np.array([np.cross(up, front), up, front])
    # Massstab und Mitte immer aus dem reinen Koerper-Splat (ohne aufgesetzten Kopf-Scan).
    body = run_dir / "splat_koerper.ply"
    positions = read_ply_positions(body if body.exists() else run_dir / "splat.ply")
    h = (positions - center) @ up
    lo, hi = np.percentile(h, [0.5, 99.5])
    s = height / (hi - lo)
    M = np.eye(4)
    M[:3, :3] = s * rot
    M[:3, 3] = -s * rot @ center - np.array([0, s * lo, 0])
    # Die Kamera zielt nicht immer genau auf die Person: in die Mitte ruecken, wo die Kleckse liegen.
    xz = np.median(positions @ M[:3, :3].T + M[:3, 3], axis=0)
    M[0, 3] -= xz[0]
    M[2, 3] -= xz[2]
    (run_dir / "splat.json").write_text(json.dumps({"matrix": M.tolist(), "height": height}, indent=1))


# -------------------------------------------------------------------- 4. Brush
def run_brush(run_dir, steps):
    run([BRUSH, run_dir / "data", "--total-steps", steps, "--export-every", steps,
         "--export-path", run_dir, "--export-name", "splat.ply"])
    print(f"\nFertig: {run_dir / 'splat.ply'}")
    print(f"Ansehen: {BRUSH} {run_dir / 'splat.ply'}  (oder auf superspl.at/editor ziehen)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path, nargs="+", help="ein Video oder zwei Videos derselben Drehung")
    ap.add_argument("--offset", type=float, help="Sekunden, um die das zweite Video spaeter laeuft (Standard: aus dem Ton)")
    ap.add_argument("--out", type=Path, help="Ausgabeordner (Standard: runs/<Videoname>)")
    ap.add_argument("--bg-start", type=float, default=0, help="Sekunde, ab der der leere Hintergrund zu sehen ist")
    ap.add_argument("--bg-seconds", type=float, default=0, help="Sekunde, bis zu der nur der leere Hintergrund zu sehen ist")
    ap.add_argument("--start", type=float, default=0, help="Sekunde, ab der die Person in Pose steht und dreht")
    ap.add_argument("--end", type=float, default=0, help="Sekunde, an der die Drehung endet (Standard: Videoende)")
    ap.add_argument("--frames", type=int, default=120, help="Anzahl Bilder pro Video")
    ap.add_argument("--max-size", type=int, default=1280, help="laengere Bildseite in Pixeln")
    ap.add_argument("--mask", choices=["auto", "person", "bgdiff", "both"], default="auto",
                    help="person: gelerntes Modell, bgdiff: nur Hintergrundbild, both: beides (auto waehlt)")
    ap.add_argument("--bg-thresh", type=int, default=28, help="Schwelle fuer den Unterschied zum Hintergrundbild (0-255)")
    ap.add_argument("--steps", type=int, default=7000, help="Trainingsschritte in Brush")
    ap.add_argument("--height", type=float, default=1.75, help="Koerpergroesse in Metern, fuer den Massstab")
    ap.add_argument("--focal", type=float, help="Brennweite als Vielfaches der Bildbreite (aus der App); "
                    "Standard: COLMAP schaetzt sie")
    ap.add_argument("--stop-after", choices=["masks", "colmap"], help="frueher aufhoeren")
    args = ap.parse_args()

    if len(args.video) > 2:
        sys.exit("Hoechstens zwei Videos.")
    run_dir = (args.out or HERE / "runs" / args.video[0].stem).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    sets = []
    letters = iter("abcdefgh")  # ein Buchstabe pro Kamera bzw. pro Brennweite
    for n, video in enumerate(args.video):
        offset = 0.0
        if n == 1:
            offset = args.offset if args.offset is not None else audio_offset(args.video[0], video)
        bg, groups = read_video(video, args, offset)
        if sum(len(g) for g in groups) < 20:
            sys.exit(f"Zu wenige Frames in {video.name}. Stimmen --start und --end?")
        for g, frames in enumerate(groups):
            if len(frames) < 8:
                print(f"{video.name}: Abschnitt {g + 1} hat nur {len(frames)} Frames und wird weggelassen.")
                continue
            # Das Hintergrundbild stammt vom Anfang und gilt nur bis zum ersten Wechsel.
            sets.append((next(letters), frames, make_masks(frames, bg if g == 0 else None, args)))
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


if __name__ == "__main__":
    main()
