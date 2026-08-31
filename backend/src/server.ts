import express from 'express';
import { CONFIG, SECTOR_REGISTRY } from './config.js';
import { 
  initDb, 
  getEntities, 
  getIndicators, 
  getTelemetryHistory, 
  getLatestCompositeScore, 
  getCompositeScoreHistory, 
  getLatestLogs, 
  getLatestBriefs, 
  saveBrief,
  saveLog
} from './db.js';
import { runAllWorkersOnStartup, startScheduler } from './workers/scheduler.js';
import { computeCompositeRisk, normalizeIndicator } from './scoring.js';
import { DashboardState, Sector, DomainTelemetry, RiskBand, LogLine, BriefCard } from './shared/types.js';

const app = express();

// Set up CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// SSE Clients Registry
let sseClients: express.Response[] = [];

// Broadcast function to send live signals to all active UIs
function broadcastSSE(type: string, data: any) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function getRiskBand(v: number): { name: RiskBand; color: string } {
  if (v < 25) return { name: 'NOMINAL', color: '#6FCF97' };
  if (v < 50) return { name: 'GUARDED', color: '#5EC8C0' };
  if (v < 70) return { name: 'ELEVATED', color: '#E8A33D' };
  if (v < 85) return { name: 'HIGH', color: '#DD8A4A' };
  return { name: 'SEVERE', color: '#E0524A' };
}

const ASSESSMENTS = {
  NOMINAL:  'Baseline activity across monitored sectors. No unusual clustering detected.',
  GUARDED:  'Isolated signal clusters observed. Continued monitoring recommended.',
  ELEVATED: 'Cross-domain anomaly clustering detected in multiple sectors.',
  HIGH:     'Simultaneous multi-domain signals consistent with pre-escalation posture.',
  SEVERE:   'Convergent indicators across all monitored domains. Immediate review advised.'
};

// Compile Dashboard State from current SQLite DB
function compileDashboardState(): DashboardState {
  const dbEntities = getEntities();
  const dbIndicators = getIndicators();
  const dbLogs = getLatestLogs(20);
  const dbBriefs = getLatestBriefs(12);

  // 1. Sector Formatting
  const sectors: Sector[] = dbEntities.map(ent => {
    const latestScore = getLatestCompositeScore(ent.code);
    const scoreVal = latestScore ? latestScore.score : ent.base_risk;
    const history = getCompositeScoreHistory(ent.code, 2);
    const prevScoreVal = history.length > 1 ? history[0].score : ent.base_risk;
    
    // Detailed domain breakdown calculation for this sector
    const domainBreakdown: Record<string, any> = {};
    const defaultWeights: Record<string, number> = {
      mil: 0.30,
      cyb: 0.15,
      avi: 0.10,
      mar: 0.15,
      mkt: 0.10,
      dip: 0.10,
      osi: 0.10
    };
    
    let activeEventSum = 0;
    let activeWeightSum = 0;
    let spikedDomainsCount = 0;
    
    const domainsList = [
      { id: 'mil', label: 'MILITARY / OSINT', source: 'GDELT 2.0 / ACLED' },
      { id: 'avi', label: 'AVIATION', source: 'OpenSky Network' },
      { id: 'mar', label: 'MARITIME', source: 'AISStream.io' },
      { id: 'mkt', label: 'MARKETS', source: 'FRED VIX' },
      { id: 'dip', label: 'DIPLOMATIC', source: 'UCDP Candidate GED' },
      { id: 'cyb', label: 'CYBER', source: 'CISA Cyber RSS' },
      { id: 'osi', label: 'OSINT / MEDIA', source: 'GDELT 2.0 AvgTone' },
    ];
    
    for (const dom of domainsList) {
      const domIndicators = dbIndicators.filter(ind => ind.domain === dom.id);
      const isLive = domIndicators.some(ind => ind.is_live === 1);
      
      if (!isLive) {
        domainBreakdown[dom.id] = {
          status: 'NO_LIVE_FEED',
          score: null,
          indicators: []
        };
        continue;
      }
      
      let indSum = 0;
      let indCount = 0;
      const indicatorsDetails: { source: string }[] = [];
      
      for (const ind of domIndicators) {
        if (ind.id === 'avi_opensky_flights') continue; // Skip raw count
        const hist = getTelemetryHistory(ent.code, ind.id, 1);
        if (hist.length > 0) {
          const norm = normalizeIndicator(ind.id, hist[0].raw_value);
          indSum += norm;
          indCount++;
          indicatorsDetails.push({ source: dom.source });
        }
      }
      
      const scoreVal = indCount > 0 ? parseFloat((indSum / indCount).toFixed(1)) : 0;
      domainBreakdown[dom.id] = {
        status: 'ACTIVE',
        score: scoreVal,
        indicators: indicatorsDetails
      };
      
      const weight = defaultWeights[dom.id] || 0.1;
      activeEventSum += scoreVal * weight;
      activeWeightSum += weight;
      if (scoreVal > 50) spikedDomainsCount++;
    }
    
    const rawEventScore = activeWeightSum > 0 ? activeEventSum / activeWeightSum : 0;
    const clusterMultiplier = spikedDomainsCount >= 3 ? 1.0 + (spikedDomainsCount - 2) * 0.125 : 1.0;
    const fastLayerScore = parseFloat((rawEventScore * clusterMultiplier).toFixed(1));

    // Dynamic sources mapping
    const integratedSources: string[] = [];
    const unintegratedSources: string[] = [];
    const sourcesInfo = [
      { key: 'mil_gdelt_goldstein', name: 'GDELT' },
      { key: 'avi_opensky_flights', name: 'OPENSKY' },
      { key: 'cyb_cisa_alerts', name: 'CISA' },
      { key: 'dip_news_advisory', name: 'UCDP' },
      { key: 'mkt_fred_vix', name: 'FRED_VIX' },
      { key: 'mar_ais_anom', name: 'AIS_STREAM' }
    ];
    
    for (const sInfo of sourcesInfo) {
      const ind = dbIndicators.find(i => i.id === sInfo.key);
      if (ind && ind.is_live === 1) {
        integratedSources.push(sInfo.name);
      } else {
        unintegratedSources.push(sInfo.name);
      }
    }

    return {
      code: ent.code,
      name: ent.name,
      latitude: ent.latitude,
      longitude: ent.longitude,
      risk: scoreVal,
      prevRisk: prevScoreVal,
      delta: scoreVal - prevScoreVal,
      lastUpdated: latestScore ? latestScore.timestamp : new Date().toISOString(),
      structuralPrior: ent.base_risk,
      fastLayerScore,
      clusterMultiplier,
      domainBreakdown,
      integratedSources,
      unintegratedSources,
      scoringVersion: 'v1.2.0-two-speed',
      provenanceNotice: 'Open-source aggregated indicator composite. Not a proprietary war forecast.'
    };
  });

  // Calculate composite risk average
  const totalRisk = sectors.reduce((sum, s) => sum + s.risk, 0);
  const compositeRisk = sectors.length > 0 ? Math.round(totalRisk / sectors.length) : 50;
  
  // Calculate previous composite risk average
  const totalPrevRisk = sectors.reduce((sum, s) => sum + (s.prevRisk ?? s.risk), 0);
  const prevComposite = sectors.length > 0 ? Math.round(totalPrevRisk / sectors.length) : 50;

  const band = getRiskBand(compositeRisk);

  // 2. Domain Telemetry Formatting
  const domains: DomainTelemetry[] = [];
  const domainMapping: Record<string, { label: string; unit: string }> = {
    mil: { label: 'MILITARY / OSINT', unit: '/24H' },
    avi: { label: 'AVIATION', unit: 'ACTIVE' },
    mar: { label: 'MARITIME', unit: '% BASE' },
    mkt: { label: 'MARKETS', unit: 'GPR IDX' },
    dip: { label: 'DIPLOMATIC', unit: 'ACTIVE' },
    cyb: { label: 'CYBER', unit: 'INDEX' },
    osi: { label: 'OSINT / MEDIA', unit: 'σ' }
  };

  for (const domId in domainMapping) {
    const mapping = domainMapping[domId];
    const domIndicators = dbIndicators.filter(ind => ind.domain === domId);
    
    // Check if any indicator in this domain is live
    const isLive = domIndicators.some(ind => ind.is_live === 1);
    
    // Aggregate telemetry values (take averages of live indicator readings)
    const historyValues: Record<string, number[]> = {};
    let latestVal = 0;
    let prevVal = 0;
    let recordsCount = 0;
    let timestamp = new Date().toISOString();

    for (const ind of domIndicators) {
      // Ignore active flight counts for direct value averages (we use dev)
      if (ind.id === 'avi_opensky_flights') continue;

      // We average across all sectors for the global indicator status
      let indSum = 0;
      let indCount = 0;
      let indPrevSum = 0;
      
      for (const ent of dbEntities) {
        const hist = getTelemetryHistory(ent.code, ind.id, 2);
        if (hist.length > 0) {
          indSum += hist[hist.length - 1].raw_value;
          indCount++;
          timestamp = hist[hist.length - 1].timestamp;
          if (hist.length > 1) {
            indPrevSum += hist[0].raw_value;
          } else {
            indPrevSum += hist[hist.length - 1].raw_value;
          }
        }
      }

      if (indCount > 0) {
        latestVal += indSum / indCount;
        prevVal += indPrevSum / indCount;
        recordsCount++;
      }
    }

    const value = recordsCount > 0 ? parseFloat((latestVal / recordsCount).toFixed(1)) : 0;
    const previousValue = recordsCount > 0 ? parseFloat((prevVal / recordsCount).toFixed(1)) : 0;

    // Build dummy sparkline history from database entries or fill default
    const sparkHistory: number[] = [];
    if (domIndicators.length > 0) {
      const activeInd = domIndicators.find(ind => ind.id !== 'avi_opensky_flights') || domIndicators[0];
      const sampleEnt = dbEntities[0];
      const dbHist = getTelemetryHistory(sampleEnt.code, activeInd.id, 16);
      sparkHistory.push(...dbHist.map(h => h.raw_value));
    }
    while (sparkHistory.length < 16) {
      sparkHistory.unshift(value);
    }

    domains.push({
      id: domId,
      label: mapping.label,
      unit: mapping.unit,
      value: isLive ? value : 0,
      prevValue: isLive ? previousValue : 0,
      delta: isLive ? parseFloat((value - previousValue).toFixed(1)) : 0,
      status: isLive ? getRiskBand(Math.min(100, Math.max(0, value))).name : 'NOMINAL',
      history: isLive ? sparkHistory : [],
      lastUpdated: timestamp,
      isLive
    });
  }

  // 3. Brief formatting
  const briefs: BriefCard[] = dbBriefs.map(b => ({
    id: b.id,
    tag: b.tag,
    timestamp: b.timestamp,
    headline: b.headline,
    body: b.body,
    refSectorCode: b.ref_sector_code,
    compositeScore: b.composite_score
  }));

  // Auto-generate a brief if database lacks any
  if (briefs.length === 0 && sectors.length > 0) {
    const randomSector = sectors[Math.floor(Math.random() * sectors.length)];
    const sectorBand = getRiskBand(randomSector.risk);
    const briefId = `brf_${Date.now()}`;
    const tag = 'INTELLIGENCE';
    const headline = `${randomSector.name} posture assessed as ${sectorBand.name.toLowerCase()}`;
    const body = `Scoring calculations for Sector ${randomSector.code} indicates risk levels at ${randomSector.risk}/100. Local event density triggers alerts in conflict-scoring telemetry.`;
    
    saveBrief(briefId, tag, headline, body, randomSector.code, randomSector.risk);
    
    briefs.push({
      id: briefId,
      tag,
      timestamp: new Date().toISOString(),
      headline,
      body,
      refSectorCode: randomSector.code,
      compositeScore: randomSector.risk
    });
  }

  return {
    compositeRisk,
    prevComposite,
    bandName: band.name,
    assessmentText: ASSESSMENTS[band.name],
    sectors,
    domains,
    logs: dbLogs.map(l => ({ timestamp: l.timestamp, domainId: l.domain_id, message: l.message })),
    briefs
  };
}

// REST endpoints
app.get('/api/state', (req, res) => {
  res.json(compileDashboardState());
});

app.get('/api/methodology', (req, res) => {
  res.json({
    version: 'v1.0.0',
    title: 'ARGUS-9 Scoring Methodology',
    twoSpeedModel: {
      structuralPriorWeight: 0.40,
      eventBehavioralWeight: 0.60,
      description: 'Combines slow structural priors (PITF regime/border stability base rate) with fast-moving physical/news signals normalized via historic z-scores.'
    },
    domainWeights: {
      military: 0.30,
      cyber: 0.15,
      aviation: 0.10,
      maritime: 0.15,
      markets: 0.10,
      diplomatic: 0.10,
      osintMedia: 0.10
    },
    decayHalfLife: 'Exponential half-life applied on risk reduction to prevent lag asymmetry and early clearance flags.',
    clusteringSynergyPenalty: 'Score multiplier triggers when >= 3 domains spike above elevated thresholds.'
  });
});

// SSE endpoint
app.get('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  console.log(`[SSE] Client connected. Total: ${sseClients.length}`);

  // Send initial state
  res.write(`event: welcome\ndata: ${JSON.stringify({ message: 'Connected to ARGUS-9 live server' })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log(`[SSE] Client disconnected. Total: ${sseClients.length}`);
  });
});

// Main server startup
async function startServer() {
  // Initialize Database
  initDb();

  // Run initial wave of ingestion data
  await runAllWorkersOnStartup();
  
  // Do initial composite scores calculations
  computeCompositeRisk();

  // Start Background Cron Scheduler
  startScheduler();

  // Start 30-second Dashboard refresh loop (compiles DB scores & pushes SSE update event)
  setInterval(() => {
    console.log('[Sync] Executing 30s dashboard sync cycle...');
    computeCompositeRisk();
    
    // Auto-generate brief periodically
    if (Math.random() < 0.3) {
      const state = compileDashboardState();
      const randomSector = state.sectors[Math.floor(Math.random() * state.sectors.length)];
      const sectorBand = getRiskBand(randomSector.risk);
      const briefId = `brf_${Date.now()}`;
      
      const tag = Math.random() > 0.5 ? 'MARITIME' : 'MILITARY';
      const headline = `Post-update review: Sector ${randomSector.code}`;
      const body = `Security baseline evaluation confirms classification of ${randomSector.name} at ${sectorBand.name}. Traffic index delta reports ${randomSector.delta > 0 ? '+' : ''}${randomSector.delta} points.`;
      
      saveBrief(briefId, tag, headline, body, randomSector.code, randomSector.risk);
    }
    
    const state = compileDashboardState();
    broadcastSSE('update', state);
  }, CONFIG.SYNC_INTERVAL_SEC * 1000);

  app.listen(CONFIG.PORT, () => {
    console.log(`===============================================`);
    console.log(`ARGUS-9 Core Server listening on port ${CONFIG.PORT}`);
    console.log(`===============================================`);
  });
}

startServer().catch(err => {
  console.error('[Server] Fatal startup error:', err);
});
