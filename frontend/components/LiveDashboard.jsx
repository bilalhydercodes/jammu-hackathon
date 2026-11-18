'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Prototype3D from './Prototype3D';
import Sparkline from './Sparkline';

function apiBase() {
  if (process.env.NEXT_PUBLIC_API_BASE) {
    let base = process.env.NEXT_PUBLIC_API_BASE.trim();
    return base.endsWith('/') ? base.slice(0, -1) : base;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    // When running standalone locally without Vercel routing (frontend on port 3000, backend on 8080)
    if ((host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.')) && window.location.port === '3000') {
      return `http://${host}:8080`;
    }
    // On Vercel (or when unified under reverse-proxy/rewrites), use same-origin relative paths (/api/...)
    return '';
  }
  return '';
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function value(v, suffix = '', digits = 1) { const x = n(v); return x === null ? '—' : `${x.toFixed(digits)}${suffix}`; }
function cls(status) {
  if (status === 'CRITICAL' || status === 'DEVICE ERROR' || status === 'ALERT') return 'critical status-error';
  if (status === 'WARNING' || status === 'STALE' || status === 'RECONNECTING') return 'warning status-reconnecting';
  if (status === 'CONNECTING' || status === 'WAITING FOR HARDWARE') return 'status-connecting';
  if (status === 'NORMAL' || status === 'LIVE' || status === 'CONNECTED') return 'normal status-connected';
  if (status === 'DISCONNECTED' || status === 'NO DATA') return 'neutral status-disconnected';
  return 'neutral';
}

function formatLastSeen(isoOrMs) {
  if (!isoOrMs) return 'Never';
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (isNaN(t) || t <= 0) return 'Never';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 2) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(t).toLocaleTimeString();
}

function Metric({ title, sensor, valueText, trend, note, highlightAlert = false }) {
  return (
    <article className={`metric-card ${highlightAlert ? 'metric-alert' : ''}`}>
      <div className="metric-top"><span>{title}</span><em>{sensor}</em></div>
      <strong style={highlightAlert ? { color: '#b92e25' } : {}}>{valueText}</strong>
      <Sparkline values={trend} />
      <small>{note}</small>
    </article>
  );
}

function StatePill({ on, onText = 'ON', offText = 'OFF', alertStyle = false }) {
  const isAlert = alertStyle && on;
  return (
    <span className={`state-pill ${on ? 'on' : 'off'}`} style={isAlert ? { color: '#b92e25' } : {}}>
      <i style={isAlert ? { background: '#b92e25', boxShadow: '0 0 0 3px #fde8e7' } : {}}></i>
      {on ? onText : offText}
    </span>
  );
}

export default function LiveDashboard() {
  const [telemetry, setTelemetry] = useState(null);
  const [history, setHistory] = useState([]);
  const [connection, setConnection] = useState('CONNECTING');
  const [deviceStatus, setDeviceStatus] = useState('DISCONNECTED');
  const [deviceInfo, setDeviceInfo] = useState({
    deviceId: 'altitude-01',
    model: 'ESP32-S3',
    lastSeen: null,
    ip: null,
    errorMessage: null,
  });
  const [, setTick] = useState(0);
  const [view, setView] = useState('overview');
  const [commandMsg, setCommandMsg] = useState('');
  const lastSeen = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const API = apiBase();
    let stopped = false;
    let es;
    let retry;

    // Strict: only accept real hardware telemetry
    const accept = data => {
      if (!data || stopped) return;
      if (data.source !== 'hardware') return;
      lastSeen.current = Date.now();
      setTelemetry(data);
      setConnection('LIVE');
      setHistory(h => [...h.slice(-179), data]);
    };

    if (!API) {
      setConnection('DISCONNECTED');
      return () => { stopped = true; };
    }

    // 1. Initial poll for latest real hardware telemetry
    fetch(`${API}/api/latest`, { cache: 'no-store' })
      .then(r => r.json())
      .then(x => {
        if (x.device) {
          setDeviceStatus(x.device.status || 'DISCONNECTED');
          setDeviceInfo(prev => ({ ...prev, ...x.device }));
        }
        if (x.data && x.data.source === 'hardware') {
          accept(x.data);
        } else {
          setConnection(c => c === 'LIVE' ? c : 'CONNECTED');
        }
      })
      .catch(() => {
        setConnection('DISCONNECTED');
      });

    // 2. Initial device status query
    fetch(`${API}/api/device/status`, { cache: 'no-store' })
      .then(r => r.json())
      .then(x => {
        if (x.device) {
          setDeviceStatus(x.device.status || 'DISCONNECTED');
          setDeviceInfo(prev => ({ ...prev, ...x.device }));
        }
      })
      .catch(() => {});

    // 3. Connect to live SSE stream for real hardware events
    const connect = () => {
      try {
        es = new EventSource(`${API}/api/stream`);
        es.addEventListener('device', e => {
          try {
            const dev = JSON.parse(e.data);
            if (dev && dev.status) {
              setDeviceStatus(dev.status);
              setDeviceInfo(prev => ({
                ...prev,
                deviceId: dev.deviceId || prev.deviceId,
                model: dev.model || prev.model,
                status: dev.status,
                lastSeen: dev.lastSeen || dev.lastSeenIso || prev.lastSeen,
                ip: dev.ip || prev.ip,
                errorMessage: dev.errorMessage,
              }));
            }
          } catch (err) {
            console.error('Error parsing device event', err);
          }
        });

        es.addEventListener('telemetry', e => {
          try {
            const sample = JSON.parse(e.data);
            if (sample && sample.source === 'hardware') {
              accept(sample);
            }
            if (sample && sample.device) {
              setDeviceStatus(sample.device.status || 'CONNECTED');
              setDeviceInfo(prev => ({
                ...prev,
                deviceId: sample.device.deviceId || prev.deviceId,
                model: sample.device.model || prev.model,
                lastSeen: sample.device.lastSeen || prev.lastSeen,
              }));
            }
          } catch (err) {
            console.error('Error parsing telemetry event', err);
          }
        });

        es.onopen = () => setConnection(c => c === 'LIVE' ? c : 'CONNECTED');
        es.onerror = () => {
          es?.close();
          setConnection('RECONNECTING');
          retry = setTimeout(connect, 4000);
        };
      } catch {
        setConnection('DISCONNECTED');
      }
    };
    connect();

    const staleTimer = setInterval(() => {
      if (lastSeen.current && Date.now() - lastSeen.current > 6000) {
        setConnection('STALE');
      }
    }, 1000);

    return () => {
      stopped = true;
      es?.close();
      clearTimeout(retry);
      clearInterval(staleTimer);
    };
  }, []);

  const s = telemetry?.sensors || {};
  const a = telemetry?.analysis || {};
  const alerts = Array.isArray(a.alerts) ? a.alerts : [];

  // Filter out disconnected or floating NTC readings (>80°C when DS18B20 are <35°C)
  const validDsTemps = [s.dsTemp1C, s.dsTemp2C, s.dsTemp3C].filter(x => typeof x === 'number' && Number.isFinite(x) && x > -50 && x < 125);
  const dsAvg = validDsTemps.length > 0 ? validDsTemps.reduce((a, b) => a + b, 0) / validDsTemps.length : null;
  const isNtcDisconnected = s.ntcStatus === 'DISCONNECTED' || (s.ntcTempC != null && ((s.ntcTempC <= -900) || (dsAvg !== null && s.ntcTempC > 80.0 && dsAvg < 35.0)));
  const validNtcTemp = isNtcDisconnected ? null : (typeof s.ntcTempC === 'number' && Number.isFinite(s.ntcTempC) && s.ntcTempC > -40 && s.ntcTempC < 120 ? s.ntcTempC : null);

  const realProbes = [...validDsTemps, validNtcTemp].filter(x => x !== null);
  const highestTemp = realProbes.length > 0 ? Math.max(...realProbes) : (typeof s.highestTempC === 'number' && s.highestTempC < 85.0 ? s.highestTempC : null);
  const isOverTemp = typeof highestTemp === 'number' && highestTemp >= 35.0;

  const trends = useMemo(() => ({
    highest: history.map(x => n(x.sensors?.highestTempC)).filter(x => x !== null && x < 85.0),
    ds1: history.map(x => n(x.sensors?.dsTemp1C)).filter(x => x !== null),
    ds2: history.map(x => n(x.sensors?.dsTemp2C)).filter(x => x !== null),
    ds3: history.map(x => n(x.sensors?.dsTemp3C)).filter(x => x !== null),
    ntc: history.map(x => n(x.sensors?.ntcTempC)).filter(x => x !== null && x < 85.0),
    water: history.map(x => n(x.sensors?.waterLevelPct)).filter(x => x !== null),
    waterAdc: history.map(x => n(x.sensors?.waterAdc)).filter(x => x !== null),
  }), [history]);

  async function control(key, state) {
    if (!apiBase()) {
      setCommandMsg('No gateway connection available');
      setTimeout(() => setCommandMsg(''), 2400);
      return;
    }

    try {
      const r = await fetch(`${apiBase()}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceInfo.deviceId || 'altitude-01', [key]: state }),
      });
      if (!r.ok) throw new Error('command rejected');
      setCommandMsg(`${key.toUpperCase()} ${state ? 'ON' : 'OFF'} command sent to ESP32 queue`);
      setTimeout(() => setCommandMsg(''), 2400);
    } catch {
      setCommandMsg(`Error sending command to gateway`);
      setTimeout(() => setCommandMsg(''), 2400);
    }
  }

  const source = telemetry?.source === 'hardware'
    ? 'REAL HARDWARE'
    : (deviceStatus === 'CONNECTED' ? 'WAITING FOR PACKETS' : 'AWAITING ESP32-S3');

  return (
    <div className="site-shell">
      <div className="topline"><div></div><div></div><div></div></div>
      <header className="site-header">
        <div className="brand-lockup">
          <div className="brand-mark"><span>A</span></div>
          <div>
            <div className="brand-super">Innovathon 2.0 @JU</div>
            <h1>SMART TEMP & PUMP SYSTEM</h1>
            <p>ESP32-S3 Real Hardware Live Monitoring (No Simulation)</p>
          </div>
        </div>
        <div className="header-status">
          <div><span>Gateway</span><strong className={cls(connection)}>{connection}</strong></div>
          <div><span>ESP32-S3</span><strong className={cls(deviceStatus)}>{deviceStatus}</strong></div>
          <div><span>Last Seen</span><strong>{formatLastSeen(deviceInfo.lastSeen)}</strong></div>
          <div><span>Telemetry</span><strong style={{ color: telemetry ? '#146c43' : '#956000' }}>{source}</strong></div>
          <div><span>Device</span><strong>{deviceInfo.deviceId || 'altitude-01'}</strong></div>
        </div>
      </header>

      <nav className="main-nav">
        {[
          ['overview', 'Live Dashboard'],
          ['prototype', '3D Digital Twin'],
          ['architecture', 'System Architecture'],
          ['alerts', 'Safety Events & Packets'],
        ].map(([key, label]) => (
          <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </nav>

      {/* UNIFIED REAL-DATA LIVE DASHBOARD */}
      {view === 'overview' && (
        <main className="content">
          {!telemetry && (
            <div style={{
              background: '#fff8e9',
              border: '1px solid #fedf9e',
              borderRadius: '4px',
              padding: '12px 18px',
              marginBottom: '16px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              color: '#825300',
              fontSize: '13px'
            }}>
              <span style={{ fontSize: '20px' }}>📡</span>
              <div>
                <strong>REAL HARDWARE MODE ONLY:</strong> Waiting for live sensor packet from ESP32-S3. All demo/simulated data has been removed. Values will populate automatically as soon as your device transmits.
              </div>
            </div>
          )}

          {/* 1. TOP LIVE SYSTEM STATUS BAR */}
          <section className="summary-band" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: '22px' }}>
            <div>
              <span>System Health</span>
              <strong style={{ color: isOverTemp ? '#af2d24' : (telemetry ? '#146c43' : '#657383') }}>
                {isOverTemp ? '🔥 OVER-TEMP' : (telemetry ? '✅ SAFE (NORMAL)' : 'WAITING FOR ESP32')}
              </strong>
            </div>
            <div>
              <span>Peak Temperature</span>
              <strong style={{ color: isOverTemp ? '#af2d24' : '#123b5d' }}>
                {value(highestTemp, ' °C')}
              </strong>
            </div>
            <div>
              <span>Safety Limit</span>
              <strong>35.0 °C</strong>
            </div>
            <div>
              <span>Cooling Actuators</span>
              <strong style={{ color: (telemetry?.actuators?.pump || telemetry?.actuators?.peltier) ? '#146c43' : '#657383' }}>
                {(telemetry?.actuators?.pump || telemetry?.actuators?.peltier) ? 'COOLING (ACTIVE)' : 'STANDBY (OFF)'}
              </strong>
            </div>
            <div>
              <span>Water Level</span>
              <strong>{value(s.waterLevelPct, ' %', 0)} ({s.waterAdc != null ? `ADC ${s.waterAdc}` : '—'})</strong>
            </div>
          </section>

          {/* 2. LIVE REAL SENSOR TELEMETRY */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <span className="section-kicker">Real-Time Measurements</span>
              <h3 style={{ margin: '4px 0 0', color: 'var(--navy2)', fontSize: '18px' }}>Physical Temperature & Water Sensors</h3>
            </div>
            <span className={`feed-chip ${telemetry?.source || 'none'}`}>{source}</span>
          </div>

          <section className="metrics-grid">
            <Metric
              title="DS18B20 Probe 1"
              sensor="1-Wire GPIO 4"
              valueText={value(s.dsTemp1C, ' °C')}
              trend={trends.ds1}
              note="Digital Probe #1 (Real Hardware)"
            />
            <Metric
              title="DS18B20 Probe 2"
              sensor="1-Wire GPIO 4"
              valueText={value(s.dsTemp2C, ' °C')}
              trend={trends.ds2}
              note="Digital Probe #2 (Real Hardware)"
            />
            <Metric
              title="DS18B20 Probe 3"
              sensor="1-Wire GPIO 4"
              valueText={value(s.dsTemp3C, ' °C')}
              trend={trends.ds3}
              note="Digital Probe #3 (Real Hardware)"
            />
            <Metric
              title="NTC 10K Thermistor"
              sensor="Analog GPIO 1"
              valueText={isNtcDisconnected ? 'DISCONNECTED' : value(s.ntcTempC, ' °C')}
              trend={trends.ntc}
              note={isNtcDisconnected ? 'Pin unattached / floating' : 'Steinhart-Hart B=3950'}
              highlightAlert={false}
            />
            <Metric
              title="Reservoir Water Level"
              sensor="Analog GPIO 5"
              valueText={value(s.waterLevelPct, ' %', 0)}
              trend={trends.water}
              note={`Raw ADC: ${s.waterAdc != null ? s.waterAdc : '0'} / 4095`}
            />
          </section>

          {/* 3. ACTUATORS & HARDWARE CONTROLS */}
          <section className="control-layout" style={{ marginTop: '22px' }}>
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">Hardware Actuators</span>
                  <h3>Reported Physical States</h3>
                </div>
                <span>{telemetry?.receivedAt ? new Date(telemetry.receivedAt).toLocaleTimeString() : '—'}</span>
              </div>
              <div className="state-table">
                <div>
                  <span>Peak Measured Temperature</span>
                  <strong style={{ color: isOverTemp ? '#af2d24' : '#123b5d' }}>
                    {value(highestTemp, ' °C')} (Threshold: 35.0 °C)
                  </strong>
                </div>
                <div>
                  <span>Water Pump (IRF520 SIG, GPIO 12)</span>
                  <StatePill on={telemetry?.actuators?.pump} onText="RUNNING" offText="OFF" />
                </div>
                <div>
                  <span>Peltier Cooler (Relay, GPIO 13)</span>
                  <StatePill on={telemetry?.actuators?.peltier} onText="COOLING" offText="OFF" />
                </div>
                <div>
                  <span>Buzzer Alarm (GPIO 17)</span>
                  <StatePill on={telemetry?.actuators?.buzzer} onText="ACTIVE" offText="SILENT" alertStyle />
                </div>
                <div>
                  <span>Normal LED (GPIO 35)</span>
                  <StatePill on={telemetry?.actuators?.normalLed} onText="ON" offText="OFF" />
                </div>
                <div>
                  <span>Red Alert LED (GPIO 38)</span>
                  <StatePill on={telemetry?.actuators?.redLed} onText="ON (ALERT)" offText="OFF" alertStyle />
                </div>
                <div>
                  <span>Green Safe LED (GPIO 39)</span>
                  <StatePill on={telemetry?.actuators?.greenLed} onText="ON (SAFE)" offText="OFF" />
                </div>
                <div>
                  <span>Blue Wi-Fi LED (GPIO 40)</span>
                  <StatePill on={telemetry?.actuators?.blueLed} onText="CONNECTED" offText="OFF" />
                </div>
                <div>
                  <span>Water Level Sensor ADC</span>
                  <strong>{s.waterAdc != null ? `${s.waterAdc} / 4095 (${value(s.waterLevelPct, '%', 0)})` : '0 / 4095 (0%)'}</strong>
                </div>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">Actuator Testing</span>
                  <h3>Manual Hardware Overrides</h3>
                </div>
                <span>ESP32 Control Bus</span>
              </div>
              <div className="safety-note">
                <b>Autonomous Safety Interlock:</b> When peak temperature reaches &ge; 35.0 °C, the ESP32 safety controller autonomously activates cooling (Pump, Peltier, Buzzer, Red LED) regardless of manual settings.
              </div>
              {[
                ['pump', 'Water Pump (IRF520 GPIO 12)'],
                ['peltier', 'Peltier Cooler (Relay GPIO 13)'],
                ['buzzer', 'Audible Alarm Buzzer (GPIO 17)'],
              ].map(([key, label]) => (
                <div className="command-row" key={key}>
                  <span>{label}</span>
                  <button onClick={() => control(key, true)}>ON</button>
                  <button className="outline" onClick={() => control(key, false)}>OFF</button>
                </div>
              ))}
              {commandMsg && <div className="command-msg">{commandMsg}</div>}
            </article>
          </section>
        </main>
      )}

      {/* 3D PROTOTYPE TAB */}
      {view === 'prototype' && (
        <main className="content">
          <Prototype3D telemetry={telemetry} />
        </main>
      )}

      {/* ARCHITECTURE TAB */}
      {view === 'architecture' && (
        <main className="content">
          <section className="page-title">
            <div>
              <span className="eyebrow">Data + Protection Architecture</span>
              <h2>How the System Works</h2>
              <p>Hardware acquisition, autonomous local safety loops, and Wi-Fi streaming to the monitoring portal.</p>
            </div>
          </section>
          <section className="architecture-flow">
            <div className="arch-node">
              <span>01</span>
              <b>Sensors</b>
              <small>3x DS18B20 (GPIO 4) · 10K NTC (GPIO 1) · Water Level (GPIO 5)</small>
            </div>
            <i>→</i>
            <div className="arch-node emphasis">
              <span>02</span>
              <b>ESP32-S3</b>
              <small>Multi-sensor acquisition · 35.0°C safety loop · Wi-Fi telemetry</small>
            </div>
            <i>→</i>
            <div className="arch-node">
              <span>03</span>
              <b>Node.js Gateway</b>
              <small>HTTP ingest (/api/telemetry) · SSE push · Command queue</small>
            </div>
            <i>→</i>
            <div className="arch-node">
              <span>04</span>
              <b>Python Health Engine</b>
              <small>Threshold analysis · Multi-probe anomaly detection</small>
            </div>
            <i>→</i>
            <div className="arch-node emphasis">
              <span>05</span>
              <b>Next.js Portal</b>
              <small>Real-time live monitoring · 3D model · Manual controls</small>
            </div>
          </section>

          <section className="architecture-cards">
            <article className="panel">
              <div className="panel-heading"><h3>Temperature Supervision</h3></div>
              <p>Three Dallas DS18B20 probes on 1-Wire (GPIO 4) and one 10k NTC thermistor on ADC (GPIO 1) continuously supervise critical points.</p>
            </article>
            <article className="panel">
              <div className="panel-heading"><h3>Autonomous Protection</h3></div>
              <p>If any probe exceeds 35.0 °C, the ESP32 safety controller directly energizes the IRF520 cooling pump (GPIO 12), turns on the Buzzer (GPIO 17), and lights the Red LED (GPIO 38).</p>
            </article>
            <article className="panel">
              <div className="panel-heading"><h3>Coolant & Status Indication</h3></div>
              <p>The analog water level sensor monitors reservoir volume. Green LED indicates normal operation, while Blue LED signals Wi-Fi and cloud telemetry sync.</p>
            </article>
          </section>

          <section className="packet-panel panel">
            <div className="panel-heading">
              <div><span className="section-kicker">Live Packet</span><h3>ESP32 → Gateway JSON Payload</h3></div>
              <span>JSON · Real Hardware</span>
            </div>
            <pre>
              {JSON.stringify(
                telemetry
                  ? {
                      deviceId: telemetry.deviceId,
                      source: telemetry.source,
                      sensors: telemetry.sensors,
                      actuators: telemetry.actuators,
                    }
                  : {
                      deviceId: 'altitude-01',
                      status: 'WAITING FOR ESP32-S3 TELEMETRY PACKET',
                      note: 'Real hardware mode active. Power on your ESP32-S3 to stream live data.',
                    },
                null,
                2
              )}
            </pre>
          </section>
        </main>
      )}

      {/* EVENTS & ALERTS TAB */}
      {view === 'alerts' && (
        <main className="content">
          <section className="page-title">
            <div>
              <span className="eyebrow">System Events</span>
              <h2>Alerts & Telemetry History</h2>
              <p>Logged events and recent packets received from the ESP32-S3 controller.</p>
            </div>
          </section>

          <section className="panel alerts-panel">
            <div className="panel-heading">
              <div><h3>Active Alerts</h3><span>{alerts.length} current</span></div>
            </div>
            {alerts.length === 0 && !isOverTemp ? (
              <div className="empty-alert">
                <b>All Systems Normal</b>
                <span>
                  {telemetry
                    ? 'All temperature probes are below the 35.0 °C limit and the water level is sufficient.'
                    : 'Awaiting incoming sensor telemetry from ESP32-S3...'}
                </span>
              </div>
            ) : (
              <div>
                {isOverTemp && (
                  <div className="alert-item critical">
                    <b>CRITICAL</b>
                    <div>
                      <strong>OVER_TEMPERATURE_ALERT</strong>
                      <span>Peak temperature ({value(highestTemp, '°C')}) exceeded safety limit (35.0 °C)! Pump & Buzzer activated.</span>
                    </div>
                    <em>{value(highestTemp, ' °C')}</em>
                  </div>
                )}
                {alerts.map((x, i) => (
                  <div className={`alert-item ${cls(x.level)}`} key={`${x.code}-${i}`}>
                    <b>{x.level}</b>
                    <div>
                      <strong>{x.code}</strong>
                      <span>{x.message}</span>
                    </div>
                    <em>{x.value == null ? '' : String(x.value)}</em>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel packet-history">
            <div className="panel-heading">
              <div><h3>Recent Real Hardware Packets</h3><span>Latest readings</span></div>
            </div>
            <div className="packet-head" style={{ gridTemplateColumns: '110px 100px 90px 90px 90px 90px 100px 80px 1fr' }}>
              <span>Time</span>
              <span>Highest</span>
              <span>DS #1</span>
              <span>DS #2</span>
              <span>DS #3</span>
              <span>NTC</span>
              <span>Water ADC</span>
              <span>Pump</span>
              <span>Status</span>
            </div>
            {history.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#687582', fontSize: '12px' }}>
                No hardware packets received yet. Power on your ESP32-S3 to start logging live telemetry.
              </div>
            ) : (
              [...history].reverse().slice(0, 20).map((x, i) => {
                const hTemp = x.sensors?.highestTempC ?? x.sensors?.electronicsTempC;
                const isOver = x.sensors?.overTemp || (hTemp != null && hTemp > 35.0);
                return (
                  <div className="packet-row" key={`${x.receivedAt}-${i}`} style={{ gridTemplateColumns: '110px 100px 90px 90px 90px 90px 100px 80px 1fr' }}>
                    <span>{x.receivedAt ? new Date(x.receivedAt).toLocaleTimeString() : '—'}</span>
                    <span style={{ fontWeight: 700, color: isOver ? '#b92e25' : '#123b5d' }}>{value(hTemp, ' °C')}</span>
                    <span>{value(x.sensors?.dsTemp1C, ' °C')}</span>
                    <span>{value(x.sensors?.dsTemp2C, ' °C')}</span>
                    <span>{value(x.sensors?.dsTemp3C, ' °C')}</span>
                    <span>{value(x.sensors?.ntcTempC ?? x.sensors?.coolantTempC, ' °C')}</span>
                    <span>{x.sensors?.waterAdc != null ? x.sensors?.waterAdc : '—'}</span>
                    <span>{x.actuators?.pump ? 'ON' : 'OFF'}</span>
                    <span className={cls(isOver ? 'CRITICAL' : (x.analysis?.status || 'NORMAL'))}>
                      {isOver ? 'OVER-TEMP' : (x.analysis?.status || 'NORMAL')}
                    </span>
                  </div>
                );
              })
            )}
          </section>
        </main>
      )}

      <footer>
        <div><b>SMART TEMP & PUMP SYSTEM</b> · ESP32-S3 Live Thermal Controller</div>
        <div>Real Hardware Mode · Simulation Disabled</div>
      </footer>
    </div>
  );
}
