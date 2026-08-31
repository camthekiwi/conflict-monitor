import { DashboardState, Sector, DomainTelemetry, RiskBand, LogLine, BriefCard } from '../../shared/types.js';
import { fetchDashboardState, connectLiveStream } from './api.js';

let currentState: DashboardState | null = null;
let currentView: 'RADAR' | 'GLOBE' = 'RADAR';
let currentTab: 'SIGNALS' | 'BRIEF' | 'METHOD' = 'SIGNALS';
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
    case 'SEVERE': return '#E0524A';
    default: return 'var(--text-faint)';
  }
};

function flash(el: HTMLElement) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 500);
}

// ================= RENDER FUNCTIONS =================

function renderIndex(sectors: Sector[]) {
  const listEl = document.getElementById('idxList');
  const updatedEl = document.getElementById('idxUpdated');
  if (!listEl) return;

  const ranked = [...sectors].sort((a, b) => b.risk - a.risk);
  listEl.innerHTML = '';
  
  ranked.forEach((s, i) => {
    const color = getBandColor(s.risk < 25 ? 'NOMINAL' : s.risk < 50 ? 'GUARDED' : s.risk < 70 ? 'ELEVATED' : s.risk < 85 ? 'HIGH' : 'SEVERE');
    const diff = s.delta;
    const deltaTxt = Math.abs(diff) < 0.3 ? '—' : (diff > 0 ? '▲' : '▼') + fmt1(Math.abs(diff));
    const deltaColor = Math.abs(diff) < 0.3 ? 'var(--text-faint)' : (diff > 0 ? 'var(--red)' : 'var(--green)');
    
    const row = document.createElement('div');
    row.className = 'idx-row';
    row.innerHTML = `
      <span class="idx-rank">${String(i + 1).padStart(2, '0')}</span>
      <span class="idx-name-block"><span class="code">SECTOR ${s.code}</span><span class="name">${s.name}</span></span>
      <span class="idx-score"><span class="num" style="color:${color}">${Math.round(s.risk)}</span><span class="delta" style="color:${deltaColor}">${deltaTxt}</span></span>
      <div class="idx-meter"><div class="fill" style="width:${s.risk}%;background:${color}"></div></div>
    `;
    listEl.appendChild(row);
  });

  if (updatedEl && sectors.length > 0) {
    const ts = new Date(sectors[0].lastUpdated).toLocaleTimeString('en-US', { hour12: false });
    updatedEl.textContent = 'UPD ' + ts + ' UTC';
  }
}

// Simple orthographic projection mapping lat/lon to Globe coordinates
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
    // Map polar angles for Radar view dynamically based on sector order
    sectors.forEach((s, idx) => {
      const angle = (idx * 360) / sectors.length;
      const radius = 55 + (s.risk / 100) * 35; // Position on radar rings relative to risk
      const rad = (angle - 90) * Math.PI / 180;
      const x = 100 + radius * Math.cos(rad);
      const y = 100 + radius * Math.sin(rad);
      const color = getBandColor(s.risk < 25 ? 'NOMINAL' : s.risk < 50 ? 'GUARDED' : s.risk < 70 ? 'ELEVATED' : s.risk < 85 ? 'HIGH' : 'SEVERE');
      
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'blip');
      const delay = (angle / 360) * 8;
      g.innerHTML = `
        <circle cx="${x}" cy="${y}" r="14" fill="${color}" opacity="0.08"/>
        <circle class="core" cx="${x}" cy="${y}" r="${3.5 + (s.risk / 100) * 4.5}" fill="${color}" style="animation-delay:${delay}s"/>
      `;
      blipLayer.appendChild(g);
    });
  }

  if (globeMarkersEl) {
    globeMarkersEl.innerHTML = '';
    sectors.forEach(s => {
      const p = projectGlobe(s.latitude, s.longitude);
      const color = getBandColor(s.risk < 25 ? 'NOMINAL' : s.risk < 50 ? 'GUARDED' : s.risk < 70 ? 'ELEVATED' : s.risk < 85 ? 'HIGH' : 'SEVERE');
      
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'globe-marker');
      g.innerHTML = `
        <circle cx="${p.x}" cy="${p.y}" r="10" fill="${color}" opacity="0.10"/>
        <circle class="core" cx="${p.x}" cy="${p.y}" r="${3 + (s.risk / 100) * 3.5}" fill="${color}"/>
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

function renderDomains(domains: DomainTelemetry[]) {
  const panel = document.getElementById('paneSignals');
  if (!panel) return;
  panel.innerHTML = '';

  domains.forEach(d => {
    const card = document.createElement('div');
    card.className = `signal-panel ${d.isLive ? '' : 'not-live'}`;
    
    const color = d.isLive ? getBandColor(d.status) : 'var(--text-faint)';
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
    
    // Draw sparkline if live
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
  
  if (logs.length === 0) {
    trackEl.innerHTML = '<span class="ticker-seg"><b>//</b>AWAITING SIGNALS...</span>';
    return;
  }

  const content = logs.slice(0, 10).map(l => {
    const ts = new Date(l.timestamp).toLocaleTimeString('en-US', { hour12: false });
    return `<span class="ticker-seg"><b>//</b>[${ts}] ${l.message}</span>`;
  }).join('');
  
  trackEl.innerHTML = content + content; // duplicate for infinite scroll loop
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
  
  renderIndex(state.sectors);
  renderSituationDisplay(state.sectors);
  renderDomains(state.domains);
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
      // If server is offline, trigger a manual fetch
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
  const tabMethod = document.getElementById('tabMethod');
  
  const paneSignals = document.getElementById('paneSignals');
  const paneBrief = document.getElementById('paneBrief');
  const paneMethod = document.getElementById('paneMethod');

  tabSignals?.addEventListener('click', () => {
    tabSignals.classList.add('active'); tabBrief?.classList.remove('active'); tabMethod?.classList.remove('active');
    paneSignals?.classList.remove('hidden-view'); paneBrief?.classList.add('hidden-view'); paneMethod?.classList.add('hidden-view');
    currentTab = 'SIGNALS';
  });

  tabBrief?.addEventListener('click', () => {
    tabBrief.classList.add('active'); tabSignals?.classList.remove('active'); tabMethod?.classList.remove('active');
    paneBrief?.classList.remove('hidden-view'); paneSignals?.classList.add('hidden-view'); paneMethod?.classList.add('hidden-view');
    currentTab = 'BRIEF';
  });

  tabMethod?.addEventListener('click', () => {
    tabMethod.classList.add('active'); tabSignals?.classList.remove('active'); tabBrief?.classList.remove('active');
    paneMethod?.classList.remove('hidden-view'); paneSignals?.classList.add('hidden-view'); paneBrief?.classList.add('hidden-view');
    currentTab = 'METHOD';
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

// Connection State UI Updates
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

  // Try to load initial state immediately
  try {
    const initialState = await fetchDashboardState();
    updateFullUI(initialState);
  } catch (err) {
    console.error('Initial REST fetch failed, waiting for SSE stream...', err);
  }

  // Connect Server-Sent Events (SSE) Live pipeline
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
