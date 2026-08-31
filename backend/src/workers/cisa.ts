import { SECTOR_REGISTRY } from '../config.js';
import { saveTelemetry, saveLog, updateIndicatorLiveStatus } from '../db.js';

export async function ingestCISA() {
  console.log('[CISA] Starting CISA cyber advisory ingestion worker...');
  try {
    // CISA public advisories XML feed
    const url = 'https://www.cisa.gov/cybersecurity-advisories/all.xml';
    console.log('[CISA] Fetching advisories RSS...');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error fetching CISA RSS: ${response.statusText}`);
    }
    
    const xmlText = await response.text();
    
    // Simple XML item parsing using regex (no heavy XML dependency)
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    const items: { title: string; description: string; pubDate: string }[] = [];
    
    while ((match = itemRegex.exec(xmlText)) !== null) {
      const itemContent = match[1];
      const title = (itemContent.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
      const description = (itemContent.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').trim();
      const pubDate = (itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
      items.push({ title, description, pubDate });
    }

    console.log(`[CISA] Parsed ${items.length} cyber advisories. Scoring sectors based on keyword matching...`);

    const now = new Date().toISOString();
    
    // Keywords representing threat activity for each sector
    const sectorKeywords: Record<string, string[]> = {
      HZ: ['iran', 'gulf', 'hormuz', 'middle east', 'tehran'],
      BM: ['yemen', 'houthi', 'red sea', 'bab el-mandeb', 'somali'],
      TS: ['taiwan', 'china', 'chinese', 'taipei'],
      SC: ['china', 'philippines', 'vietnam', 'spratly', 'south china sea'],
      UK: ['russia', 'russian', 'ukraine', 'ukrainian', 'belarus', 'sandworm', 'fancy bear'],
      KP: ['north korea', 'korean', 'pyongyang', 'lazarus', 'kimsuky'],
      KB: ['india', 'pakistan', 'kashmir'],
      IG: ['hamas', 'israel', 'gaza', 'hezbollah', 'lebanon', 'iran', 'palestinian']
    };

    for (const s of SECTOR_REGISTRY) {
      const keywords = sectorKeywords[s.code] || [];
      let matchCount = 0;
      let matchedAdvisory: string | null = null;
      
      for (const item of items) {
        const textToSearch = `${item.title} ${item.description}`.toLowerCase();
        const hasKeyword = keywords.some(kw => textToSearch.includes(kw));
        if (hasKeyword) {
          matchCount++;
          if (!matchedAdvisory) {
            matchedAdvisory = `CISA Alert: ${item.title}`;
          }
        }
      }

      // Calculate a cyber intensity score (e.g. index scale of 0-100 based on matches)
      const cyberScore = Math.min(matchCount * 15, 100);
      console.log(`[CISA] Sector ${s.code} -> Cyber score: ${cyberScore} (${matchCount} alerts matched)`);
      
      saveTelemetry(s.code, 'cyb_cisa_alerts', cyberScore, cyberScore, now);
      
      if (matchCount > 0 && matchedAdvisory) {
        saveLog('cyb', `${matchedAdvisory} (Impacts ${s.name})`, now);
      }
    }

    updateIndicatorLiveStatus('cyb_cisa_alerts', true);
    console.log('[CISA] Cyber ingestion complete.');
  } catch (error) {
    console.error('[CISA] Ingestion error:', error);
  }
}
