import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from backend root
dotenv.config({ path: path.join(process.cwd(), '.env') });

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  FRED_API_KEY: process.env.FRED_API_KEY || '',
  AISSTREAM_API_KEY: process.env.AISSTREAM_API_KEY || '',
  OPENSKY_USERNAME: process.env.OPENSKY_USERNAME || '',
  OPENSKY_PASSWORD: process.env.OPENSKY_PASSWORD || '',
  SYNC_INTERVAL_SEC: 30, // Composite score refresh interval in seconds
};

export const SECTOR_REGISTRY = [
  { code: 'HZ', name: 'Strait of Hormuz', lat: 26.6, lon: 56.3, baseRisk: 45 },
  { code: 'BM', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseRisk: 50 },
  { code: 'TS', name: 'Taiwan Strait', lat: 24.4, lon: 119.5, baseRisk: 40 },
  { code: 'SC', name: 'South China Sea', lat: 12.0, lon: 113.0, baseRisk: 35 },
  { code: 'UK', name: 'Ukraine Frontier', lat: 48.3, lon: 38.0, baseRisk: 65 },
  { code: 'KP', name: 'Korean Peninsula', lat: 37.9, lon: 126.7, baseRisk: 30 },
  { code: 'KB', name: 'Kashmir Border', lat: 34.2, lon: 74.5, baseRisk: 48 },
  { code: 'IG', name: 'Israel-Gaza Border', lat: 31.5, lon: 34.4, baseRisk: 70 },
];
