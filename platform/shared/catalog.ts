// Katalog der verbindbaren Anbieter. Wird von Oberfläche (Formulare) und Server (Prüfung, Nutzung) geteilt.

export type ConnectorCategory = 'ai' | 'channel' | 'data';

export interface ConnectorField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ConnectorDef {
  id: string;
  name: string;
  category: ConnectorCategory;
  tagline: string;
  /** Welche Fähigkeiten die Verbindung freischaltet */
  provides: string[];
  fields: ConnectorField[];
  docsUrl?: string;
  /** Noch nicht nutzbar, aber sichtbar geplant */
  planned?: boolean;
}

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    category: 'ai',
    tagline: 'Recherche-Auswertung, Qualifizierung und Entwürfe',
    provides: ['agents'],
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    fields: [
      { key: 'apiKey', label: 'API-Schlüssel', secret: true, required: true, placeholder: 'AIza…' },
      { key: 'model', label: 'Modell', required: true, placeholder: 'gemini-flash-latest', help: 'Modellname aus Google AI Studio' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'ai',
    tagline: 'Alternative Agenten-Engine über die Responses API',
    provides: ['agents'],
    docsUrl: 'https://platform.openai.com/docs',
    fields: [
      { key: 'apiKey', label: 'API-Schlüssel', secret: true, required: true, placeholder: 'sk-…' },
      { key: 'model', label: 'Modell', required: true, placeholder: 'Modellname aus der OpenAI-Konsole' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    category: 'ai',
    tagline: 'Alternative Agenten-Engine über die Messages API',
    provides: ['agents'],
    docsUrl: 'https://docs.claude.com',
    fields: [
      { key: 'apiKey', label: 'API-Schlüssel', secret: true, required: true, placeholder: 'sk-ant-…' },
      { key: 'model', label: 'Modell', required: true, placeholder: 'claude-opus-5-5' },
    ],
  },
  {
    id: 'twilio',
    name: 'Twilio',
    category: 'channel',
    tagline: 'WhatsApp, SMS und Telefonie je Unternehmen',
    provides: ['whatsapp', 'sms', 'phone'],
    docsUrl: 'https://www.twilio.com/docs',
    fields: [
      { key: 'accountSid', label: 'Account SID', required: true, placeholder: 'AC…' },
      { key: 'authToken', label: 'Auth Token', secret: true, required: true },
      { key: 'smsFrom', label: 'Absender SMS', placeholder: '+49…' },
      { key: 'whatsappFrom', label: 'Absender WhatsApp', placeholder: 'whatsapp:+49…' },
    ],
  },
  {
    id: 'resend',
    name: 'Resend',
    category: 'channel',
    tagline: 'E-Mail-Versand mit eigener Absenderdomain',
    provides: ['email'],
    docsUrl: 'https://resend.com/docs',
    fields: [
      { key: 'apiKey', label: 'API-Schlüssel', secret: true, required: true, placeholder: 're_…' },
      { key: 'from', label: 'Absender', required: true, placeholder: 'Vorname Nachname <vertrieb@up-grai.de>' },
    ],
  },
  {
    id: 'webhook_in',
    name: 'Eingehender Webhook',
    category: 'data',
    tagline: 'Leads aus n8n, Make, Zapier oder Formularen empfangen',
    provides: ['import'],
    fields: [{ key: 'audienceId', label: 'Zielgruppe für neue Leads', placeholder: 'optional' }],
  },
  {
    id: 'google_calendar',
    name: 'Google Kalender',
    category: 'data',
    tagline: 'Rückrufe und Termine synchronisieren',
    provides: ['calendar'],
    fields: [],
    planned: true,
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'data',
    tagline: 'Kontakte und Deals übernehmen',
    provides: ['import'],
    fields: [],
    planned: true,
  },
];

export const CONNECTOR_BY_ID = Object.fromEntries(CONNECTORS.map((c) => [c.id, c])) as Record<string, ConnectorDef>;

export const AI_PROVIDERS = CONNECTORS.filter((c) => c.provides.includes('agents')).map((c) => c.id);

/** Berechtigungen für KI-Assistenten (ChatGPT, Claude, …) über MCP */
export const MCP_SCOPES = {
  'sales:read': 'Kontakte, Aufgaben, Läufe und Kennzahlen lesen',
  'sales:write': 'Kontakte anlegen/ergänzen, Aufgaben und Notizen erstellen, Agentenläufe starten',
} as const;
export type McpScope = keyof typeof MCP_SCOPES;
