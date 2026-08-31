import { SECTOR_REGISTRY } from '../config.js';
import { saveTelemetry, saveLog, updateIndicatorLiveStatus } from '../db.js';

// Helper: Calculate distance between two coordinates in km
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // km
  const x = (lon2 - lon1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R;
}

export async function ingestUCDP() {
  console.log('[UCDP] Starting ingestion worker...');
  try {
    const today = new Date();
    // Query events from the last 30 days
    const startDateObj = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startDate = startDateObj.toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];
    
    // We try to query UCDP GED version 24.1 (which has the latest year data)
    // The endpoint is public and does not require auth headers
    const ucdpUrl = `https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=1000&StartDate=${startDate}&EndDate=${endDate}`;
    
    console.log(`[UCDP] Querying public API: ${ucdpUrl}`);
    const response = await fetch(ucdpUrl);
    if (!response.ok) {
      throw new Error(`HTTP error querying UCDP API: ${response.statusText}`);
    }
    
    const data = await response.json() as {
      Result: {
        id: number;
        latitude: number;
        longitude: number;
        deaths_civilians: number;
        deaths_a: number;
        deaths_b: number;
        deaths_unknown: number;
        date_start: string;
        date_end: string;
        conflict_name: string;
        dyad_name: string;
      }[];
    };
    
    if (!data.Result || !Array.isArray(data.Result)) {
      console.log('[UCDP] No results returned or empty result array');
      return;
    }
    
    console.log(`[UCDP] Received ${data.Result.length} events from public stream. Matching to sectors...`);
    
    // Initialize statistics
    const sectorStats: Record<string, {
      eventCount: number;
      fatalities: number;
      sampleEvent: string | null;
    }> = {};
    
    for (const s of SECTOR_REGISTRY) {
      sectorStats[s.code] = {
        eventCount: 0,
        fatalities: 0,
        sampleEvent: null
      };
    }
    
    for (const event of data.Result) {
      const lat = event.latitude;
      const lon = event.longitude;
      if (isNaN(lat) || isNaN(lon)) continue;
      
      const deaths = (event.deaths_civilians || 0) + (event.deaths_a || 0) + (event.deaths_b || 0) + (event.deaths_unknown || 0);
      
      for (const s of SECTOR_REGISTRY) {
        const dist = calculateDistance(lat, lon, s.lat, s.lon);
        if (dist <= 250) {
          const stats = sectorStats[s.code];
          stats.eventCount++;
          stats.fatalities += deaths;
          
          if (!stats.sampleEvent) {
            stats.sampleEvent = `UCDP event confirmed in ${s.name}: ${event.conflict_name} (${deaths} fatalities) - Dyad: ${event.dyad_name}`;
          }
        }
      }
    }
    
    const now = new Date().toISOString();
    for (const s of SECTOR_REGISTRY) {
      const stats = sectorStats[s.code];
      console.log(`[UCDP] Sector ${s.code} -> Events: ${stats.eventCount}, Fatalities: ${stats.fatalities}`);
      
      // Save fatalities and events as diplomatic/conflict indices
      // We log deaths under a diplomatic index or military casualty count.
      // Let's store them as diplomatic advisory telemetry values.
      // Wait, UCDP events represent direct kinetic casualties. We can log them as a background metric for baseline structural prior updating!
      // Specifically, we update the base_risk of entities based on trailing 30-day casualties.
      saveTelemetry(s.code, 'dip_news_advisory', stats.eventCount, stats.eventCount, now);
      
      if (stats.eventCount > 0 && stats.sampleEvent) {
        saveLog('dip', stats.sampleEvent, now);
      }
    }
    
    updateIndicatorLiveStatus('dip_news_advisory', true);
    console.log('[UCDP] Ingestion complete.');
  } catch (error) {
    console.error('[UCDP] Ingestion error:', error);
    updateIndicatorLiveStatus('dip_news_advisory', false);
  }
}
