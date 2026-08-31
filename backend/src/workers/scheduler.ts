import { ingestGDELT } from './gdelt.js';
import { ingestUCDP } from './ucdp.js';
import { ingestFRED } from './fred.js';
import { ingestOpenSky } from './opensky.js';
import { ingestCISA } from './cisa.js';
import { ingestAIS } from './ais.js';

export async function runAllWorkersOnStartup() {
  console.log('[Scheduler] Executing startup ingestion wave...');
  
  // Run fast checks
  await ingestAIS();
  await ingestFRED();
  
  // Run GDELT, CISA, OpenSky and UCDP
  // We run them in sequence on startup to populate SQLite db, with error catching
  try {
    await ingestGDELT();
  } catch (e) {
    console.error('Startup GDELT worker failed:', e);
  }
  
  try {
    await ingestCISA();
  } catch (e) {
    console.error('Startup CISA worker failed:', e);
  }

  try {
    await ingestOpenSky();
  } catch (e) {
    console.error('Startup OpenSky worker failed:', e);
  }

  try {
    await ingestUCDP();
  } catch (e) {
    console.error('Startup UCDP worker failed:', e);
  }
}

export function startScheduler() {
  console.log('[Scheduler] Starting background cron schedule loops...');
  
  // OpenSky: every 5 minutes
  setInterval(async () => {
    try {
      await ingestOpenSky();
    } catch (e) {
      console.error('[Scheduler] Error in OpenSky interval:', e);
    }
  }, 5 * 60 * 1000);

  // GDELT & FRED VIX: every 15 minutes
  setInterval(async () => {
    try {
      await ingestGDELT();
      await ingestFRED();
    } catch (e) {
      console.error('[Scheduler] Error in GDELT/FRED interval:', e);
    }
  }, 15 * 60 * 1000);

  // CISA alerts: every hour
  setInterval(async () => {
    try {
      await ingestCISA();
    } catch (e) {
      console.error('[Scheduler] Error in CISA interval:', e);
    }
  }, 60 * 60 * 1000);

  // UCDP Candidate stream: every 24 hours
  setInterval(async () => {
    try {
      await ingestUCDP();
    } catch (e) {
      console.error('[Scheduler] Error in UCDP interval:', e);
    }
  }, 24 * 60 * 60 * 1000);
}
