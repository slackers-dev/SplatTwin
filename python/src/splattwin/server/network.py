import socket


def lan_addresses() -> list[str]:
    """IP-Adressen dieses Rechners im lokalen Netz (ohne Verbindung nach aussen zu oeffnen)."""
    found = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # UDP: es wird nichts gesendet
            found.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(a for a in found if not a.startswith("127."))
