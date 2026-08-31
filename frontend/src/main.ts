import { DashboardState, Sector, DomainTelemetry, RiskBand, LogLine, BriefCard } from '../../shared/types.js';
import { fetchDashboardState, connectLiveStream } from './api.js';

let currentState: DashboardState | null = null;
let selectedSectorCode: string | null = null;
let currentView: 'RADAR' | 'GLOBE' = 'RADAR';
let currentTab: 'SIGNALS' | 'BRIEF' | 'AUDIT' = 'SIGNALS';
let syncSeconds = 30;
let connectionActive = false;

// Formatters
const fmt1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const getBandColor = (b: RiskBand): string => {
  switch (b) {
    case 'NOMINAL': return '#6FCF97';
    case 'GUARDED': return '#5EC8C0';
    case 'ELEVATED': return '#E8A33D';
    case 'HIGH': return '#DD8A4A';
    case 'SEVERE': return '#E84D4D';
    default: return 'var(--text-muted)';
  }
};

function flash(el: HTMLElement) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 500);
}

function getSectorRiskBand(score: number): RiskBand {
  if (score < 25) return 'NOMINAL';
  if (score < 50) return 'GUARDED';
  if (score < 70) return 'ELEVATED';
  if (score < 85) return 'HIGH';
  return 'SEVERE';
}

// ================= RENDER FUNCTIONS =================

function renderTheatersList(sectors: Sector[]) {
  const listEl = document.getElementById('entity-list');
  const updatedEl = document.getElementById('idxUpdated');
  if (!listEl) return;

  // Sort sectors by risk descending
  const sortedSectors = [...sectors].sort((a, b) => b.risk - a.risk);
  listEl.innerHTML = '';

  // If no sector is selected yet, select the highest risk one on startup
  if (!selectedSectorCode && sortedSectors.length > 0) {
    selectedSectorCode = sortedSectors[0].code;
  }

  sortedSectors.forEach((s) => {
    const band = getSectorRiskBand(s.risk);
    const color = getBandColor(band);
    const isActive = s.code === selectedSectorCode;
    
    const row = document.createElement('div');
    row.className = `entity-row ${isActive ? 'active' : ''}`;
    row.addEventListener('click', () => {
      selectedSectorCode = s.code;
      // Re-render theaters list, viewfinder, domain breakdown, and audit panels
      renderTheatersList(sectors);
      renderViewfinder(s);
      renderDomainGrid(s);
      renderAuditPanel(s);
      renderSituationDisplay(sectors); // Update blip highlights
    });

    row.innerHTML = `
      <div>
        <div style="font-weight: 600; color: ${isActive ? 'var(--cyan-accent)' : 'var(--text-main)'}">${s.name}</div>
        <div style="color: var(--text-muted); font-size: 10px; margin-top: 2px;">SECTOR ${s.code}</div>
      </div>
      <div class="tabular-nums" style="font-weight: bold; font-size: 15px; color: ${color};">${Math.round(s.risk)}</div>
    `;
    listEl.appendChild(row);
  });

  if (updatedEl && sectors.length > 0) {
    const ts = new Date(sectors[0].lastUpdated).toLocaleTimeString('en-US', { hour12: false });
    updatedEl.textContent = 'UPD ' + ts + ' UTC';
  }
}

function renderViewfinder(s: Sector) {
  const display = document.getElementById('viewfinder-display');
  if (!display) return;

  const band = getSectorRiskBand(s.risk);
  const color = getBandColor(band);
  
  display.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span style="letter-spacing: 1px; color: var(--text-muted); font-size: 10px;">MONITORED THEATER</span>
      <span class="status-active-badge" style="border-color:${color}; color:${color}; background:rgba(${band === 'SEVERE' ? '232, 77, 77' : '232, 163, 61'}, 0.08)">${band}</span>
    </div>
    <h2 style="margin: 8px 0 12px 0; font-size: 18px; color: var(--text-main); font-weight: bold;">${s.name}</h2>
    <div style="display:flex; align-items:center; gap: 24px;">
      <div class="gauge-num tabular-nums" id="gaugeNumVal" style="color: ${color};">${Math.round(s.risk)}</div>
      <div style="color: var(--text-muted); font-size: 10.5px; line-height: 1.5;">
        <div>STRUCTURAL PRIOR: <span class="tabular-nums" style="color:var(--text-main); font-weight:bold;">${fmt1(s.structuralPrior)}</span></div>
        <div>FAST BEHAVIORAL: <span class="tabular-nums" style="color:var(--text-main); font-weight:bold;">${fmt1(s.fastLayerScore)}</span></div>
        <div>CLUSTER MULTIPLIER: <span class="tabular-nums" style="color:var(--text-main); font-weight:bold;">${fmt1(s.clusterMultiplier)}x</span></div>
      </div>
    </div>
    <div style="font-size: 10.5px; line-height: 1.5; color: var(--text-dim); margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 8px;">
      <b>ASSESSMENT:</b> ${s.provenanceNotice}
    </div>
  `;

  const numVal = document.getElementById('gaugeNumVal');
  if (numVal) flash(numVal);
}

function renderDomainGrid(s: Sector) {
  const grid = document.getElementById('domain-breakdown-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const domainLabels: Record<string, string> = {
    mil: 'MILITARY / OSINT',
    avi: 'AVIATION',
    mar: 'MARITIME',
    mkt: 'MARKETS',
    dip: 'DIPLOMATIC',
    cyb: 'CYBER',
    osi: 'OSINT / MEDIA'
  };

  Object.entries(s.domainBreakdown).forEach(([domId, data]) => {
    const label = domainLabels[domId] || domId.toUpperCase();
    const isActive = data.status === 'ACTIVE';
    const color = isActive ? getBandColor(data.score! < 25 ? 'NOMINAL' : data.score! < 50 ? 'GUARDED' : data.score! < 70 ? 'ELEVATED' : data.score! < 85 ? 'HIGH' : 'SEVERE') : 'var(--text-muted)';
    
    const card = document.createElement('div');
    card.style.cssText = 'background: var(--bg-primary); border: 1px solid var(--border-color); padding: 8px 10px;';
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom: 4px; align-items: center;">
        <span style="color: var(--text-dim); font-weight:600; font-size: 9.5px; letter-spacing: 0.5px;">${label}</span>
        ${isActive 
          ? `<span class="tabular-nums" style="color:${color}; font-weight:bold; font-size: 11px;">${fmt1(data.score!)}</span>` 
          : `<span class="no-feed-badge" style="font-size: 8px; padding: 1px 4px;">NO LIVE FEED</span>`}
      </div>
      <div style="font-size: 9px; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">
        ${data.indicators.length > 0 ? data.indicators.map(i => i.source).join(', ') : 'Feed unconfigured'}
      </div>
    `;
    grid.appendChild(card);
  });
}

function renderAuditPanel(s: Sector) {
  const panel = document.getElementById('audit-panel-content');
  if (!panel) return;

  panel.innerHTML = `
    <div style="font-size: 11px; color: var(--cyan-accent); margin-bottom: 10px; font-weight:600; letter-spacing: 0.5px;">DATA PROVENANCE & INTEGRITY</div>
    <p style="color: var(--text-muted); font-size: 10.5px; line-height: 1.5; margin-bottom: 14px;">
      ${s.provenanceNotice} Indicators are normalized against trailing historical 30-day baselines (z-score percentiles) and calculated using versioned weights.
    </p>
    <div style="margin-bottom: 14px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">
      <div style="color: var(--cyan-accent); font-size: 9.5px; margin-bottom: 6px; font-weight: bold; letter-spacing: 0.5px;">ACTIVE INGESTED SOURCES</div>
      <div style="display:flex; flex-wrap: wrap; gap: 6px;">
        ${s.integratedSources.length > 0 
          ? s.integratedSources.map(src => `<span class="status-active-badge" style="font-size: 8.5px; padding: 2px 6px;">${src}</span>`).join('') 
          : '<span style="color:var(--text-muted); font-size:9.5px;">None</span>'}
      </div>
    </div>
    <div style="margin-bottom: 14px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">
      <div style="color: var(--danger-red); font-size: 9.5px; margin-bottom: 6px; font-weight: bold; letter-spacing: 0.5px;">UNINTEGRATED / GATED FEEDS</div>
      <div style="display:flex; flex-wrap: wrap; gap: 6px;">
        ${s.unintegratedSources.length > 0 
          ? s.unintegratedSources.map(src => `<span class="no-feed-badge" style="font-size: 8.5px; padding: 2px 6px;">${src}</span>`).join('') 
          : '<span style="color:var(--text-muted); font-size:9.5px;">None</span>'}
      </div>
    </div>
    <div style="background: var(--bg-primary); border: 1px solid var(--border-color); padding: 8px 10px; margin-top: 16px;">
      <div style="color: var(--text-muted); font-size: 9px; letter-spacing: 0.5px;">SCORING MODEL ENGINE</div>
      <div style="color: var(--text-main); font-size: 10.5px; font-weight: bold; margin-top: 2px;">${s.scoringVersion}</div>
    </div>
  `;
}

function projectGlobe(lat: number, lon: number) {
  const x = 100 + 90 * Math.sin(lon * Math.PI / 180) * 0.9;
  const y = 100 - 90 * Math.sin(lat * Math.PI / 180) * 0.65;
  return { x, y };
}

function renderSituationDisplay(sectors: Sector[]) {
  const blipLayer = document.getElementById('blipLayer');
  const globeMarkersEl = document.getElementById('globeMarkers');
  
  if (blipLayer) {
    blipLayer.innerHTML = '';
    sectors.forEach((s, idx) => {
      const angle = (idx * 360) / sectors.length;
      const radius = 55 + (s.risk / 100) * 35;
      const rad = (angle - 90) * Math.PI / 180;
      const x = 100 + radius * Math.cos(rad);
      const y = 100 + radius * Math.sin(rad);
      const color = getBandColor(getSectorRiskBand(s.risk));
      const isSelected = s.code === selectedSectorCode;
      
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'blip');
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => {
        selectedSectorCode = s.code;
        renderTheatersList(sectors);
        renderViewfinder(s);
        renderDomainGrid(s);
        renderAuditPanel(s);
        renderSituationDisplay(sectors); // Highlight blip
      });

      const delay = (angle / 360) * 8;
      
      g.innerHTML = `
        <circle cx="${x}" cy="${y}" r="${isSelected ? 20 : 14}" fill="${color}" opacity="${isSelected ? 0.15 : 0.08}"/>
        ${isSelected ? '<circle cx="' + x + '" cy="' + y + '" r="8" fill="none" stroke="' + color + '" stroke-width="1" stroke-dasharray="2,2"/>' : ''}
        <circle class="core" cx="${x}" cy="${y}" r="${(isSelected ? 5.5 : 3.5) + (s.risk / 100) * 4.5}" fill="${color}" style="animation-delay:${delay}s"/>
      `;
      blipLayer.appendChild(g);
    });
  }

  if (globeMarkersEl) {
    globeMarkersEl.innerHTML = '';
    sectors.forEach(s => {
      const p = projectGlobe(s.latitude, s.longitude);
      const color = getBandColor(getSectorRiskBand(s.risk));
      const isSelected = s.code === selectedSectorCode;
      
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'globe-marker');
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => {
        selectedSectorCode = s.code;
        renderTheatersList(sectors);
        renderViewfinder(s);
        renderDomainGrid(s);
        renderAuditPanel(s);
        renderSituationDisplay(sectors);
      });

      g.innerHTML = `
        <circle cx="${p.x}" cy="${p.y}" r="${isSelected ? 14 : 10}" fill="${color}" opacity="${isSelected ? 0.20 : 0.10}"/>
        ${isSelected ? '<circle cx="' + p.x + '" cy="' + p.y + '" r="6.5" fill="none" stroke="' + color + '" stroke-width="0.8" stroke-dasharray="1.5,1.5"/>' : ''}
        <circle class="core" cx="${p.x}" cy="${p.y}" r="${(isSelected ? 4.5 : 3) + (s.risk / 100) * 3.5}" fill="${color}"/>
      `;
      globeMarkersEl.appendChild(g);
    });
  }
}

function drawSparkline(svgEl: SVGPolylineElement, history: number[], color: string) {
  if (history.length < 2) return;
  const min = Math.min(...history), max = Math.max(...history);
  const span = (max - min) || 1;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * 100;
    const y = 20 - ((v - min) / span) * 17 - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  
  svgEl.setAttribute('points', pts);
  svgEl.setAttribute('stroke', color);
}

function renderDomainsSignals(domains: DomainTelemetry[]) {
  const panel = document.getElementById('paneSignals');
  if (!panel) return;
  panel.innerHTML = '';

  domains.forEach(d => {
    const card = document.createElement('div');
    card.className = `signal-panel ${d.isLive ? '' : 'not-live'}`;
    
    const color = d.isLive ? getBandColor(d.status) : 'var(--text-muted)';
    const statusText = d.isLive ? d.status : 'NO LIVE FEED';
    
    const deltaVal = d.delta;
    let deltaHTML = '—';
    if (d.isLive) {
      if (Math.abs(deltaVal) < 0.05) {
        deltaHTML = '—';
      } else if (deltaVal > 0) {
        deltaHTML = `<span style="color:var(--red)">▲ ${fmt1(Math.abs(deltaVal))}</span>`;
      } else {
        deltaHTML = `<span style="color:var(--green)">▼ ${fmt1(Math.abs(deltaVal))}</span>`;
      }
    }

    card.innerHTML = `
      <div class="signal-head">
        <span class="signal-title">${d.label} ${d.isLive ? '' : '<span style="color:var(--text-faint);font-size:8px;">[OFFLINE]</span>'}</span>
        <span class="signal-status">
          <span class="dot" style="background:${color};box-shadow: 0 0 5px ${color}"></span>
          <span style="color:${color}">${statusText}</span>
        </span>
      </div>
      <div class="signal-metric-row">
        <div class="signal-metric">
          <span class="val" id="val-${d.id}">${d.isLive ? (d.unit === 'σ' ? (d.value >= 0 ? '+' : '') : '') + fmt1(d.value) : '--'}</span>
          <span class="unit">${d.unit}</span>
        </div>
        <span class="signal-delta">${deltaHTML}</span>
      </div>
      <svg class="spark" viewBox="0 0 100 22" preserveAspectRatio="none">
        <polyline id="sparkline-${d.id}" fill="none" stroke-width="1.4"/>
      </svg>
    `;
    
    panel.appendChild(card);
    
    if (d.isLive && d.history.length > 0) {
      const polyline = document.getElementById(`sparkline-${d.id}`) as unknown as SVGPolylineElement;
      if (polyline) {
        drawSparkline(polyline, d.history, color);
      }
    }
  });
}

function renderBriefs(briefs: BriefCard[]) {
  const panel = document.getElementById('paneBrief');
  if (!panel) return;
  panel.innerHTML = '';

  briefs.forEach(b => {
    const card = document.createElement('div');
    card.className = 'brief-card';
    const ts = new Date(b.timestamp).toLocaleTimeString('en-US', { hour12: false });
    
    card.innerHTML = `
      <div class="brief-top">
        <span class="brief-tag" style="color:var(--amber);border-color:var(--amber-dim)">${b.tag}</span>
        <span class="brief-ts">${ts} UTC</span>
      </div>
      <div class="brief-headline">${b.headline}</div>
      <div class="brief-body">${b.body}</div>
      <div class="brief-refs">REF: SECTOR ${b.refSectorCode} · COMPOSITE ${Math.round(b.compositeScore)} · REAL PIPELINE</div>
    `;
    panel.appendChild(card);
  });
}

function renderTicker(logs: LogLine[]) {
  const trackEl = document.getElementById('tickerTrack');
  if (!trackEl) return;
  
  const statusSeg = `<span class="ticker-seg" style="color:var(--red); font-weight:bold;"><b>//</b>STATUS: LIVE PIPELINE // ZERO SYNTHETIC FALLBACK ENFORCED</span>`;
  
  if (logs.length === 0) {
    trackEl.innerHTML = statusSeg + '<span class="ticker-seg"><b>//</b>AWAITING SIGNALS...</span>';
    return;
  }

  const logsSeg = logs.slice(0, 10).map(l => {
    const ts = new Date(l.timestamp).toLocaleTimeString('en-US', { hour12: false });
    return `<span class="ticker-seg"><b>//</b>[${ts}] ${l.message}</span>`;
  }).join('');
  
  trackEl.innerHTML = statusSeg + logsSeg + statusSeg + logsSeg; // duplicate for infinite loop
}

function updateCompositeGauge(risk: number, prevRisk: number, bandName: RiskBand, assessment: string) {
  const fillEl = document.getElementById('gaugeFill');
  const numEl = document.getElementById('gaugeNum');
  const bandEl = document.getElementById('gaugeBand');
  const deltaEl = document.getElementById('gaugeDelta');
  const assessmentEl = document.getElementById('assessment');
  
  const color = getBandColor(bandName);
  
  if (fillEl) {
    const GAUGE_CIRC = 502.65;
    fillEl.style.strokeDashoffset = String(GAUGE_CIRC * (1 - risk / 100));
    fillEl.style.stroke = color;
  }
  
  if (numEl) {
    numEl.textContent = String(Math.round(risk));
    numEl.style.color = color;
    flash(numEl);
  }
  
  if (bandEl) {
    bandEl.textContent = bandName;
    bandEl.style.color = color;
  }
  
  if (deltaEl) {
    const diff = risk - prevRisk;
    if (Math.abs(diff) < 1) {
      deltaEl.textContent = 'STABLE SINCE LAST SYNC';
    } else if (diff > 0) {
      deltaEl.textContent = `▲ ${Math.round(diff)} SINCE LAST SYNC`;
    } else {
      deltaEl.textContent = `▼ ${Math.round(Math.abs(diff))} SINCE LAST SYNC`;
    }
  }

  if (assessmentEl) {
    assessmentEl.textContent = assessment;
  }
}

// UI State Bindings
function updateFullUI(state: DashboardState) {
  currentState = state;

  // Sync selected sector
  let activeSector = state.sectors.find(s => s.code === selectedSectorCode);
  if (!activeSector && state.sectors.length > 0) {
    activeSector = state.sectors[0];
    selectedSectorCode = activeSector.code;
  }

  renderTheatersList(state.sectors);
  if (activeSector) {
    renderViewfinder(activeSector);
    renderDomainGrid(activeSector);
    renderAuditPanel(activeSector);
  }
  renderSituationDisplay(state.sectors);
  renderDomainsSignals(state.domains);
  renderBriefs(state.briefs);
  renderTicker(state.logs);
  updateCompositeGauge(state.compositeRisk, state.prevComposite, state.bandName, state.assessmentText);
}

// ================= CLOCK & CONTROLS =================

function initClock() {
  const clockEl = document.getElementById('clockTime');
  const syncFill = document.getElementById('syncFill');
  const syncNum = document.getElementById('syncNum');
  const SYNC_CIRC = 87.9;

  setInterval(() => {
    const d = new Date();
    if (clockEl) {
      clockEl.textContent = d.toISOString().substr(11, 8);
    }
    
    // Decrement countdown
    syncSeconds -= 1;
    if (syncSeconds < 0) {
      syncSeconds = 30;
      if (!connectionActive) {
        fetchDashboardState().then(updateFullUI).catch(console.error);
      }
    }
    
    if (syncNum) syncNum.textContent = String(syncSeconds);
    if (syncFill) syncFill.setAttribute('stroke-dashoffset', String(SYNC_CIRC * (syncSeconds / 30)));
  }, 1000);
}

function setupControlListeners() {
  // Tabs
  const tabSignals = document.getElementById('tabSignals');
  const tabBrief = document.getElementById('tabBrief');
  const tabAudit = document.getElementById('tabAudit');
  
  const paneSignals = document.getElementById('paneSignals');
  const paneBrief = document.getElementById('paneBrief');
  const paneAudit = document.getElementById('paneAudit');

  tabSignals?.addEventListener('click', () => {
    tabSignals.classList.add('active'); tabBrief?.classList.remove('active'); tabAudit?.classList.remove('active');
    paneSignals?.classList.remove('hidden-view'); paneBrief?.classList.add('hidden-view'); paneAudit?.classList.add('hidden-view');
    currentTab = 'SIGNALS';
  });

  tabBrief?.addEventListener('click', () => {
    tabBrief.classList.add('active'); tabSignals?.classList.remove('active'); tabAudit?.classList.remove('active');
    paneBrief?.classList.remove('hidden-view'); paneSignals?.classList.add('hidden-view'); paneAudit?.classList.add('hidden-view');
    currentTab = 'BRIEF';
  });

  tabAudit?.addEventListener('click', () => {
    tabAudit.classList.add('active'); tabSignals?.classList.remove('active'); tabBrief?.classList.remove('active');
    paneAudit?.classList.remove('hidden-view'); paneSignals?.classList.add('hidden-view'); paneBrief?.classList.add('hidden-view');
    currentTab = 'AUDIT';
  });

  // Display toggles
  const btnRadar = document.getElementById('btnRadar');
  const btnGlobe = document.getElementById('btnGlobe');
  const radarWrap = document.getElementById('radarWrap');
  const globeWrap = document.getElementById('globeWrap');

  btnRadar?.addEventListener('click', () => {
    btnRadar.classList.add('active'); btnGlobe?.classList.remove('active');
    radarWrap?.classList.remove('hidden-view'); globeWrap?.classList.add('hidden-view');
    currentView = 'RADAR';
  });

  btnGlobe?.addEventListener('click', () => {
    btnGlobe.classList.add('active'); btnRadar?.classList.remove('active');
    globeWrap?.classList.remove('hidden-view'); radarWrap?.classList.add('hidden-view');
    currentView = 'GLOBE';
  });
}

function setConnectionState(active: boolean) {
  connectionActive = active;
  const pulse = document.getElementById('connectionPulse');
  const connText = document.getElementById('connectionText');
  const badge = document.getElementById('hudStatusBadge');

  if (active) {
    pulse?.classList.add('connected');
    if (connText) connText.textContent = 'ONLINE';
    badge?.classList.remove('offline');
  } else {
    pulse?.classList.remove('connected');
    if (connText) connText.textContent = 'OFFLINE';
    badge?.classList.add('offline');
  }
}

// ================= INITIALIZATION =================

async function initApp() {
  setupControlListeners();
  initClock();

  try {
    const initialState = await fetchDashboardState();
    updateFullUI(initialState);
  } catch (err) {
    console.error('Initial REST fetch failed, waiting for SSE stream...', err);
  }

  connectLiveStream(
    (welcomeMsg) => {
      console.log('[SSE] Welcome:', welcomeMsg);
      setConnectionState(true);
    },
    (stateUpdate) => {
      console.log('[SSE] Received dashboard sync update');
      updateFullUI(stateUpdate);
      setConnectionState(true);
      syncSeconds = 30; // Reset countdown timer on SSE push
    },
    () => {
      console.warn('[SSE] Connection lost. Re-establishing.');
      setConnectionState(false);
    }
  );
}

window.addEventListener('DOMContentLoaded', initApp);
