import { CONFIG, SECTOR_REGISTRY } from '../config.js';
import { saveTelemetry, updateIndicatorLiveStatus, saveLog, getTelemetryHistory } from '../db.js';

export async function ingestOpenSky() {
  console.log('[OpenSky] Starting ingestion worker...');
  
  const headers: Record<string, string> = {};
  if (CONFIG.OPENSKY_USERNAME && CONFIG.OPENSKY_PASSWORD) {
    const auth = Buffer.from(`${CONFIG.OPENSKY_USERNAME}:${CONFIG.OPENSKY_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${auth}`;
  }

  const now = new Date().toISOString();

  for (const s of SECTOR_REGISTRY) {
    try {
      // 3-degree bounding box around the center coordinate
      const lamin = s.lat - 1.5;
      const lomin = s.lon - 1.5;
      const lamax = s.lat + 1.5;
      const lomax = s.lon + 1.5;
      
      const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
      console.log(`[OpenSky] Querying flights for Sector ${s.code} (${s.name})...`);
      
      const response = await fetch(url, { headers });
      if (!response.ok) {
        if (response.status === 429) {
          console.warn('[OpenSky] Rate limited (429). Skipping this cycle.');
          break; // Stop querying other sectors to avoid spamming
        }
        throw new Error(`HTTP error: ${response.statusText}`);
      }

      const data = await response.json() as {
        time: number;
        states: any[][] | null;
      };

      const flightCount = data.states ? data.states.length : 0;
      
      // Calculate deviation from average of historic counts (default to baseline of 10 flights)
      const history = getTelemetryHistory(s.code, 'avi_opensky_flights', 15);
      const values = history.map(h => h.raw_value).filter(v => v !== null);
      
      const avgHistory = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 10;
      // % Deviation
      const percentDev = avgHistory > 0 ? ((flightCount - avgHistory) / avgHistory) * 100 : 0;
      
      console.log(`[OpenSky] Sector ${s.code} -> Flights: ${flightCount}, Deviation: ${percentDev.toFixed(1)}%`);

      saveTelemetry(s.code, 'avi_opensky_flights', flightCount, flightCount, now);
      saveTelemetry(s.code, 'avi_opensky_dev', percentDev, percentDev, now);

      updateIndicatorLiveStatus('avi_opensky_flights', true);
      updateIndicatorLiveStatus('avi_opensky_dev', true);

      // Save a log message if flight deviation is significant (e.g. airspace closure / flight drop)
      if (percentDev < -40 && flightCount < 5) {
        saveLog('avi', `Airspace thinning detected in ${s.name}: Flights down ${Math.abs(percentDev).toFixed(0)}% vs baseline`, now);
      }
    } catch (error) {
      console.error(`[OpenSky] Error ingesting Sector ${s.code}:`, error);
      // We don't mark as not live immediately for single failures, but report to logs
    }
    
    // Slow down requests to avoid OpenSky open API rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('[OpenSky] Ingestion complete.');
}
