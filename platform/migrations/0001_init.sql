-- UPGRAI Sales: Grundschema
-- Jede Geschäftstabelle trägt workspace_id; der Server prüft bei jeder Anfrage die Mitgliedschaft.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  legal_name TEXT,
  description TEXT,
  accent TEXT NOT NULL DEFAULT 'cyan',
  ai_provider TEXT,                         -- connection id oder NULL = Demo-Modus
  daily_ai_budget_cents INTEGER NOT NULL DEFAULT 500,
  max_parallel_runs INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  email TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, user_email)
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  services TEXT NOT NULL DEFAULT '',        -- freigegebene Leistungen (Markdown)
  pricing TEXT NOT NULL DEFAULT '',         -- freigegebene Preise (Markdown); leer = Agent darf keine Preise nennen
  limits TEXT NOT NULL DEFAULT '',          -- Leistungsgrenzen
  goal TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX offers_ws ON offers(workspace_id);

CREATE TABLE audiences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '[]',      -- JSON: Qualifizierungsmerkmale
  default_party_type TEXT NOT NULL DEFAULT 'unknown' CHECK (default_party_type IN ('business','consumer','unknown')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audiences_ws ON audiences(workspace_id, offer_id);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  audience_id TEXT REFERENCES audiences(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  organization TEXT,
  party_type TEXT NOT NULL DEFAULT 'unknown' CHECK (party_type IN ('business','consumer','unknown')),
  email TEXT,
  phone TEXT,                               -- E.164
  website TEXT,
  address TEXT,                             -- Postanschrift für Briefe
  city TEXT,
  country TEXT,
  language TEXT NOT NULL DEFAULT 'de',
  source_url TEXT,
  verified_at TEXT,
  research TEXT NOT NULL DEFAULT '{}',      -- JSON: Recherchemerkmale
  score INTEGER,                            -- Qualifizierung 0..100, NULL = nicht bewertet
  score_reason TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','researching','qualified','contacted','customer','lost','paused')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX contacts_ws ON contacts(workspace_id, status);
CREATE INDEX contacts_email ON contacts(workspace_id, email);
CREATE INDEX contacts_phone ON contacts(workspace_id, phone);

-- Kontaktberechtigung je Kanal (getrennt von der Freigabe einer konkreten Aktion)
CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('phone','email','whatsapp','sms','letter')),
  basis TEXT NOT NULL CHECK (basis IN ('express_consent','inbound_request','existing_customer','presumed_b2b')),
  evidence TEXT NOT NULL,                   -- Beleg: wann, wie, wer
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX consents_contact ON consents(contact_id);

-- Gemeinsame Sperrliste über alle Arbeitsbereiche (Widerspruch gilt plattformweit)
CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email','phone')),
  value_hash TEXT NOT NULL UNIQUE,          -- SHA-256 des normalisierten Werts
  reason TEXT NOT NULL,
  source_workspace_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  offer_id TEXT REFERENCES offers(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','qualified','meeting','proposal','won','lost')),
  one_time_cents INTEGER NOT NULL DEFAULT 0,
  recurring_cents_month INTEGER NOT NULL DEFAULT 0,
  is_estimate INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX opps_ws ON opportunities(workspace_id, stage);

-- Zahlungen werden manuell mit Beleg erfasst; "Gewonnen" erzeugt keine Zahlung
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  received_on TEXT NOT NULL,
  reference TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('callback','followup','reply','call','letter','review','other')),
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,
  done_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX tasks_due ON tasks(workspace_id, done_at, due_at);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call','email','whatsapp','sms','letter','note','research')),
  direction TEXT NOT NULL DEFAULT 'internal' CHECK (direction IN ('inbound','outbound','internal')),
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL
);
CREATE INDEX activities_contact ON activities(contact_id, occurred_at);

-- Agentenläufe: Recherche → Qualifizierung → Kanalprüfung → Entwurf → Freigabe → Kontakt → Wiedervorlage
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'lead_pipeline',
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','blocked','completed','failed','cancelled')),
  current_step TEXT,
  knowledge_version TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  cost_cents INTEGER NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX runs_ws ON workflow_runs(workspace_id, status, updated_at);

CREATE TABLE workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','done','blocked','failed','waiting')),
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX events_ws ON workflow_events(workspace_id, id);

-- Freigabe gilt für genau eine Aktion: Hash über Firma, Kontakt, Kanal, Empfänger, Betreff, Text
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','invalidated')),
  decided_by TEXT,
  decided_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX approvals_ws ON approvals(workspace_id, status);

-- Ausgang: genau ein Eintrag pro Freigabe; wiederholte Ausführung erzeugt keine Doppelaktion
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','manual','blocked','failed')),
  provider_ref TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Verbindungen zu Anbietern; Geheimnisse AES-GCM-verschlüsselt
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secret_ciphertext TEXT,
  status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN ('unchecked','connected','error')),
  last_error TEXT,
  last_checked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX connections_ws ON connections(workspace_id, provider);

-- Persönliche Zugangsschlüssel (MCP für Automationen wie n8n/Make); gespeichert nur als Hash
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,                     -- Leerzeichen-getrennt: sales:read sales:write
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ai_spend (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  actor TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'ui',           -- ui | mcp | workflow | webhook
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_ws ON audit_log(workspace_id, id);
