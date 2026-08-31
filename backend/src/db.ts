// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB_PATH = path.join(process.cwd(), 'argus9.db');
const SCHEMA_PATH = path.join(process.cwd(), 'src', 'schema.sql');

export const db = new DatabaseSync(DB_PATH);

export function initDb() {
  console.log(`[DB] Initializing database at ${DB_PATH}`);
  
  // Read and run schema.sql
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  
  // Seed Entities if empty
  const entityCountRow = db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number };
  if (entityCountRow.count === 0) {
    console.log('[DB] Seeding default entities (Tier-1 Registry)');
    const insertEntity = db.prepare(`
      INSERT INTO entities (code, name, latitude, longitude, base_risk)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const SECTORS_SEED = [
      { code: 'HZ', name: 'Strait of Hormuz', lat: 26.6, lon: 56.3, baseRisk: 45 },
      { code: 'BM', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseRisk: 50 },
      { code: 'TS', name: 'Taiwan Strait', lat: 24.4, lon: 119.5, baseRisk: 40 },
      { code: 'SC', name: 'South China Sea', lat: 12.0, lon: 113.0, baseRisk: 35 },
      { code: 'UK', name: 'Ukraine Frontier', lat: 48.3, lon: 38.0, baseRisk: 65 },
      { code: 'KP', name: 'Korean Peninsula', lat: 37.9, lon: 126.7, baseRisk: 30 },
      { code: 'KB', name: 'Kashmir Border', lat: 34.2, lon: 74.5, baseRisk: 48 },
      { code: 'IG', name: 'Israel-Gaza Border', lat: 31.5, lon: 34.4, baseRisk: 70 },
    ];
    
    for (const s of SECTORS_SEED) {
      insertEntity.run(s.code, s.name, s.lat, s.lon, s.baseRisk);
    }
  }
  
  // Seed Indicators if empty
  const indicatorCountRow = db.prepare('SELECT COUNT(*) as count FROM indicators').get() as { count: number };
  if (indicatorCountRow.count === 0) {
    console.log('[DB] Seeding default indicators');
    const insertIndicator = db.prepare(`
      INSERT INTO indicators (id, domain, label, unit, refresh_cadence, is_live)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const INDICATORS_SEED = [
      { id: 'mil_gdelt_goldstein', domain: 'mil', label: 'MILITARY / OSINT', unit: 'GOLDSTEIN', cadence: 900, isLive: 1 },
      { id: 'mil_gdelt_volume', domain: 'mil', label: 'MILITARY / OSINT', unit: '/15M', cadence: 900, isLive: 1 },
      { id: 'avi_opensky_flights', domain: 'avi', label: 'AVIATION', unit: 'ACTIVE', cadence: 300, isLive: 1 },
      { id: 'avi_opensky_dev', domain: 'avi', label: 'AVIATION', unit: '% DEV', cadence: 300, isLive: 1 },
      { id: 'mkt_fred_vix', domain: 'mkt', label: 'MARKETS', unit: 'IDX', cadence: 900, isLive: 0 }, // Requires key
      { id: 'mar_ais_anom', domain: 'mar', label: 'MARITIME', unit: '% BASE', cadence: 900, isLive: 0 }, // Requires key
      { id: 'dip_news_advisory', domain: 'dip', label: 'DIPLOMATIC', unit: 'ACTIVE', cadence: 3600, isLive: 1 },
      { id: 'cyb_cisa_alerts', domain: 'cyb', label: 'CYBER', unit: 'INDEX', cadence: 3600, isLive: 1 },
      { id: 'osi_media_tone', domain: 'osi', label: 'OSINT / MEDIA', unit: 'σ', cadence: 900, isLive: 1 },
    ];
    
    for (const ind of INDICATORS_SEED) {
      insertIndicator.run(ind.id, ind.domain, ind.label, ind.unit, ind.cadence, ind.isLive);
    }
  }
}

// Telemetry operations
export function saveTelemetry(entityCode: string, indicatorId: string, rawVal: number, normVal: number, timestamp = new Date().toISOString()) {
  const insert = db.prepare(`
    INSERT INTO telemetry (entity_code, indicator_id, raw_value, normalized_value, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run(entityCode, indicatorId, rawVal, normVal, timestamp);
}

export function getTelemetryHistory(entityCode: string, indicatorId: string, limit = 16): { raw_value: number; normalized_value: number; timestamp: string }[] {
  const query = db.prepare(`
    SELECT raw_value, normalized_value, timestamp FROM telemetry
    WHERE entity_code = ? AND indicator_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `);
  const rows = query.all(entityCode, indicatorId, limit) as { raw_value: number; normalized_value: number; timestamp: string }[];
  return rows.reverse(); // returns in chronological order
}

export function updateIndicatorLiveStatus(id: string, isLive: boolean) {
  db.prepare('UPDATE indicators SET is_live = ? WHERE id = ?').run(isLive ? 1 : 0, id);
}

// Composite scores operations
export function saveCompositeScore(entityCode: string, score: number, timestamp = new Date().toISOString()) {
  db.prepare('INSERT INTO composite_scores (entity_code, score, timestamp) VALUES (?, ?, ?)').run(entityCode, score, timestamp);
}

export function getLatestCompositeScore(entityCode: string): { score: number; timestamp: string } | null {
  const row = db.prepare('SELECT score, timestamp FROM composite_scores WHERE entity_code = ? ORDER BY timestamp DESC LIMIT 1').get(entityCode) as { score: number; timestamp: string } | undefined;
  return row || null;
}

export function getCompositeScoreHistory(entityCode: string, limit = 16): { score: number; timestamp: string }[] {
  const rows = db.prepare('SELECT score, timestamp FROM composite_scores WHERE entity_code = ? ORDER BY timestamp DESC LIMIT ?').all(entityCode, limit) as { score: number; timestamp: string }[];
  return rows.reverse();
}

// Logs operations
export function saveLog(domainId: string, message: string, timestamp = new Date().toISOString()) {
  db.prepare('INSERT INTO logs (timestamp, domain_id, message) VALUES (?, ?, ?)').run(timestamp, domainId, message);
}

export function getLatestLogs(limit = 20): { timestamp: string; domain_id: string; message: string }[] {
  return db.prepare('SELECT timestamp, domain_id, message FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit) as { timestamp: string; domain_id: string; message: string }[];
}

// Briefs operations
export function saveBrief(id: string, tag: string, headline: string, body: string, refSectorCode: string, compositeScore: number, timestamp = new Date().toISOString()) {
  db.prepare(`
    INSERT OR REPLACE INTO briefs (id, tag, timestamp, headline, body, ref_sector_code, composite_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tag, timestamp, headline, body, refSectorCode, compositeScore);
}

export function getLatestBriefs(limit = 12): { id: string; tag: string; timestamp: string; headline: string; body: string; ref_sector_code: string; composite_score: number }[] {
  return db.prepare(`
    SELECT id, tag, timestamp, headline, body, ref_sector_code, composite_score FROM briefs
    ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as { id: string; tag: string; timestamp: string; headline: string; body: string; ref_sector_code: string; composite_score: number }[];
}

// Entity list
export function getEntities(): { code: string; name: string; latitude: number; longitude: number; base_risk: number }[] {
  return db.prepare('SELECT code, name, latitude, longitude, base_risk FROM entities').all() as { code: string; name: string; latitude: number; longitude: number; base_risk: number }[];
}

// Indicators list
export function getIndicators(): { id: string; domain: string; label: string; unit: string; refresh_cadence: number; is_live: number }[] {
  return db.prepare('SELECT id, domain, label, unit, refresh_cadence, is_live FROM indicators').all() as { id: string; domain: string; label: string; unit: string; refresh_cadence: number; is_live: number }[];
}
