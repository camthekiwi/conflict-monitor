import { getEntities, getIndicators, getTelemetryHistory, saveCompositeScore, getLatestCompositeScore } from './db.js';

export interface DomainScore {
  id: string;
  label: string;
  value: number;
  isLive: boolean;
}

// Normalized metrics mapping: convert raw telemetry to 0-100 scale
export function normalizeIndicator(indicatorId: string, rawVal: number): number {
  switch (indicatorId) {
    case 'mil_gdelt_goldstein':
      // Goldstein scale: -10 (extreme conflict) to +10 (extreme cooperation)
      // We map -10 to 100, +10 to 0
      return Math.max(0, Math.min(100, (1 - (rawVal + 10) / 20) * 100));

    case 'mil_gdelt_volume':
      // Event volume: 0 to 50+ events in a 15-min window is a strong spike
      return Math.max(0, Math.min(100, (rawVal / 40) * 100));

    case 'avi_opensky_flights':
      // Raw flights count. Not directly mapped as risk, we use deviation.
      return 0;

    case 'avi_opensky_dev':
      // Flight count deviation: negative deviation (fewer flights) indicates flight cancellations/risks
      // -50% deviation maps to 75% risk, -66% maps to 100% risk
      return rawVal < 0 ? Math.max(0, Math.min(100, Math.abs(rawVal) * 1.5)) : 0;

    case 'mkt_fred_vix':
      // VIX: typical range 12 to 50. Map 12 to 0, 50 to 100
      return Math.max(0, Math.min(100, ((rawVal - 12) / 38) * 100));

    case 'mar_ais_anom':
      // Maritime AIS transit deviation. Negative deviation (fewer transits) indicates shipping lane closure/risk
      return rawVal < 0 ? Math.max(0, Math.min(100, Math.abs(rawVal) * 1.5)) : 0;

    case 'dip_news_advisory':
      // Diplomatic news events count: 0 to 10 events. Map 0 to 0, 8 to 100
      return Math.max(0, Math.min(100, (rawVal / 8) * 100));

    case 'cyb_cisa_alerts':
      // Cyber alerts score: already normalized 0 to 100 based on matching keyword frequency
      return Math.max(0, Math.min(100, rawVal));

    case 'osi_media_tone':
      // Average tone of articles: range -10 (negative/war) to +10 (positive/peace)
      // We map -6 (or worse) to 100, +6 to 0
      return Math.max(0, Math.min(100, (1 - (rawVal + 6) / 12) * 100));

    default:
      return 0;
  }
}

export function computeCompositeRisk() {
  console.log('[Scoring] Running risk-scoring engine v1.0.0...');
  
  const entities = getEntities();
  const indicators = getIndicators();
  const now = new Date().toISOString();

  // Domain configuration weights
  const defaultWeights: Record<string, number> = {
    mil: 0.30,
    cyb: 0.15,
    avi: 0.10,
    mar: 0.15,
    mkt: 0.10,
    dip: 0.10,
    osi: 0.10
  };

  for (const ent of entities) {
    const domainScores: Record<string, { sum: number; count: number; isLive: boolean; label: string }> = {
      mil: { sum: 0, count: 0, isLive: false, label: 'MILITARY / OSINT' },
      avi: { sum: 0, count: 0, isLive: false, label: 'AVIATION' },
      mar: { sum: 0, count: 0, isLive: false, label: 'MARITIME' },
      mkt: { sum: 0, count: 0, isLive: false, label: 'MARKETS' },
      dip: { sum: 0, count: 0, isLive: false, label: 'DIPLOMATIC' },
      cyb: { sum: 0, count: 0, isLive: false, label: 'CYBER' },
      osi: { sum: 0, count: 0, isLive: false, label: 'OSINT / MEDIA' }
    };

    // Calculate domain scores from telemetry
    for (const ind of indicators) {
      const history = getTelemetryHistory(ent.code, ind.id, 1);
      const latestTelemetry = history[0];
      const isLive = ind.is_live === 1;

      if (isLive && latestTelemetry) {
        const normVal = normalizeIndicator(ind.id, latestTelemetry.raw_value);
        
        // We skip raw flights count for risk average, only use deviation
        if (ind.id === 'avi_opensky_flights') continue;

        const dInfo = domainScores[ind.domain];
        if (dInfo) {
          dInfo.sum += normVal;
          dInfo.count++;
          dInfo.isLive = true;
        }
      }
    }

    // Compile active domain values
    let activeEventSum = 0;
    let activeWeightSum = 0;
    let spikedDomainsCount = 0;

    for (const domId in domainScores) {
      const dom = domainScores[domId];
      if (dom.isLive && dom.count > 0) {
        const domAvg = dom.sum / dom.count;
        const weight = defaultWeights[domId] || 0.1;
        
        activeEventSum += domAvg * weight;
        activeWeightSum += weight;

        if (domAvg > 50) {
          spikedDomainsCount++;
        }
      }
    }

    // Weighted average of live event/behavioral layers
    let eventScore = activeWeightSum > 0 ? activeEventSum / activeWeightSum : 0;

    // Synergy/Clustering Penalty: if 3 or more domains are spiked, amplify the score
    if (spikedDomainsCount >= 3) {
      const multiplier = 1.0 + (spikedDomainsCount - 2) * 0.125; // 3 domains -> 1.125x, 4 domains -> 1.25x
      eventScore = Math.min(100, eventScore * multiplier);
      console.log(`[Scoring] Sector ${ent.code}: Anomaly-clustering detected (${spikedDomainsCount} domains spiked). Multiplier: ${multiplier.toFixed(3)}`);
    }

    // Load previous composite score to handle lag asymmetry (de-escalation delay)
    const prevComposite = getLatestCompositeScore(ent.code);
    let finalEventScore = eventScore;
    
    if (prevComposite) {
      const prevVal = prevComposite.score;
      if (eventScore < prevVal) {
        // De-escalation: slow decay (85% previous, 15% new)
        finalEventScore = 0.85 * prevVal + 0.15 * eventScore;
      } else {
        // Escalation: immediate response
        finalEventScore = eventScore;
      }
    }

    // Two-speed composite calculation: 40% slow structural prior, 60% fast event/behavioral score
    const finalCompositeScore = Math.round(0.40 * ent.base_risk + 0.60 * finalEventScore);
    
    console.log(`[Scoring] Sector ${ent.code} (${ent.name}): Prior=${ent.base_risk}, Event=${finalEventScore.toFixed(1)} -> Composite=${finalCompositeScore}`);
    
    saveCompositeScore(ent.code, finalCompositeScore, now);
  }
  
  console.log('[Scoring] Risk recalculation completed.');
}
