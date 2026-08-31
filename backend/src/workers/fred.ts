import { CONFIG, SECTOR_REGISTRY } from '../config.js';
import { saveTelemetry, updateIndicatorLiveStatus, saveLog } from '../db.js';

export async function ingestFRED() {
  console.log('[FRED] Starting ingestion worker...');
  if (!CONFIG.FRED_API_KEY) {
    console.log('[FRED] No FRED_API_KEY configured. Disabling live FRED feed.');
    updateIndicatorLiveStatus('mkt_fred_vix', false);
    return;
  }

  try {
    updateIndicatorLiveStatus('mkt_fred_vix', true);
    
    // Series VIXCLS is the CBOE Volatility Index
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${CONFIG.FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
    console.log('[FRED] Querying VIX data...');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error fetching VIX: ${response.statusText}`);
    }

    const data = await response.json() as {
      observations?: {
        value: string;
        date: string;
      }[];
    };

    const latestObs = data.observations?.[0];
    if (!latestObs) {
      throw new Error('No observations found in FRED response');
    }

    const vixValue = parseFloat(latestObs.value);
    if (isNaN(vixValue)) {
      console.log(`[FRED] VIX value is non-numeric (e.g. holiday): ${latestObs.value}`);
      return;
    }

    console.log(`[FRED] Retreived VIX level: ${vixValue} (date: ${latestObs.date})`);
    
    const now = new Date().toISOString();
    // Since VIX is global, we log it for ALL sectors in our registry under Markets
    for (const s of SECTOR_REGISTRY) {
      saveTelemetry(s.code, 'mkt_fred_vix', vixValue, vixValue, now);
    }
    
    saveLog('mkt', `Global market risk index (VIX) retrieved: ${vixValue.toFixed(2)}`, now);
    console.log('[FRED] Ingestion complete.');
  } catch (error) {
    console.error('[FRED] Ingestion error:', error);
  }
}
