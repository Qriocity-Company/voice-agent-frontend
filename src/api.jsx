const BASE = import.meta.env.VITE_API_BASE || 'https://11labs-webhook-voiceagent.vercel.app';

async function j(r: Response) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: t }; }
}

export async function getProjects() {
  const r = await fetch(`${BASE}/api/projects`);
  const data = await j(r);
  return Array.isArray(data) ? data : []; // <— always array
}

export async function getKB(key: string) {
  const r = await fetch(`${BASE}/api/kb/${encodeURIComponent(key)}`); // <— encode!
  const data = await j(r);
  if (!r.ok || data?.error) throw new Error(data?.error || 'KB fetch failed');
  return data;
}

export async function pushKB({ project, mode }: {project:string; mode:'convai'|'tts'}) {
  const r = await fetch(`${BASE}/api/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, mode })
  });
  const data = await j(r);
  return data;
}


export async function tts(project) {
  const r = await fetch(`${BASE}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project })
  });
  return j(r);
}

export async function getRealtimePayload(project) {
  const r = await fetch(`${BASE}/api/realtime/${project}`);
  return j(r);
}
