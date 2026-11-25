"""Wer darf was: dieser Rechner, eingeloggte Presenter und alle anderen (Zuschauer).

- Dieser Rechner (direkt, nicht ueber einen Tunnel) darf alles.
- Presenter loggen sich ueber eine Adresse ein, die mit "present." beginnt (z. B.
  present.splattwin.ch, zum Testen http://present.localhost:8931), mit dem Passwort ihres Platzes.
  Danach duerfen sie tracken, senden (nur auf ihrem Platz) und Folien umschalten.
- Alle anderen sehen nur die Buehne.

Ein Tunnel (z. B. Cloudflare) liefert alle Anfragen ueber 127.0.0.1 an den Server. Deshalb zaehlt eine
Anfrage nur als "dieser Rechner", wenn sie ohne Weiterleitungs-Header und mit Hostname localhost kommt.
"""

import secrets
import time
from http.cookies import SimpleCookie

from starlette.datastructures import Headers

LOCAL_CLIENTS = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")
FORWARD_HEADERS = ("x-forwarded-for", "cf-connecting-ip", "forwarded")
PRESENTER_PREFIX = "present."
COOKIE = "splattwin_session"
SESSION_HOURS = 12


def host(headers: Headers) -> str:
    """Hostname ohne Port, z. B. present.localhost oder [::1]."""
    value = headers.get("host", "").lower()
    if value.startswith("["):
        return value.split("]")[0] + "]"
    return value.rsplit(":", 1)[0]


def is_local(client: tuple[str, int] | None, headers: Headers) -> bool:
    return (
        bool(client)
        and client[0] in LOCAL_CLIENTS
        and not any(h in headers for h in FORWARD_HEADERS)
        and host(headers) in LOCAL_HOSTS
    )


def is_presenter_host(headers: Headers) -> bool:
    return host(headers).startswith(PRESENTER_PREFIX)


class Sessions:
    """Eingeloggte Presenter: Token im Cookie -> (Platz, Ablaufzeit). Nur im Speicher, ein Neustart
    loggt alle aus."""

    def __init__(self, passwords: dict[str, str]):
        self.passwords = passwords
        self.tokens: dict[str, tuple[str, float]] = {}

    def login(self, slot: str, password: str) -> str | None:
        expected = self.passwords.get(slot, "")
        if not expected or not secrets.compare_digest(password.encode(), expected.encode()):
            return None
        token = secrets.token_urlsafe(24)
        self.tokens[token] = (slot, time.time() + SESSION_HOURS * 3600)
        return token

    def logout(self, token: str | None) -> None:
        self.tokens.pop(token or "", None)

    def slot(self, headers: Headers) -> str | None:
        """Platz des eingeloggten Presenters, nur auf der Presenter-Adresse, sonst None."""
        if not is_presenter_host(headers):
            return None
        slot, until = self.tokens.get(token(headers) or "", ("", 0.0))
        return slot if until > time.time() else None


def token(headers: Headers) -> str | None:
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get("cookie", ""))
    except Exception:  # kaputte Cookies anderer Seiten auf derselben Adresse
        return None
    morsel = cookie.get(COOKIE)
    return morsel.value if morsel else None


def cookie_header(value: str, secure: bool, max_age: int = SESSION_HOURS * 3600) -> str:
    flags = "; Secure" if secure else ""
    return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{flags}"
