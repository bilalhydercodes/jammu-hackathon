'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PYTHON_URL = process.env.PYTHON_URL || 'http://127.0.0.1:8000/analyze';
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 600);
const STALE_MS = Number(process.env.STALE_MS || 5000);

let latest = null;
let lastHardwareAt = 0;
const history = [];
const streamClients = new Set();
const commands = new Map();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function analyze(sample) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(PYTHON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`python ${response.status}`);
    return await response.json();
  } catch (err) {
    return {
      status: 'UNKNOWN',
      healthScore: null,
      alerts: [{ level: 'WARNING', code: 'HEALTH_ENGINE_OFFLINE', message: 'Python health engine unavailable; telemetry is still being received.' }],
      derived: {},
      analysisError: String(err.message || err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...streamClients]) {
    try { res.write(frame); }
    catch (_) { streamClients.delete(res); }
  }
}

function normalizeTelemetry(raw, source = 'hardware') {
  const now = new Date();
  const sample = {
    deviceId: String(raw.deviceId || 'altitude-01'),
    ts: raw.ts || now.toISOString(),
    receivedAt: now.toISOString(),
    source,
    sensors: raw.sensors && typeof raw.sensors === 'object' ? raw.sensors : {},
    safety: raw.safety && typeof raw.safety === 'object' ? raw.safety : {},
    actuators: raw.actuators && typeof raw.actuators === 'object' ? raw.actuators : {},
  };
  return sample;
}

async function acceptTelemetry(raw, source) {
  if (source === 'hardware') lastHardwareAt = Date.now();
  const sample = normalizeTelemetry(raw, source);
  const analysis = await analyze(sample);
  const enriched = { ...sample, analysis };
  latest = enriched;
  history.push(enriched);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  broadcast('telemetry', enriched);
  return enriched;
}

function simulatedSample() {
  const t = Date.now() / 1000;
  const r = (a, b) => a + Math.random() * (b - a);
  return {
    deviceId: 'altitude-demo',
    sensors: {
      ambientTempC: -15 + Math.sin(t / 15) * 2,
      electronicsTempC: 31 + Math.sin(t / 8) * 3,
      coolantTempC: 18 + Math.sin(t / 11) * 1.5,
      humidityPct: 22 + Math.sin(t / 17) * 4,
      pressureHpa: 650 + Math.sin(t / 20) * 4,
      voltageV: 15.4 + r(-0.08, 0.08),
      currentA: 2.1 + r(-0.15, 0.15),
      waterLevelPct: 76 + Math.sin(t / 25) * 2,
    },
    safety: { eStop: false },
    actuators: { pump: true, peltier: false, fan: true },
  };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'altitude-node-gateway', latest: Boolean(latest) });
    }

    if (req.method === 'POST' && url.pathname === '/api/telemetry') {
      const raw = await readJson(req);
      const enriched = await acceptTelemetry(raw, 'hardware');
      return sendJson(res, 202, { ok: true, status: enriched.analysis.status, receivedAt: enriched.receivedAt });
    }

    if (req.method === 'GET' && url.pathname === '/api/latest') {
      if (!latest) return sendJson(res, 200, { data: null, connection: 'NO_DATA' });
      const ageMs = Date.now() - Date.parse(latest.receivedAt);
      return sendJson(res, 200, { data: latest, connection: ageMs <= STALE_MS ? 'LIVE' : 'STALE', ageMs });
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 120), MAX_HISTORY));
      return sendJson(res, 200, { data: history.slice(-limit) });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
      });
      res.write(': connected\n\n');
      if (latest) res.write(`event: telemetry\ndata: ${JSON.stringify(latest)}\n\n`);
      streamClients.add(res);
      req.on('close', () => streamClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || latest?.deviceId || 'altitude-01');
      const current = commands.get(deviceId) || { pump: null, peltier: null, fan: null };
      const next = {
        pump: typeof body.pump === 'boolean' ? body.pump : current.pump,
        peltier: typeof body.peltier === 'boolean' ? body.peltier : current.peltier,
        fan: typeof body.fan === 'boolean' ? body.fan : current.fan,
        updatedAt: new Date().toISOString(),
      };
      commands.set(deviceId, next);
      broadcast('command', { deviceId, command: next });
      return sendJson(res, 200, { ok: true, deviceId, command: next });
    }

    if (req.method === 'GET' && url.pathname === '/api/device/command') {
      const deviceId = String(url.searchParams.get('deviceId') || 'altitude-01');
      return sendJson(res, 200, { deviceId, command: commands.get(deviceId) || { pump: null, peltier: null, fan: null } });
    }

    if (req.method === 'POST' && url.pathname === '/api/simulate/once') {
      const enriched = await acceptTelemetry(simulatedSample(), 'simulation');
      return sendJson(res, 200, { ok: true, data: enriched });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }
});

// Keep the portal alive for judging even before hardware connects.
// Real ESP32 packets immediately take priority; demo data resumes only after 12 s without hardware.
setInterval(() => {
  if (Date.now() - lastHardwareAt > 12000) {
    acceptTelemetry(simulatedSample(), 'simulation').catch(() => {});
  }
}, 1000);

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, HOST, () => {
  console.log(`ALTITUDE Node gateway listening on http://${HOST}:${PORT}`);
  console.log(`Python analysis endpoint: ${PYTHON_URL}`);
});
