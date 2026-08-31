import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as readline from 'readline';
import { SECTOR_REGISTRY } from '../config.js';
import { saveTelemetry, saveLog } from '../db.js';

const TEMP_DIR = path.join(process.cwd(), 'temp');
const EXTRACTED_DIR = path.join(TEMP_DIR, 'extracted');

// Helper: Calculate distance between two coordinates in km using simple equirectangular projection
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // km
  const x = (lon2 - lon1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R;
}

export async function ingestGDELT() {
  console.log('[GDELT] Starting ingestion worker...');
  try {
    // 1. Create temp dirs
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    if (!fs.existsSync(EXTRACTED_DIR)) fs.mkdirSync(EXTRACTED_DIR, { recursive: true });

    // Clear previous extractions to save space
    const oldFiles = fs.readdirSync(EXTRACTED_DIR);
    for (const f of oldFiles) {
      fs.unlinkSync(path.join(EXTRACTED_DIR, f));
    }

    // 2. Fetch lastupdate.txt
    console.log('[GDELT] Fetching latest manifest...');
    const response = await fetch('http://data.gdeltproject.org/gdeltv2/lastupdate.txt');
    if (!response.ok) throw new Error(`HTTP error fetching manifest: ${response.statusText}`);
    const text = await response.text();
    
    // Line 0 is the export CSV ZIP
    const exportLine = text.split('\n')[0];
    if (!exportLine) throw new Error('Empty GDELT lastupdate manifest');
    
    const parts = exportLine.trim().split(' ');
    const zipUrl = parts[2];
    if (!zipUrl) throw new Error(`Could not find ZIP URL in GDELT manifest: ${exportLine}`);
    
    const zipFilename = path.basename(zipUrl);
    const zipPath = path.join(TEMP_DIR, zipFilename);
    
    console.log(`[GDELT] Downloading latest export file: ${zipFilename}`);
    const zipResponse = await fetch(zipUrl);
    if (!zipResponse.ok) throw new Error(`HTTP error downloading ZIP: ${zipResponse.statusText}`);
    
    const buffer = await zipResponse.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(buffer));
    
    // 3. Extract ZIP using PowerShell (robust Windows native unzipping)
    console.log('[GDELT] Extracting ZIP package...');
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${EXTRACTED_DIR}' -Force"`);
    
    // Clean up zip archive
    fs.unlinkSync(zipPath);

    // Find the extracted CSV file
    const files = fs.readdirSync(EXTRACTED_DIR);
    const csvFile = files.find(f => f.endsWith('.CSV') || f.endsWith('.csv'));
    if (!csvFile) throw new Error('No CSV file found in GDELT ZIP package');
    
    const csvPath = path.join(EXTRACTED_DIR, csvFile);
    console.log(`[GDELT] Parsing extracted events from: ${csvFile}`);
    
    // 4. Parse CSV line by line
    const fileStream = fs.createReadStream(csvPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    // Initialize accumulators per sector
    const sectorStats: Record<string, {
      conflictEvents: number;
      goldsteinSum: number;
      goldsteinCount: number;
      toneSum: number;
      toneCount: number;
      allEventsCount: number;
      sampleMsg: string | null;
    }> = {};

    for (const s of SECTOR_REGISTRY) {
      sectorStats[s.code] = {
        conflictEvents: 0,
        goldsteinSum: 0,
        goldsteinCount: 0,
        toneSum: 0,
        toneCount: 0,
        allEventsCount: 0,
        sampleMsg: null
      };
    }

    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length < 58) continue; // Incomplete line
      
      const eventCode = cols[26] || '';
      const goldsteinStr = cols[29];
      const avgToneStr = cols[34];
      const latStr = cols[56];
      const lonStr = cols[57];
      const sourceUrl = cols[60] || 'Open Source Media';
      
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      const goldstein = parseFloat(goldsteinStr);
      const avgTone = parseFloat(avgToneStr);
      
      if (isNaN(lat) || isNaN(lon)) continue;

      // Find closest sector within 250km
      for (const s of SECTOR_REGISTRY) {
        const dist = calculateDistance(lat, lon, s.lat, s.lon);
        if (dist <= 250) {
          const stats = sectorStats[s.code];
          stats.allEventsCount++;
          
          if (!isNaN(goldstein)) {
            stats.goldsteinSum += goldstein;
            stats.goldsteinCount++;
          }
          if (!isNaN(avgTone)) {
            stats.toneSum += avgTone;
            stats.toneCount++;
          }

          // Check if it is a conflict event (CAMEO root codes 10 to 20)
          const rootCode = eventCode.substring(0, 2);
          const isConflict = /^(1[0-9]|20)/.test(rootCode);
          if (isConflict) {
            stats.conflictEvents++;
            
            // Set a log sample message if we don't have one yet
            if (!stats.sampleMsg) {
              const domainLabel = rootCode.startsWith('19') || rootCode.startsWith('20') ? 'Military action' : 'Civil/diplomatic tension';
              stats.sampleMsg = `${domainLabel} flagged near ${s.name}: Event ${eventCode} (Goldstein ${goldsteinStr}) - Src: ${new URL(sourceUrl).hostname || 'OSINT'}`;
            }
          }
        }
      }
    }

    console.log('[GDELT] Event parsing completed. Saving stats to DB...');
    
    // Save to Database
    const now = new Date().toISOString();
    for (const s of SECTOR_REGISTRY) {
      const stats = sectorStats[s.code];
      const avgGoldstein = stats.goldsteinCount > 0 ? stats.goldsteinSum / stats.goldsteinCount : 0;
      const avgTone = stats.toneCount > 0 ? stats.toneSum / stats.toneCount : 0;
      
      // Save metrics
      saveTelemetry(s.code, 'mil_gdelt_goldstein', avgGoldstein, avgGoldstein, now);
      saveTelemetry(s.code, 'mil_gdelt_volume', stats.conflictEvents, stats.conflictEvents, now);
      saveTelemetry(s.code, 'osi_media_tone', avgTone, avgTone, now);
      
      // Save log entry if a conflict was detected
      if (stats.conflictEvents > 0 && stats.sampleMsg) {
        saveLog('mil', stats.sampleMsg, now);
      }
    }
    
    console.log('[GDELT] Ingestion finished successfully.');
    
    // Clean up CSV file
    fs.unlinkSync(csvPath);
  } catch (error) {
    console.error('[GDELT] Worker error:', error);
  }
}
