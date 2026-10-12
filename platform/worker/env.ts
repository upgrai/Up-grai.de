import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { LeadPipelineParams } from './workflows/lead-pipeline';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  LEAD_PIPELINE: Workflow<LeadPipelineParams>;
  OAUTH_PROVIDER: OAuthHelpers;

  ENVIRONMENT: string;
  PUBLIC_URL: string;
  DEV_USER_EMAIL?: string;
  OWNER_EMAILS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  ENCRYPTION_KEY: string;
  CONSENT_SECRET: string;
}

/** Wer handelt: Mensch in der Oberfläche, KI-Assistent über MCP, Workflow oder Webhook */
export interface Actor {
  email: string;
  via: 'ui' | 'mcp' | 'workflow' | 'webhook';
  scopes?: string[];
}
