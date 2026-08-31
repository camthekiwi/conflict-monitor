import { DashboardState } from '../../shared/types.js';

const API_BASE = 'http://localhost:3000';

export async function fetchDashboardState(): Promise<DashboardState> {
  const res = await fetch(`${API_BASE}/api/state`);
  if (!res.ok) {
    throw new Error(`Failed to fetch dashboard state: ${res.statusText}`);
  }
  return res.json() as Promise<DashboardState>;
}

export function connectLiveStream(
  onWelcome: (msg: string) => void,
  onUpdate: (state: DashboardState) => void,
  onError: () => void
): () => void {
  const eventSource = new EventSource(`${API_BASE}/api/live`);

  eventSource.addEventListener('welcome', (e) => {
    try {
      const data = JSON.parse(e.data) as { message: string };
      onWelcome(data.message);
    } catch (err) {
      console.error('Error parsing welcoming event:', err);
    }
  });

  eventSource.addEventListener('update', (e) => {
    try {
      const data = JSON.parse(e.data) as DashboardState;
      onUpdate(data);
    } catch (err) {
      console.error('Error parsing live update:', err);
    }
  });

  eventSource.onerror = (err) => {
    console.error('SSE Connection error:', err);
    onError();
  };

  return () => {
    eventSource.close();
  };
}
