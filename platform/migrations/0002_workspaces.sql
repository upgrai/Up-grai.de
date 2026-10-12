-- Vorkonfigurierte Arbeitsbereiche. Preise bleiben leer, bis sie freigegeben sind:
-- Agenten nennen ohne hinterlegte Preise keine Beträge.

INSERT INTO workspaces (id, slug, name, legal_name, description, accent) VALUES
  ('ws_upgrai', 'upgrai', 'UPGRAI', 'UPGRAI', 'Websites, Relaunches und digitale Sichtbarkeit für Unternehmen', 'cyan'),
  ('ws_hermann', 'hermann-living', 'Hermann Living', 'Hermann Living', 'Verwaltung von Ferien- und Kurzzeitunterkünften', 'amber');

INSERT INTO offers (id, workspace_id, name, description, services, goal) VALUES
  ('off_upgrai_web', 'ws_upgrai', 'Websites & Relaunch',
   'Neue Website oder Relaunch einer bestehenden Website',
   '- Konzept, Design und Umsetzung\n- Texte und Bildauswahl\n- Mobile Optimierung\n- Kontakt- und Anfrageformulare',
   'Beratungsgespräch und Website-Auftrag'),
  ('off_upgrai_legacy', 'ws_upgrai', 'Altbestand (Zuordnung offen)',
   'Bestandskontakte ohne geklärte Angebotszuordnung. Keine automatische Kampagne.',
   '', 'Zuordnung klären'),
  ('off_hermann_mgmt', 'ws_hermann', 'Unterkunftsverwaltung',
   'Verwaltung von Ferien- und Kurzzeitunterkünften für Eigentümer und Betreiber',
   '- Gästekommunikation\n- Buchungs- und Kalenderpflege\n- Reinigung und Übergaben koordinieren',
   'Beratungsgespräch und Verwaltungsmandat');

UPDATE offers SET is_active = 0 WHERE id = 'off_upgrai_legacy';

INSERT INTO audiences (id, workspace_id, offer_id, name, description, criteria, default_party_type) VALUES
  ('aud_up_gastro', 'ws_upgrai', 'off_upgrai_web', 'Gastronomie', 'Restaurants, Cafés, Bars',
   '["Website-Zustand","Online-Reservierung","Anfragen pro Monat","Entscheider bekannt"]', 'business'),
  ('aud_up_stay', 'ws_upgrai', 'off_upgrai_web', 'Unterkünfte', 'Hotels, Pensionen, Ferienanlagen',
   '["Website-Zustand","Direktbuchung","Anteil Portalbuchungen","Entscheider bekannt"]', 'business'),
  ('aud_up_craft', 'ws_upgrai', 'off_upgrai_web', 'Handwerk', 'Handwerksbetriebe',
   '["Website-Zustand","Anfragen pro Monat","Personalsuche","Entscheider bekannt"]', 'business'),
  ('aud_up_services', 'ws_upgrai', 'off_upgrai_web', 'Dienstleistungen', 'Praxen, Kanzleien, Agenturen, Studios',
   '["Website-Zustand","Terminbuchung","Bedarf","Entscheider bekannt"]', 'business'),
  ('aud_up_legacy', 'ws_upgrai', 'off_upgrai_legacy', 'Altbestand', 'Importierte Bestandskontakte', '[]', 'unknown'),
  ('aud_hl_single', 'ws_hermann', 'off_hermann_mgmt', 'Einzelobjekte', 'Eigentümer einer Ferienwohnung',
   '["Objektstandort","Aktuelle Verwaltung","Belegung","Leistungsbedarf","Entscheider"]', 'consumer'),
  ('aud_hl_multi', 'ws_hermann', 'off_hermann_mgmt', 'Mehrere Unterkünfte', 'Betreiber mehrerer Ferienwohnungen',
   '["Anzahl Objekte","Standorte","Aktuelle Verwaltung","Leistungsbedarf","Entscheider"]', 'unknown'),
  ('aud_hl_commercial', 'ws_hermann', 'off_hermann_mgmt', 'Gewerbliche Betreiber', 'Gewerbliche Anbieter von Kurzzeitunterkünften',
   '["Anzahl Objekte","Standorte","Software im Einsatz","Leistungsbedarf","Entscheider"]', 'business');
