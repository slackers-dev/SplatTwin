# Ein Einstieg fuer beide Haelften des Projekts. `make` zeigt die Ziele.
.DEFAULT_GOAL := help
.PHONY: help setup web serve dev test lint check swift-test clean lhm-check lhm-setup lhm

help: ## Ziele anzeigen
	@grep -E "^[a-z-]+:.*## " $(MAKEFILE_LIST) | awk -F ":.*## " '{printf "  make %-11s %s\n", $$1, $$2}'

setup: ## Python-Umgebung und npm-Pakete installieren, Seiten bauen
	uv sync
	cd web && npm ci
	$(MAKE) web

web: ## Seiten nach web/dist bauen (liefert der Server aus)
	cd web && npm run build

serve: web ## Seiten bauen und Server starten: http://127.0.0.1:8931
	uv run splattwin serve

dev: ## Entwickeln: Python-Server und Vite mit Neuladen (Adresse zeigt Vite)
	@trap 'kill 0' EXIT; uv run splattwin serve & cd web && npm run dev

test: ## Tests: Python und Web
	uv run pytest python
	cd web && npm test

lint: ## Lint, Format, Typen und erzeugte Vertragstypen pruefen
	uv run ruff check python
	uv run ruff format --check python
	cd web && npm run lint && npm run typecheck && npm run check:contracts

check: lint test ## Alles, was auch die CI prueft

swift-test: ## Tests der App (Swift-Paket)
	cd app/Kit && swift test

lhm-check: ## RunPod: Pod erreichbar, GPU, LHM++ eingerichtet?
	scripts/runpod/lhm.sh check

lhm-setup: ## RunPod: LHM++ einmalig auf dem Pod einrichten
	scripts/runpod/lhm.sh setup

lhm: ## RunPod: Avatar aus Fotos, make lhm FOTOS=<ordner> [NAME=<name>]
	@test -n "$(FOTOS)" || { echo "make lhm FOTOS=<ordner mit fotos> [NAME=<name>]"; exit 1; }
	scripts/runpod/lhm.sh run "$(FOTOS)" $(NAME)

clean: ## Gebaute Dateien loeschen (nicht data/)
	rm -rf web/dist web/.tsbuild
