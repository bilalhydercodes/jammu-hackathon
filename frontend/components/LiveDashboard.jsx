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

  // Compute highest temp from real sensors (null if no data yet)
  const highestTemp = s.highestTempC ?? s.electronicsTempC ?? (
    [s.dsTemp1C, s.dsTemp2C, s.dsTemp3C, s.ntcTempC].filter(x => typeof x === 'number' && Number.isFinite(x)).length > 0
      ? Math.max(...[s.dsTemp1C, s.dsTemp2C, s.dsTemp3C, s.ntcTempC].filter(x => typeof x === 'number' && Number.isFinite(x)))
      : null
  );
  const isOverTemp = s.overTemp || (typeof highestTemp === 'number' && highestTemp > 35.0);

  const trends = useMemo(() => ({
    highest: history.map(x => n(x.sensors?.highestTempC ?? x.sensors?.electronicsTempC)).filter(x => x !== null),
    ds1: history.map(x => n(x.sensors?.dsTemp1C)).filter(x => x !== null),
    ds2: history.map(x => n(x.sensors?.dsTemp2C)).filter(x => x !== null),
    ds3: history.map(x => n(x.sensors?.dsTemp3C)).filter(x => x !== null),
    ntc: history.map(x => n(x.sensors?.ntcTempC ?? x.sensors?.coolantTempC)).filter(x => x !== null),
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
          ['overview', 'Overview'],
          ['monitor', 'Live Monitoring'],
          ['prototype', '3D Prototype'],
          ['architecture', 'System Architecture'],
          ['alerts', 'Events & Alerts'],
        ].map(([key, label]) => (
          <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </nav>

      {/* OVERVIEW TAB */}
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

          <section className="hero-grid">
            <div className="hero-copy">
              <div className="eyebrow">Smart Thermal Protection System</div>
              <h2>Multi-probe thermal supervisor with automated pump protection.</h2>
              <p>
                Continuous acquisition from three DS18B20 digital probes and an NTC thermistor tracks peak temperature across critical electronics.
                When the temperature exceeds 35.0 °C, the ESP32 safety controller autonomously activates the IRF520 cooling pump, triggers the buzzer alarm, and switches status LEDs.
              </p>
              <div className="hero-actions">
                <button className="primary" onClick={() => setView('monitor')}>View Live Monitoring</button>
                <button onClick={() => setView('prototype')}>Open 3D Model</button>
              </div>
              <div className="hero-facts">
                <div><strong>{value(highestTemp, ' °C')}</strong><span>Highest Temp</span></div>
                <div><strong>35.0 °C</strong><span>Temp Limit</span></div>
                <div><strong>{value(s.waterLevelPct, ' %', 0)}</strong><span>Water Level</span></div>
                <div>
                  <strong style={{ color: isOverTemp ? '#b92e25' : (telemetry ? '#146c43' : '#687582') }}>
                    {isOverTemp ? '🔥 ALERT' : (telemetry ? '✅ SAFE' : 'NO DATA')}
                  </strong>
                  <span>System Health</span>
                </div>
              </div>
            </div>
            <div className="hero-preview" onClick={() => setView('prototype')}>
              <div className="preview-copy">
                <span>Interactive Hardware</span>
                <strong>Explore the Thermal Setup</strong>
                <small>3x DS18B20 · NTC 10K · IRF520 Pump · Buzzer · Water Level</small>
              </div>
              <div className="proto-illustration" aria-hidden="true">
                <div className="case"><i></i><i></i><i></i><i></i><b></b></div>
                <div className="radiator"></div><div className="reservoir"></div>
              </div>
            </div>
          </section>

          <section className="summary-band">
            <div>
              <span>System Status</span>
              <strong className={cls(isOverTemp ? 'CRITICAL' : (a.status || (telemetry ? 'NORMAL' : 'NO DATA')))}>
                {isOverTemp ? '🔥 OVER-TEMP' : (a.status || (telemetry ? 'NORMAL' : 'WAITING'))}
              </strong>
            </div>
            <div><span>Highest Temp</span><strong>{value(highestTemp, ' °C')}</strong></div>
            <div><span>DS Sensor 1</span><strong>{value(s.dsTemp1C, ' °C')}</strong></div>
            <div><span>DS Sensor 2</span><strong>{value(s.dsTemp2C, ' °C')}</strong></div>
            <div><span>DS Sensor 3</span><strong>{value(s.dsTemp3C, ' °C')}</strong></div>
            <div><span>NTC Temp</span><strong>{value(s.ntcTempC ?? s.coolantTempC, ' °C')}</strong></div>
            <div><span>Water Level</span><strong>{value(s.waterLevelPct, ' %', 0)}</strong></div>
            <div><span>Water Pump</span><strong>{telemetry?.actuators?.pump ? 'RUNNING' : (telemetry ? 'OFF' : '—')}</strong></div>
          </section>

          <section className="overview-columns">
            <article className="panel system-card">
              <div className="panel-heading">
                <div><span className="section-kicker">Live Subsystem State</span><h3>Protection & Actuators</h3></div>
                <span className={`feed-chip ${telemetry?.source || 'none'}`}>{source}</span>
              </div>
              <div className="system-rows">
                <div><span>Highest Temperature</span><strong style={{ color: isOverTemp ? '#b92e25' : '#123b5d' }}>{value(highestTemp, ' °C')} (Threshold: 35.0 °C)</strong></div>
                <div><span>Water Pump (IRF520 SIG, GPIO 12)</span><StatePill on={telemetry?.actuators?.pump} onText="RUNNING" offText="OFF" /></div>
                <div><span>Buzzer Alarm (GPIO 17)</span><StatePill on={telemetry?.actuators?.buzzer} onText="ACTIVE" offText="SILENT" alertStyle /></div>
                <div><span>Red Alert LED (GPIO 38)</span><StatePill on={telemetry?.actuators?.redLed} onText="ON (ALERT)" offText="OFF" alertStyle /></div>
                <div><span>Green Safe LED (GPIO 39)</span><StatePill on={telemetry?.actuators?.greenLed} onText="ON (SAFE)" offText="OFF" /></div>
                <div><span>Blue Wi-Fi LED (GPIO 40)</span><StatePill on={telemetry?.actuators?.blueLed} onText="CONNECTED" offText="OFF" /></div>
                <div><span>Water Level ADC</span><strong>{s.waterAdc != null ? `${s.waterAdc} (${value(s.waterLevelPct, '%', 0)})` : '—'}</strong></div>
              </div>
            </article>

            <article className="panel judge-card">
              <div className="panel-heading">
                <div><span className="section-kicker">Operation Flow</span><h3>How the System Works</h3></div>
              </div>
              <ol className="judge-flow">
                <li><b>Sense</b><span>Reads 3x DS18B20 1-Wire sensors, 10k NTC thermistor via ADC, and reservoir water level.</span></li>
                <li><b>Compute</b><span>Identifies the peak temperature probe (`highestTemp`) and compares against 35.0 °C limit.</span></li>
                <li><b>Actuate</b><span>If temp &gt; 35.0 °C: Pump turns ON, Buzzer sounds, Red LED turns ON, Green LED turns OFF.</span></li>
                <li><b>Stream</b><span>ESP32-S3 broadcasts JSON telemetry over local Wi-Fi to this live dashboard in real time.</span></li>
              </ol>
            </article>
          </section>
        </main>
      )}

      {/* LIVE MONITORING TAB */}
      {view === 'monitor' && (
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
                <strong>AWAITING REAL HARDWARE:</strong> No live telemetry packets received from ESP32-S3 yet. Turn on your ESP32-S3 on the Wi-Fi network to see real-time sensor streams.
              </div>
            </div>
          )}

          <section className="page-title">
            <div>
              <span className="eyebrow">Real-Time Sensor Telemetry</span>
              <h2>Live Monitoring</h2>
              <p>Streamed from the ESP32-S3 over Wi-Fi. Real hardware measurements only.</p>
            </div>
            <div className={`large-status ${cls(isOverTemp ? 'CRITICAL' : (a.status || (telemetry ? 'NORMAL' : 'NO DATA')))}`}>
              <span>Current Status</span>
              <strong>{isOverTemp ? '🔥 OVER-TEMP ALERT' : (a.status || (telemetry ? 'NORMAL' : 'WAITING FOR ESP32'))}</strong>
              <em>Peak: {value(highestTemp, ' °C')} (Limit: 35.0 °C)</em>
            </div>
          </section>

          <section className="metrics-grid">
            <Metric
              title="Highest System Temp"
              sensor="PEAK DETECTOR"
              valueText={value(highestTemp, ' °C')}
              trend={trends.highest}
              note={`Threshold: 35.0 °C · ${isOverTemp ? '🚨 Triggered (>35°C)' : (telemetry ? '✅ Normal' : 'Waiting for hardware')}`}
              highlightAlert={isOverTemp}
            />
            <Metric
              title="DS18B20 Sensor 1"
              sensor="1-Wire (GPIO 4)"
              valueText={value(s.dsTemp1C, ' °C')}
              trend={trends.ds1}
              note="Digital Probe #1"
            />
            <Metric
              title="DS18B20 Sensor 2"
              sensor="1-Wire (GPIO 4)"
              valueText={value(s.dsTemp2C, ' °C')}
              trend={trends.ds2}
              note="Digital Probe #2"
            />
            <Metric
              title="DS18B20 Sensor 3"
              sensor="1-Wire (GPIO 4)"
              valueText={value(s.dsTemp3C, ' °C')}
              trend={trends.ds3}
              note="Digital Probe #3"
            />
            <Metric
              title="NTC 10K Thermistor"
              sensor="ADC (GPIO 1)"
              valueText={value(s.ntcTempC ?? s.coolantTempC, ' °C')}
              trend={trends.ntc}
              note="Steinhart-Hart B=3950"
            />
            <Metric
              title="Coolant Water Level"
              sensor="Analog (GPIO 5)"
              valueText={value(s.waterLevelPct, ' %', 0)}
              trend={trends.water}
              note={`Raw ADC: ${s.waterAdc != null ? s.waterAdc : '—'} / 4095`}
            />
          </section>

          <section className="control-layout">
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">Reported Hardware State</span>
                  <h3>Actuators & Status LEDs</h3>
                </div>
                <span>{telemetry?.receivedAt ? new Date(telemetry.receivedAt).toLocaleTimeString() : '—'}</span>
              </div>
              <div className="state-table">
                <div><span>Highest Temperature</span><strong>{value(highestTemp, ' °C')}</strong></div>
                <div><span>Temperature Safety Limit</span><strong>35.0 °C</strong></div>
                <div>
                  <span>Over-Temp Alarm</span>
                  <strong className={isOverTemp ? 'danger-text' : 'safe-text'}>
                    {isOverTemp ? '🔥 TRIGGERED (>35°C)' : (telemetry ? '✅ SAFE (NORMAL)' : '—')}
                  </strong>
                </div>
                <div><span>Water Pump (IRF520 SIG, GPIO 12)</span><StatePill on={telemetry?.actuators?.pump} onText="RUNNING" offText="OFF" /></div>
                <div><span>Buzzer Alarm (GPIO 17)</span><StatePill on={telemetry?.actuators?.buzzer} onText="ACTIVE" offText="SILENT" alertStyle /></div>
                <div><span>Red LED (Alarm - GPIO 38)</span><StatePill on={telemetry?.actuators?.redLed} onText="ON (ALERT)" offText="OFF" alertStyle /></div>
                <div><span>Green LED (Safe - GPIO 39)</span><StatePill on={telemetry?.actuators?.greenLed} onText="ON (SAFE)" offText="OFF" /></div>
                <div><span>Blue LED (Wi-Fi Link - GPIO 40)</span><StatePill on={telemetry?.actuators?.blueLed} onText="CONNECTED" offText="OFF" /></div>
                <div><span>Water Level ADC</span><strong>{s.waterAdc != null ? `${s.waterAdc} / 4095` : '—'}</strong></div>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">Prototype Control</span>
                  <h3>Manual Actuator Test</h3>
                </div>
                <span>ESP32 Command Queue</span>
              </div>
              <div className="safety-note">
                <b>Automatic Safety Interlock:</b> When any temperature probe exceeds 35.0 °C, the ESP32 firmware autonomously overrides manual states to run the Water Pump, Buzzer, and Red LED.
              </div>
              {[
                ['pump', 'Water Pump (IRF520)'],
                ['buzzer', 'Alert Buzzer'],
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
