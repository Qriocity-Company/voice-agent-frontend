const BASE = import.meta.env.VITE_API_BASE || 'https://11labs-webhook-voiceagent.vercel.app/';

async function j(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: t }; }
}

export async function getProjects() {
  const r = await fetch(`${BASE}/api/projects`);
  return j(r);
}

export async function getKB(key) {
  const r = await fetch(`${BASE}/api/kb/${key}`);
  const data = await j(r);
  if (!r.ok || data?.error) throw new Error(data?.error || `KB fetch failed`);
  return data; // { title, text }
}

export async function pushKB({ project, mode }) {
  const r = await fetch(`${BASE}/api/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, mode })
  });
  return j(r);
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
