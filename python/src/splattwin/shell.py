import subprocess


def run(cmd):
    """Fuehrt ein externes Programm aus und zeigt den Aufruf. Bricht bei einem Fehler ab."""
    print("\n$", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)
