// src/api.jsx (or src/api.js)

const BASE = import.meta.env.VITE_API_BASE || 'https://11labs-webhook-voiceagent.vercel.app';
const WORKER_WS_URL = import.meta.env.VITE_WORKER_WS_URL || 'wss://11labs-web.shubhambpn1234.workers.dev';


/** @param {Response} r */
async function j(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: t }; }
}

export async function getProjects() { return j(await fetch(`${BASE}/api/projects`)); }
export async function getKB(key) {
  const r = await fetch(`${BASE}/api/kb?key=${encodeURIComponent(key)}`);
  const data = await j(r);
  if (!r.ok || data?.error) throw new Error(data?.error || 'KB fetch failed');
  return data;
}

export async function pushKB({ project, mode }) {
  return j(await fetch(`${BASE}/api/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, mode })
  }));
}
export async function tts(project) {
  return j(await fetch(`${BASE}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project })
  }));
}
export async function getRealtimePayload(project) {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID || 'agent_8701k1xp8d5xf0q9zg26pyz3tbzx';
  const model = import.meta.env.VITE_ELEVENLABS_MODEL || 'eleven_flash_v2';
   return {
    ws_url: `${WORKER_WS_URL}/ws?model=${encodeURIComponent(model)}&agent_id=${encodeURIComponent(agentId)}&project=${encodeURIComponent(project)}`
  };
  //return j(await fetch(`${BASE}/api/realtime?project=${encodeURIComponent(project)}`));
}

