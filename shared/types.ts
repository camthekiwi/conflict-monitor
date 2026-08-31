export type RiskBand = 'NOMINAL' | 'GUARDED' | 'ELEVATED' | 'HIGH' | 'SEVERE';

export interface Sector {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  risk: number;
  prevRisk: number | null;
  delta: number;
  lastUpdated: string;
}

export interface DomainTelemetry {
  id: string;
  label: string;
  unit: string;
  value: number;
  prevValue: number | null;
  delta: number;
  status: RiskBand;
  history: number[];
  lastUpdated: string;
  isLive: boolean;
}

export interface LogLine {
  timestamp: string;
  domainId: string;
  message: string;
}

export interface BriefCard {
  id: string;
  tag: string;
  timestamp: string;
  headline: string;
  body: string;
  refSectorCode: string;
  compositeScore: number;
}

export interface DashboardState {
  compositeRisk: number;
  prevComposite: number;
  bandName: RiskBand;
  assessmentText: string;
  sectors: Sector[];
  domains: DomainTelemetry[];
  logs: LogLine[];
  briefs: BriefCard[];
}
