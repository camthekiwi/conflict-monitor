# Conflict Monitor (ARGUS-9)

A multi-domain, composite risk-scoring dashboard for tracking conflict-escalation signals. This tool aggregates open-source indicators across multiple dimensions into a composite risk score per region.

ARGUS-9 replaces mockup random-walk data generators with real-time ingestion pipelines and a versioned, double-speed conflict-risk scoring methodology.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Ingestion workers (scheduled, one per source class)          │
│  - fast tier (market/aviation/maritime): every 5–15 min        │
│  - slow tier (ACLED/UCDP/SIPRI/structural): daily/weekly        │
├─────────────────────────────────────────────────────────────┤
│  Normalization + storage (time-series per indicator per entity)│
├─────────────────────────────────────────────────────────────┤
│  Scoring service (composite + per-domain, versioned method)    │
├─────────────────────────────────────────────────────────────┤
│  API (REST + WebSocket/SSE for live push)                      │
├─────────────────────────────────────────────────────────────┤
│  Frontend (the ARGUS-9 UI, now fed by real API instead of      │
│  the random-walk generator)                                    │
└─────────────────────────────────────────────────────────────┘
```

- **Backend**: Node.js/TypeScript and Express serving a REST API and real-time Server-Sent Events (SSE).
- **Database**: SQLite (via Node's native `node:sqlite` module) for time-series telemetry log entries, score audit trails, and logs.
- **Frontend**: Vite, TypeScript, and Vanilla DOM/CSS rendering a CRT scanline phosphor HUD.
- **Scoring Engine**: Implements the `v1.0.0` Two-Speed Risk Model, combining slow structural priors (40%) and fast event telemetry (60%) with clustering multipliers and lag de-escalation asymmetry filters.

---

## 2. Monitored Sectors (Tier-1 Registry)

1. **HZ** - Strait of Hormuz (Lat: 26.6, Lon: 56.3)
2. **BM** - Bab el-Mandeb (Lat: 12.6, Lon: 43.3)
3. **TS** - Taiwan Strait (Lat: 24.4, Lon: 119.5)
4. **SC** - South China Sea (Lat: 12.0, Lon: 113.0)
5. **UK** - Ukraine Frontier (Lat: 48.3, Lon: 38.0)
6. **KP** - Korean Peninsula (Lat: 37.9, Lon: 126.7)
7. **KB** - Kashmir Border (Lat: 34.2, Lon: 74.5)
8. **IG** - Israel-Gaza Border (Lat: 31.5, Lon: 34.4)

---

## 3. Data Pipelines & Indicators

- **Military / OSINT**: GDELT 2.0 (15-min export manifests mapped geospatially to sector coordinates).
- **Aviation**: OpenSky Network API (counting active flight states inside 3-degree bounding boxes and computing pattern deviations).
- **Cyber**: CISA Cyber Advisories (RSS feed scraper scanning for sector-linked target keywords).
- **Diplomatic**: Uppsala Conflict Data Program (UCDP) GED candidate events.
- **Markets (VIX)** & **Maritime (AISStream)**: Configurable external feeds.

---

## 4. Setup & Running Locally

### Prerequisites
Node.js (version 22+) is required to support the native `node:sqlite` module.

### Installation
1. Clone the repository and install workspace dependencies:
   ```bash
   npm install
   ```

2. Configure environment credentials:
   ```bash
   copy .env.template .env
   ```
   *Edit `.env` to supply optional FRED or AISStream tokens. Unconfigured feeds will gracefully transition in the UI into greyed-out `[NO LIVE FEED]` states rather than presenting synthetic placeholder data.*

### Running the App
1. Start the Express API server and background ingestion schedulers:
   ```bash
   npm run dev:backend
   ```

2. Start the Vite frontend dev server in another terminal window:
   ```bash
   npm run dev:frontend
   ```
   *The HUD will be served at `http://localhost:5173`.*

---

## 5. Verification
To verify code formatting and compilation:
- Build backend: `npm run build:backend`
- Build frontend: `npm run build:frontend`
