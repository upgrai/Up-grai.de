# Übergabe an Codex: UPGRAI Sales fertigstellen

Arbeitsverzeichnis: `platform/`. Branch: `claude/upgrai-sales-platform-h1aqa7`. Sprache der Oberfläche: Deutsch.

## Stand (fertig, nicht umbauen)
- **Backend** (`worker/`): Cloudflare Worker + D1 + Workflows. REST unter `/api/...` (`worker/api.ts`), MCP-Server unter `/mcp` (`worker/mcp/server.ts`), OAuth 2.1 über `@cloudflare/workers-oauth-provider` (`worker/index.ts`, `worker/oauth.ts`), Lead-Pipeline (`worker/workflows/lead-pipeline.ts`).
- **Regeln** (`shared/policy.ts`) und Tests (`test/*.test.ts`, 19 Tests, `npx vitest run`) – grün halten.
- **Frontend** (`src/`): `state.tsx` (Unternehmen → Angebot → Zielgruppe, Live-Poller), `ui.tsx` (Button, Card, Badge, Modal, Drawer, Field, Input, Select, Textarea, Empty, Skeleton, StatusDot, `useAction`, Toasts), `router.tsx`, `components/FlowBackground.tsx` (Canvas-Animation), `PipelineGraph.tsx`, `Shell.tsx`, Seiten `Today`, `Workflows`, `Contacts`, `Approvals`, `Pipeline`.

## Offene Aufgaben (in dieser Reihenfolge)

### 1. `src/pages/Connections.tsx` (Route `/verbindungen`)
- Daten: `GET /api/catalog` → `{ connectors, mcp: { url, scopes } }`; `GET /api/workspaces/:ws/connections`; `POST .../connections` `{ provider, label?, values }` (Antwort enthält `status`, `error`, bei `webhook_in` zusätzlich `oneTimeSecret` und `webhookUrl` – **nur einmal anzeigen**); `POST .../connections/:id/test`; `DELETE .../connections/:id`; `PATCH .../settings` `{ ai_provider }` setzt die aktive KI-Engine.
- Oben: animierter „Hub“ (Mitte Plattform, rundherum Anbieter-Icons, verbundene Linien leuchten in `var(--accent)`, mit `motion/react`).
- Abschnitt **KI-Assistenten** (ChatGPT, Claude, andere MCP-Clients): MCP-URL mit Kopieren-Button, kurze Schritte:
  - ChatGPT: Einstellungen → Apps & Konnektoren → Entwicklermodus → Konnektor erstellen → MCP-URL, Authentifizierung OAuth.
  - Claude: Einstellungen → Konnektoren → Eigenen Konnektor hinzufügen → URL.
  - Claude Code: `claude mcp add --transport http upgrai-sales <URL>`.
  - n8n/Make/Skripte: persönlicher Schlüssel als `Authorization: Bearer upg_…`.
  - Hinweis: Freigaben, Kontaktberechtigungen und Versand sind über MCP bewusst nicht möglich.
- Persönliche Schlüssel: `GET/POST /api/tokens` `{ name, scopes: ['sales:read','sales:write'] }` (Token nur einmal anzeigen), `DELETE /api/tokens/:id`.
- Kataloggruppen `ai`, `channel`, `data`: Karten mit Status (`connected`/`error`/`unchecked`), Formular-Modal aus `fields` (secret → `type=password`), `planned` als „geplant“ deaktiviert. Nur Inhaber (`overview.role === 'owner'`) dürfen anlegen/löschen.

### 2. `src/pages/Settings.tsx` (Route `/einstellungen`)
- Arbeitsbereich: KI-Tagesbudget (Cent), max. parallele Läufe → `PATCH /api/workspaces/:ws/settings`.
- Agentenwissen je Angebot: `services`, `pricing`, `limits`, `goal` bearbeiten → `PATCH .../offers/:id`; neues Angebot `POST .../offers`. Hinweis: leere Preise = Agent nennt keine Preise.
- Zielgruppe anlegen: `POST .../audiences` `{ offer_id, name, description, criteria: string[], default_party_type }`.
- Mitglieder: `GET/POST .../members` `{ email, role }`.
- „Neues Unternehmen anlegen“: `POST /api/workspaces` `{ name, description, accent }` danach `reloadMe()` aus `useApp()`.
- Protokoll: `GET .../audit` als Liste.

### 3. `src/App.tsx` + `src/main.tsx`
- `main.tsx`: Fonts `@fontsource-variable/inter` und `@fontsource-variable/space-grotesk` importieren, `./index.css`, rendert `<App/>`.
- `App.tsx`: `ToastProvider` → `Router` → `AppProvider` (Fallback: Ladebildschirm bzw. Fehler „Kein Zugriff“ mit Text). Darin `<FlowBackground intensity={…}/>` (1 wenn ein Agent `running`, sonst 0.3) und `<Shell>` mit Routen: `/` Today, `/workflows`, `/kontakte` und `/kontakte/:id` → Contacts, `/freigaben`, `/pipeline`, `/verbindungen`, `/einstellungen`. Seiten mit `React.lazy` laden.
- Seiten beim Unternehmenswechsel neu mounten: `key={workspaceId}`.
- Mobile Navigation in `Shell.tsx`: 5. Eintrag „Mehr“ mit Sheet für Pipeline, Verbindungen und Einstellungen.

### 4. Demo-Daten `scripts/seed-demo.sql` (nur lokal)
- Etwa 8 erfundene Kontakte in `ws_upgrai` und 5 in `ws_hermann`, alle mit `is_demo = 1` und Namen mit „(Demo)“; Telefonnummern aus dem Fiktivbereich `+49 30 1234567x`; dazu einige `research`-JSON, 2 `consents` mit `presumed_b2b` (Telefon, nur bei `business`), 3 Aufgaben, 3 Verkaufschancen.

### 5. Prüfen und abschließen
1. `npm run typecheck`, `npx vitest run`, `npm run build` – alle grün.
2. Lokal: `npm run db:migrate:local && npm run db:seed:local && npm run preview` (Worker auf :8787).
3. Ablauf testen: Kontakt → Berechtigung „Telefon, mutmaßlich“ → Agentenlauf Telefon → Freigabe erscheint → freigeben → Aufgabe „Anruf führen“ + Wiedervorlage. Dabei muss der Hintergrund Kometen/Impulse zeigen.
4. MCP testen: `curl -X POST localhost:8787/mcp` ohne Token → 401 mit `WWW-Authenticate`; mit `upg_…`-Schlüssel `initialize`, `tools/list`, `tools/call search_contacts`.
5. Screenshots (Desktop 1440×900, iPhone 390×844) mit Playwright (`executablePath: '/opt/pw-browsers/chromium'`).
6. `README.md` in `platform/`: Einrichtung (D1/KV anlegen, Secrets `ENCRYPTION_KEY`, `CONSENT_SECRET`, Cloudflare Access auf alles außer `/mcp`, `/oauth/*`, `/register`, `/.well-known/*`, `/api/hooks/*`).
7. Commit und `git push -u origin claude/upgrai-sales-platform-h1aqa7`.

## Nicht verhandelbar
- Keine Freigabe, Kontaktberechtigung oder Versand über MCP oder Agenten.
- Keine erfundenen Kennzahlen; „Gewonnen“ erzeugt keinen Zahlungseingang.
- Secrets nie an die Oberfläche zurückgeben; `.dev.vars` nicht committen.
- `prefers-reduced-motion` respektieren; mobil ohne horizontales Scrollen der Seite.
