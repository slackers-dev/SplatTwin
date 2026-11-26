# Projektdokumentation

Hier dokumentieren wir das Projekt selbst: wie es verläuft und was wir warum entschieden haben.
Wie der Code funktioniert, steht in [`../docs/`](../docs/).

| Ordner | Frage | Beispiel |
|---|---|---|
| `project-documentation/` | Was haben wir gemacht und warum? | Verlauf, Entscheidungen, offene Fragen |
| `docs/` | Wie funktioniert es heute? | Architektur, Konventionen, Drehbücher |

## Inhalt

- [`verlauf.md`](verlauf.md): was wann passiert ist, neueste Einträge oben
- [`entscheidungen/`](entscheidungen/): ein Dokument pro Entscheidung, nummeriert

### Entscheidungen

| Nr. | Entscheidung | Status | Datum |
|---|---|---|---|
| [0001](entscheidungen/0001-typescript-fuer-web.md) | Web-Teil in TypeScript mit Vite | angenommen | 25.11.2026 |
| [0002](entscheidungen/0002-python-als-paket-mit-uv.md) | Python als ein Paket in einem uv-Workspace | angenommen | 25.11.2026 |
| [0003](entscheidungen/0003-datenformate-als-vertraege.md) | Datenformate als JSON-Schema in `contracts/` | angenommen | 25.11.2026 |
| [0004](entscheidungen/0004-server-mit-fastapi.md) | Server mit FastAPI statt Standardbibliothek | angenommen | 25.11.2026 |
| [0005](entscheidungen/0005-sprache-im-code.md) | Bezeichner Englisch, Kommentare und Doku Deutsch | angenommen | 25.11.2026 |
| [0006](entscheidungen/0006-umbau-auf-einem-branch.md) | Umbau auf einem Branch, ohne `legacy/` | angenommen | 25.11.2026 |
| [0007](entscheidungen/0007-avatar-weg.md) | Avatar-Weg: SMPL-X mit ExAvatar | offen | 20.11.2026 |
| [0008](entscheidungen/0008-gpu-runner-pod-do.md) | GPU-Aufgaben mit pod-do auf RunPod | angenommen | 26.11.2026 |

## Eine Entscheidung festhalten

1. [`entscheidungen/vorlage.md`](entscheidungen/vorlage.md) kopieren, nächste freie Nummer vergeben:
   `entscheidungen/0008-kurzer-titel.md`
2. Ausfüllen, Status `offen`, solange wir noch nicht entschieden haben
3. In die Tabelle oben eintragen
4. Ändert sich eine Entscheidung später, das alte Dokument nicht umschreiben: Status auf
   `ersetzt durch 00xx` setzen und ein neues anlegen

Festhalten lohnt sich bei allem, was man später nicht mehr aus dem Code ablesen kann: warum diese
Bibliothek, warum nicht die andere, welche Annahme dahintersteckt.

## Verlauf nachführen

Nach einem Meilenstein, einem Versuch oder einem Treffen einen kurzen Eintrag oben in
[`verlauf.md`](verlauf.md): Datum, was passiert ist, Links auf Commits, PRs oder Entscheidungen.
Auch Versuche, die nicht geklappt haben, gehören hinein.
