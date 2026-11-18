'use strict';

try {
  require('dotenv').config();
} catch (_) {}

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

function getPythonAnalyzeUrl() {
  const base = process.env.PYTHON_SERVICE_URL || process.env.PYTHON_URL || 'http://127.0.0.1:8000';
  if (base.endsWith('/analyze')) return base;
  return new URL('analyze', base.endsWith('/') ? base : `${base}/`).toString();
}

const MAX_HISTORY = Number(process.env.MAX_HISTORY || 600);
const STALE_MS = Number(process.env.STALE_MS || 5000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 7000);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'altitude';

let latest = null;
let lastHardwareAt = 0;
const history = [];
const streamClients = new Set();
const commands = new Map();
const devices = new Map();

// --- MongoDB Database State ---
let mongoClient = null;
let mongoDb = null;
let colTelemetry = null;
let colDevices = null;
let colHeartbeats = null;
let colAlerts = null;

async function initMongo() {
  if (!MONGODB_URI) {
    console.log('[MongoDB] No MONGODB_URI configured; operating in-memory.');
    return;
  }
  try {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGODB_DB);
    colTelemetry = mongoDb.collection('telemetry');
    colDevices = mongoDb.collection('devices');
    colHeartbeats = mongoDb.collection('heartbeats');
    colAlerts = mongoDb.collection('alerts');

    colTelemetry.createIndex({ receivedAt: -1 }).catch(() => {});
    colTelemetry.createIndex({ deviceId: 1, receivedAt: -1 }).catch(() => {});
    colDevices.createIndex({ deviceId: 1 }, { unique: true }).catch(() => {});

    console.log(`[MongoDB] Connected successfully to Atlas database: ${MONGODB_DB}`);

    // Preload recent real hardware history from DB into memory
    const recent = await colTelemetry.find({ source: 'hardware' }).sort({ receivedAt: -1 }).limit(MAX_HISTORY).toArray();
    if (recent.length > 0) {
      recent.reverse().forEach(doc => {
        delete doc._id;
        history.push(doc);
      });
      latest = history[history.length - 1];
      console.log(`[MongoDB] Preloaded ${recent.length} recent telemetry records from database.`);
    }

    // Preload registered devices
    const storedDevices = await colDevices.find({}).toArray();
    for (const d of storedDevices) {
      delete d._id;
      d.status = 'DISCONNECTED';
      devices.set(d.deviceId, d);
    }
  } catch (err) {
    console.error('[MongoDB] Connection error (continuing with in-memory buffer):', err.message);
  }
}

function persistTelemetry(sample) {
  if (!colTelemetry) return;
  colTelemetry.insertOne({ ...sample, createdAt: new Date() }).catch(err => {
    console.error('[MongoDB] Error saving telemetry:', err.message);
  });
  if (sample.analysis?.alerts?.length > 0 && colAlerts) {
    colAlerts.insertMany(sample.analysis.alerts.map(a => ({
      ...a,
      deviceId: sample.deviceId,
      receivedAt: sample.receivedAt,
      createdAt: new Date(),
    }))).catch(() => {});
  }
}

function persistDevice(dev) {
  if (!colDevices) return;
  colDevices.updateOne(
    { deviceId: dev.deviceId },
    { $set: { ...dev, updatedAt: new Date() } },
    { upsert: true }
  ).catch(err => {
    console.error('[MongoDB] Error saving device:', err.message);
  });
}

function persistHeartbeat(hb) {
  if (!colHeartbeats) return;
  colHeartbeats.insertOne({ ...hb, createdAt: new Date() }).catch(() => {});
}

function getPrimaryDevice() {
  if (devices.size > 0) {
    let newest = null;
    for (const dev of devices.values()) {
      if (!newest || dev.lastSeen > newest.lastSeen) {
        newest = dev;
      }
    }
    const ageMs = newest.lastSeen ? Date.now() - newest.lastSeen : null;
    return {
      ...newest,
      ageMs,
    };
  }
  return {
    deviceId: 'altitude-01',
    model: 'ESP32-S3',
    status: 'DISCONNECTED',
    lastSeen: null,
    lastSeenIso: null,
    ageMs: null,
    ip: null,
    registeredAt: null,
  };
}

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

function localAnalyze(payload) {
  const sensors = payload.sensors || {};
  const safety = payload.safety || {};
  const actuators = payload.actuators || {};

  const alerts = [];
  let severity = 0;
  let deductions = 0;

  function flag(level, code, message, value = null) {
    severity = Math.max(severity, level);
    deductions += level === 1 ? 12 : 30;
    alerts.push({ level: level === 1 ? 'WARNING' : 'CRITICAL', code, message, value });
  }

  const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };

  const ambient = num(sensors.ambientTempC);
  const electronics = num(sensors.electronicsTempC);
  const coolant = num(sensors.coolantTempC);
  const water = num(sensors.waterLevelPct);
  const voltage = num(sensors.voltageV);
  const current = num(sensors.currentA);
  let power = num(sensors.powerW);

  let highest = num(sensors.highestTempC);
  if (highest === null) {
    const cands = [num(sensors.dsTemp1C), num(sensors.dsTemp2C), num(sensors.dsTemp3C), num(sensors.ntcTempC), electronics].filter(x => x !== null);
    if (cands.length > 0) highest = Math.max(...cands);
  }

  const tempLimit = num(sensors.tempLimitC) || 35.0;
  if (highest !== null) {
    if (highest > tempLimit + 5.0) {
      flag(2, 'EXTREME_OVERHEAT', `Peak temperature (${highest.toFixed(1)}°C) severely exceeds safety limit (${tempLimit.toFixed(1)}°C)! Emergency cooling active.`, highest);
    } else if (highest > tempLimit) {
      flag(2, 'OVER_TEMPERATURE_ALERT', `Peak temperature (${highest.toFixed(1)}°C) exceeded safety limit (${tempLimit.toFixed(1)}°C)! Water pump & buzzer activated.`, highest);
    } else if (highest >= tempLimit - 2.5) {
      flag(1, 'TEMPERATURE_APPROACHING_LIMIT', `Peak temperature (${highest.toFixed(1)}°C) is nearing safety threshold (${tempLimit.toFixed(1)}°C).`, highest);
    }
  }

  if (ambient !== null) {
    if (ambient <= -35) flag(2, 'AMBIENT_EXTREME_COLD', 'Ambient temperature is below the configured critical limit.', ambient);
    else if (ambient <= -20) flag(1, 'AMBIENT_COLD', 'Ambient temperature is below the configured warning limit.', ambient);
  }

  if (electronics !== null) {
    if (electronics >= 80) flag(2, 'ELECTRONICS_OVERHEAT', 'Protected electronics temperature is critically high.', electronics);
    else if (electronics >= 65) flag(1, 'ELECTRONICS_HOT', 'Protected electronics temperature is elevated.', electronics);
  }

  if (water !== null) {
    if (water <= 20) flag(2, 'COOLANT_LOW', 'Coolant/water level is below the critical limit; cooling must be inhibited.', water);
    else if (water <= 35) flag(1, 'COOLANT_LEVEL_WARNING', 'Coolant/water level is low.', water);
  }

  if (voltage !== null) {
    if (voltage <= 12.0 || voltage >= 16.9) flag(2, 'BATTERY_VOLTAGE_CRITICAL', 'Battery/bus voltage is outside the configured critical range.', voltage);
    else if (voltage <= 12.8) flag(1, 'BATTERY_VOLTAGE_LOW', 'Battery/bus voltage is below the configured warning level.', voltage);
  }

  if (safety.eStop === true) {
    flag(2, 'E_STOP', 'Emergency stop is active; high-power actuators must remain de-energized.', true);
  }

  const coolingInhibited = Boolean(safety.eStop) || (water !== null && water <= 20);
  if (coolingInhibited && (actuators.pump === true || actuators.peltier === true)) {
    flag(2, 'INTERLOCK_MISMATCH', 'Cooling actuator is reported ON while a safety interlock requires it OFF.', true);
  }

  if (power === null && voltage !== null && current !== null) {
    power = voltage * current;
  }

  const pressure = num(sensors.pressureHpa);
  let approxAltitude = null;
  if (pressure !== null && pressure > 0) {
    approxAltitude = 44330.0 * (1.0 - Math.pow(pressure / 1013.25, 0.1903));
  }

  const status = severity === 0 ? 'NORMAL' : severity === 1 ? 'WARNING' : 'CRITICAL';
  const healthScore = Math.max(0, 100 - deductions);

  return {
    status,
    healthScore,
    alerts,
    derived: {
      powerW: power !== null ? Number(power.toFixed(3)) : null,
      approxAltitudeM: approxAltitude !== null ? Number(approxAltitude.toFixed(1)) : null,
      coolingInhibited,
    },
    analyzedAt: new Date().toISOString(),
  };
}

async function analyze(sample) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  const targetUrl = getPythonAnalyzeUrl();
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`python ${response.status}`);
    return await response.json();
  } catch (err) {
    return localAnalyze(sample);
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

async function acceptTelemetry(raw, source = 'hardware') {
  if (source !== 'hardware') return null;
  lastHardwareAt = Date.now();
  const sample = normalizeTelemetry(raw, 'hardware');
  const analysis = await analyze(sample);
  const enriched = { ...sample, analysis };
  latest = enriched;
  history.push(enriched);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  broadcast('telemetry', enriched);

  // Persist real hardware telemetry to MongoDB
  persistTelemetry(enriched);

  return enriched;
}



const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'altitude-node-gateway',
        latest: Boolean(latest),
        mongodb: Boolean(mongoDb),
        database: MONGODB_DB,
        device: getPrimaryDevice(),
      });
    }

    // --- MongoDB Status & Stats ---
    if (req.method === 'GET' && url.pathname === '/api/db/status') {
      const stats = {
        connected: Boolean(mongoDb),
        database: MONGODB_DB,
        collections: mongoDb ? {
          telemetry: await colTelemetry?.countDocuments().catch(() => 0),
          devices: await colDevices?.countDocuments().catch(() => 0),
          heartbeats: await colHeartbeats?.countDocuments().catch(() => 0),
          alerts: await colAlerts?.countDocuments().catch(() => 0),
        } : null,
      };
      return sendJson(res, 200, { ok: true, ...stats });
    }

    // --- ESP32-S3 Device Registration ---
    if (req.method === 'POST' && url.pathname === '/api/device/register') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || 'altitude-01');
      const model = String(body.model || 'ESP32-S3');
      const now = Date.now();
      const nowIso = new Date().toISOString();

      let status = 'CONNECTED';
      if (body.hasError) {
        status = 'DEVICE ERROR';
      } else if (body.status && ['CONNECTING', 'CONNECTED', 'RECONNECTING', 'DEVICE ERROR'].includes(body.status)) {
        status = body.status === 'CONNECTING' ? 'CONNECTED' : body.status;
      }

      const existing = devices.get(deviceId);
      const isUpdate = Boolean(existing);

      const deviceRecord = {
        deviceId,
        model,
        status,
        ip: body.ip || req.socket.remoteAddress,
        mac: body.mac || null,
        firmware: body.firmware || '2.0.0-s3',
        registeredAt: existing?.registeredAt || nowIso,
        lastSeen: now,
        lastSeenIso: nowIso,
        sensors: body.sensors || {},
        hasError: Boolean(body.hasError),
        errorMessage: body.errorMessage || null,
      };

      devices.set(deviceId, deviceRecord);
      lastHardwareAt = now;

      // Persist to MongoDB
      persistDevice(deviceRecord);

      console.log(`[Device] ${isUpdate ? 'Re-registered' : 'Registered'}: ${deviceId} (${model}) at ${deviceRecord.ip} -> Status: ${status}`);

      broadcast('device', { ...deviceRecord, ageMs: 0 });

      return sendJson(res, 200, {
        ok: true,
        deviceId,
        status: deviceRecord.status,
        serverTime: now,
        heartbeatIntervalMs: 3000,
      });
    }

    // --- ESP32-S3 Periodic Heartbeat ---
    if (req.method === 'POST' && url.pathname === '/api/device/heartbeat') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || 'altitude-01');
      const now = Date.now();
      const nowIso = new Date().toISOString();

      let dev = devices.get(deviceId);
      if (!dev) {
        dev = {
          deviceId,
          model: String(body.model || 'ESP32-S3'),
          status: 'CONNECTED',
          ip: body.ip || req.socket.remoteAddress,
          registeredAt: nowIso,
          firmware: body.firmware || '2.0.0-s3',
        };
        devices.set(deviceId, dev);
      }

      let status = 'CONNECTED';
      if (body.hasError) {
        status = 'DEVICE ERROR';
      } else if (body.status && ['CONNECTING', 'CONNECTED', 'RECONNECTING', 'DEVICE ERROR'].includes(body.status)) {
        status = body.status;
      }

      dev.status = status;
      dev.lastSeen = now;
      dev.lastSeenIso = nowIso;
      dev.uptimeMs = body.uptimeMs;
      dev.wifiRssi = body.wifiRssi;
      dev.errorMessage = body.errorMessage || null;
      lastHardwareAt = now;

      // Persist to MongoDB
      persistDevice(dev);
      persistHeartbeat({
        deviceId,
        uptimeMs: body.uptimeMs,
        wifiRssi: body.wifiRssi,
        status: dev.status,
        timestamp: new Date(),
      });

      broadcast('device', { ...dev, ageMs: 0 });

      const pendingCommand = commands.get(deviceId) || { pump: null, buzzer: null, peltier: null, fan: null };
      return sendJson(res, 200, {
        ok: true,
        deviceId,
        status: dev.status,
        command: pendingCommand,
        serverTime: now,
      });
    }

    // --- Query Device Status ---
    if (req.method === 'GET' && (url.pathname === '/api/device/status' || url.pathname === '/api/devices')) {
      const primary = getPrimaryDevice();
      const all = Array.from(devices.values());
      return sendJson(res, 200, { ok: true, device: primary, devices: all });
    }

    // --- Manual or Device Status Transition ---
    if (req.method === 'POST' && url.pathname === '/api/device/status') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || 'altitude-01');
      let dev = devices.get(deviceId);
      if (dev && body.status) {
        dev.status = body.status;
        dev.lastSeen = Date.now();
        dev.lastSeenIso = new Date().toISOString();
        if (body.errorMessage) dev.errorMessage = body.errorMessage;
        persistDevice(dev);
        broadcast('device', { ...dev, ageMs: 0 });
        return sendJson(res, 200, { ok: true, device: dev });
      }
      return sendJson(res, 400, { error: 'unknown device or missing status' });
    }

    // --- Telemetry Ingest ---
    if (req.method === 'POST' && url.pathname === '/api/telemetry') {
      const raw = await readJson(req);
      const deviceId = String(raw.deviceId || 'altitude-01');
      const model = String(raw.model || 'ESP32-S3');
      const now = Date.now();
      const nowIso = new Date().toISOString();

      let dev = devices.get(deviceId);
      if (!dev) {
        dev = {
          deviceId,
          model,
          status: 'CONNECTED',
          ip: req.socket.remoteAddress,
          registeredAt: nowIso,
          firmware: '2.0.0-s3',
        };
        devices.set(deviceId, dev);
      }

      dev.lastSeen = now;
      dev.lastSeenIso = nowIso;
      if (raw.deviceStatus && ['CONNECTING', 'CONNECTED', 'RECONNECTING', 'DEVICE ERROR'].includes(raw.deviceStatus)) {
        dev.status = raw.deviceStatus;
      } else if (dev.status === 'DISCONNECTED' || dev.status === 'RECONNECTING') {
        dev.status = 'CONNECTED';
      }

      const enriched = await acceptTelemetry(raw, 'hardware');
      enriched.device = {
        deviceId: dev.deviceId,
        model: dev.model,
        status: dev.status,
        lastSeen: dev.lastSeenIso,
      };

      persistDevice(dev);
      broadcast('device', { ...dev, ageMs: 0 });

      return sendJson(res, 202, {
        ok: true,
        status: enriched.analysis.status,
        receivedAt: enriched.receivedAt,
        deviceStatus: dev.status,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/latest') {
      const primary = getPrimaryDevice();
      if (!latest || latest.source !== 'hardware') return sendJson(res, 200, { data: null, device: primary, connection: 'NO_DATA' });
      const ageMs = Date.now() - Date.parse(latest.receivedAt);
      return sendJson(res, 200, {
        data: latest,
        device: primary,
        connection: ageMs <= STALE_MS ? 'LIVE' : 'STALE',
        ageMs,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 120), MAX_HISTORY));
      const fromDb = url.searchParams.get('source') === 'db';

      if (fromDb && colTelemetry) {
        const docs = await colTelemetry.find({ source: 'hardware' }).sort({ receivedAt: -1 }).limit(limit).toArray();
        docs.forEach(d => delete d._id);
        return sendJson(res, 200, { data: docs.reverse(), source: 'mongodb' });
      }

      const realHistory = history.filter(h => h.source === 'hardware');
      return sendJson(res, 200, { data: realHistory.slice(-limit), source: 'memory' });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
      });
      res.write(': connected\n\n');
      const primary = getPrimaryDevice();
      res.write(`event: device\ndata: ${JSON.stringify(primary)}\n\n`);
      if (latest && latest.source === 'hardware') res.write(`event: telemetry\ndata: ${JSON.stringify(latest)}\n\n`);
      streamClients.add(res);
      req.on('close', () => streamClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || latest?.deviceId || 'altitude-01');
      const current = commands.get(deviceId) || { pump: null, buzzer: null, peltier: null, fan: null };
      const next = {
        pump: typeof body.pump === 'boolean' ? body.pump : current.pump,
        buzzer: typeof body.buzzer === 'boolean' ? body.buzzer : current.buzzer,
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
      return sendJson(res, 400, { ok: false, error: 'Simulation disabled. Real hardware only.' });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }
});

// Periodic heartbeat timeout monitor (7 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [id, dev] of devices.entries()) {
    if (dev.status === 'CONNECTED' && now - dev.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      dev.status = 'DISCONNECTED';
      console.log(`[Device] ${dev.deviceId} (${dev.model}) heartbeat timed out (${now - dev.lastSeen}ms) -> DISCONNECTED`);
      persistDevice(dev);
      broadcast('device', { ...dev, ageMs: now - dev.lastSeen });
    }
  }
}, 1000);



server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Initialize MongoDB then start listening
initMongo().finally(() => {
  server.listen(PORT, HOST, () => {
    console.log(`ALTITUDE Node gateway listening on http://${HOST}:${PORT}`);
    console.log(`Python analysis endpoint: ${getPythonAnalyzeUrl()}`);
  });
});

module.exports = server;
