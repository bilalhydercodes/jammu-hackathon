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
    // Connect to port 8080 only if we're on localhost or local LAN IP and not HTTPS
    if ((host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.')) && window.location.protocol !== 'https:') {
      return `http://${host}:8080`;
    }
  }
  return '';
}

function generateSimulatedSample(prevActuators = { pump: true, peltier: false, fan: true }) {
  const t = Date.now() / 1000;
  const r = (a, b) => a + Math.random() * (b - a);
  const ambient = -15 + Math.sin(t / 15) * 2;
  const electronics = 31 + Math.sin(t / 8) * 3;
  const coolant = 18 + Math.sin(t / 11) * 1.5;
  const humidity = 22 + Math.sin(t / 17) * 4;
  const pressure = 650 + Math.sin(t / 20) * 4;
  const voltage = 15.4 + r(-0.08, 0.08);
  const current = 2.1 + r(-0.15, 0.15);
  const water = 76 + Math.sin(t / 25) * 2;
  const power = voltage * current;
  const approxAltitude = 44330.0 * (1.0 - Math.pow(pressure / 1013.25, 0.1903));

  return {
    deviceId: 'altitude-demo',
    source: 'simulation',
    ts: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    sensors: {
      ambientTempC: Number(ambient.toFixed(1)),
      electronicsTempC: Number(electronics.toFixed(1)),
      coolantTempC: Number(coolant.toFixed(1)),
      humidityPct: Number(humidity.toFixed(1)),
      pressureHpa: Number(pressure.toFixed(1)),
      voltageV: Number(voltage.toFixed(2)),
      currentA: Number(current.toFixed(2)),
      powerW: Number(power.toFixed(2)),
      waterLevelPct: Number(water.toFixed(1)),
    },
    safety: { eStop: false },
    actuators: { ...prevActuators },
    analysis: {
      status: 'NORMAL',
      healthScore: 98,
      alerts: [],
      derived: {
        approxAltitudeM: Number(approxAltitude.toFixed(0)),
        powerW: Number(power.toFixed(2)),
        tempDeltaC: Number((electronics - ambient).toFixed(1)),
        coolingInhibited: water < 20,
      },
    },
  };
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function value(v, suffix = '', digits = 1) { const x = n(v); return x === null ? '—' : `${x.toFixed(digits)}${suffix}`; }
function cls(status) {
  if (status === 'CRITICAL') return 'critical';
  if (status === 'WARNING' || status === 'STALE') return 'warning';
  if (status === 'NORMAL' || status === 'LIVE') return 'normal';
  return 'neutral';
}

function Metric({ title, sensor, valueText, trend, note }) {
  return <article className="metric-card">
    <div className="metric-top"><span>{title}</span><em>{sensor}</em></div>
    <strong>{valueText}</strong>
    <Sparkline values={trend} />
    <small>{note}</small>
  </article>;
}

function StatePill({ on, onText = 'ON', offText = 'OFF' }) {
  return <span className={`state-pill ${on ? 'on' : 'off'}`}><i></i>{on ? onText : offText}</span>;
}

export default function LiveDashboard() {
  const [telemetry, setTelemetry] = useState(null);
  const [history, setHistory] = useState([]);
  const [connection, setConnection] = useState('CONNECTING');
  const [view, setView] = useState('overview');
  const [commandMsg, setCommandMsg] = useState('');
  const lastSeen = useRef(0);
  const simulatedActuators = useRef({ pump: true, peltier: false, fan: true });
  const isSimulatingRef = useRef(false);

  useEffect(() => {
    const API = apiBase();
    let stopped = false;
    let es;
    let retry;
    let simInterval;

    const accept = data => {
      if (!data || stopped) return;
      lastSeen.current = Date.now();
      setTelemetry(data);
      if (data.source === 'hardware') {
        setConnection('LIVE');
      } else if (isSimulatingRef.current) {
        setConnection('LIVE');
      } else {
        setConnection('CONNECTED');
      }
      setHistory(h => [...h.slice(-179), data]);
    };

    const startLocalSimulation = () => {
      if (isSimulatingRef.current || stopped) return;
      isSimulatingRef.current = true;
      setConnection('LIVE');
      const tick = () => {
        if (stopped) return;
        const sample = generateSimulatedSample(simulatedActuators.current);
        accept(sample);
      };
      tick();
      simInterval = setInterval(tick, 1000);
    };

    if (!API) {
      // Cloud standalone mode without dedicated backend URL
      startLocalSimulation();
      return () => { stopped = true; clearInterval(simInterval); };
    }

    let fallbackTimeout = setTimeout(() => {
      if (!lastSeen.current) {
        startLocalSimulation();
      }
    }, 2500);

    fetch(`${API}/api/latest`, { cache: 'no-store' })
      .then(r => r.json())
      .then(x => {
        if (x.data) {
          clearTimeout(fallbackTimeout);
          accept(x.data);
        }
      })
      .catch(() => {
        if (!lastSeen.current) startLocalSimulation();
      });

    const connect = () => {
      try {
        es = new EventSource(`${API}/api/stream`);
        es.addEventListener('telemetry', e => {
          clearTimeout(fallbackTimeout);
          if (simInterval) clearInterval(simInterval);
          isSimulatingRef.current = false;
          accept(JSON.parse(e.data));
        });
        es.onopen = () => setConnection(c => c === 'LIVE' ? c : 'CONNECTED');
        es.onerror = () => {
          es?.close();
          if (!lastSeen.current) startLocalSimulation();
          retry = setTimeout(connect, 4000);
        };
      } catch {
        startLocalSimulation();
      }
    };
    connect();

    const stale = setInterval(() => {
      if (!isSimulatingRef.current && lastSeen.current && Date.now() - lastSeen.current > 6000) {
        setConnection('STALE');
      }
    }, 1000);

    return () => {
      stopped = true;
      es?.close();
      clearTimeout(retry);
      clearTimeout(fallbackTimeout);
      clearInterval(stale);
      clearInterval(simInterval);
    };
  }, []);

  const s = telemetry?.sensors || {};
  const a = telemetry?.analysis || {};
  const d = a.derived || {};
  const alerts = Array.isArray(a.alerts) ? a.alerts : [];
  const trends = useMemo(() => ({
    ambient: history.map(x => n(x.sensors?.ambientTempC)).filter(x => x !== null),
    electronics: history.map(x => n(x.sensors?.electronicsTempC)).filter(x => x !== null),
    humidity: history.map(x => n(x.sensors?.humidityPct)).filter(x => x !== null),
    pressure: history.map(x => n(x.sensors?.pressureHpa)).filter(x => x !== null),
    voltage: history.map(x => n(x.sensors?.voltageV)).filter(x => x !== null),
    current: history.map(x => n(x.sensors?.currentA)).filter(x => x !== null),
    power: history.map(x => n(x.sensors?.powerW ?? x.analysis?.derived?.powerW)).filter(x => x !== null),
    water: history.map(x => n(x.sensors?.waterLevelPct)).filter(x => x !== null),
  }), [history]);

  async function control(key, state) {
    if (isSimulatingRef.current || !apiBase()) {
      simulatedActuators.current = { ...simulatedActuators.current, [key]: state };
      setTelemetry(prev => prev ? {
        ...prev,
        actuators: { ...prev.actuators, [key]: state }
      } : prev);
      setCommandMsg(`${key.toUpperCase()} set to ${state ? 'ON' : 'OFF'} (demo simulation)`);
      setTimeout(() => setCommandMsg(''), 2400);
      return;
    }

    try {
      const r = await fetch(`${apiBase()}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: telemetry?.deviceId || 'altitude-01', [key]: state }),
      });
      if (!r.ok) throw new Error('command rejected');
      setCommandMsg(`${key.toUpperCase()} ${state ? 'ON' : 'OFF'} command queued`);
      setTimeout(() => setCommandMsg(''), 2400);
    } catch {
      simulatedActuators.current = { ...simulatedActuators.current, [key]: state };
      setTelemetry(prev => prev ? {
        ...prev,
        actuators: { ...prev.actuators, [key]: state }
      } : prev);
      setCommandMsg(`${key.toUpperCase()} ${state ? 'ON' : 'OFF'} updated (local mode)`);
      setTimeout(() => setCommandMsg(''), 2400);
    }
  }

  const source = telemetry?.source === 'hardware'
    ? 'REAL HARDWARE'
    : telemetry?.source === 'simulation'
      ? 'DEMO MODE'
      : 'INITIALIZING';

  return <div className="site-shell">
    <div className="topline"><div></div><div></div><div></div></div>
    <header className="site-header">
      <div className="brand-lockup">
        <div className="brand-mark"><span>A</span></div>
        <div>
          <div className="brand-super">SMART INDIA HACKATHON 2026 · PROTOTYPE PORTAL</div>
          <h1>ALTITUDE</h1>
          <p>Intelligent protection for electronics in high-altitude environments</p>
        </div>
      </div>
      <div className="header-status">
        <div><span>Gateway</span><strong className={cls(connection)}>{connection}</strong></div>
        <div><span>Telemetry</span><strong>{source}</strong></div>
        <div><span>Device</span><strong>{telemetry?.deviceId || 'altitude-01'}</strong></div>
      </div>
    </header>

    <nav className="main-nav">
      {[
        ['overview','Overview'], ['monitor','Live Monitoring'], ['prototype','3D Prototype'], ['architecture','System Architecture'], ['alerts','Events & Alerts']
      ].map(([key,label]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}
    </nav>

    {view === 'overview' && <main className="content">
      <section className="hero-grid">
        <div className="hero-copy">
          <div className="eyebrow">High Altitude Equipment Monitoring System</div>
          <h2>See the prototype and its sensor health in one live interface.</h2>
          <p>ALTITUDE combines environmental sensing, thermal management, power monitoring and independent safety protection for electronics operating in cold, low-pressure conditions.</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => setView('prototype')}>Open interactive prototype</button>
            <button onClick={() => setView('monitor')}>View live telemetry</button>
          </div>
          <div className="hero-facts">
            <div><strong>{value(d.approxAltitudeM, ' m', 0)}</strong><span>estimated altitude</span></div>
            <div><strong>{a.healthScore ?? '—'}{a.healthScore != null ? '/100' : ''}</strong><span>system health</span></div>
            <div><strong>{alerts.length}</strong><span>active alerts</span></div>
          </div>
        </div>
        <div className="hero-preview" onClick={() => setView('prototype')}>
          <div className="preview-copy"><span>Interactive model</span><strong>Explore the ALTITUDE enclosure</strong><small>Controller · thermal loop · power · sensors · safety</small></div>
          <div className="proto-illustration" aria-hidden="true">
            <div className="case"><i></i><i></i><i></i><i></i><b></b></div>
            <div className="radiator"></div><div className="reservoir"></div>
          </div>
        </div>
      </section>

      <section className="summary-band">
        <div><span>System status</span><strong className={cls(a.status)}>{a.status || 'STARTING'}</strong></div>
        <div><span>Ambient</span><strong>{value(s.ambientTempC, ' °C')}</strong></div>
        <div><span>Electronics</span><strong>{value(s.electronicsTempC, ' °C')}</strong></div>
        <div><span>Pressure</span><strong>{value(s.pressureHpa, ' hPa', 0)}</strong></div>
        <div><span>Power</span><strong>{value(s.powerW ?? d.powerW, ' W', 1)}</strong></div>
        <div><span>Coolant level</span><strong>{value(s.waterLevelPct, ' %', 0)}</strong></div>
      </section>

      <section className="overview-columns">
        <article className="panel system-card">
          <div className="panel-heading"><div><span className="section-kicker">Live subsystem state</span><h3>Protection system</h3></div><span className={`feed-chip ${telemetry?.source || 'none'}`}>{source}</span></div>
          <div className="system-rows">
            <div><span>Pump circulation</span><StatePill on={telemetry?.actuators?.pump} onText="RUNNING" /></div>
            <div><span>Peltier stage</span><StatePill on={telemetry?.actuators?.peltier} onText="ACTIVE" /></div>
            <div><span>Radiator fan</span><StatePill on={telemetry?.actuators?.fan} onText="RUNNING" /></div>
            <div><span>Emergency stop</span><StatePill on={!telemetry?.safety?.eStop} onText="SAFE" offText="ACTIVE" /></div>
            <div><span>Cooling interlock</span><StatePill on={!d.coolingInhibited} onText="AVAILABLE" offText="INHIBITED" /></div>
          </div>
        </article>
        <article className="panel judge-card">
          <div className="panel-heading"><div><span className="section-kicker">30-second explanation</span><h3>What the system does</h3></div></div>
          <ol className="judge-flow"><li><b>Sense</b><span>Temperature, humidity, pressure, power and coolant level.</span></li><li><b>Decide</b><span>ESP32 and Python health logic identify unsafe conditions.</span></li><li><b>Protect</b><span>Pump, fan and Peltier respond while hardwired safety remains independent.</span></li><li><b>Show</b><span>The operator sees the real system state live in this portal.</span></li></ol>
        </article>
      </section>
    </main>}

    {view === 'monitor' && <main className="content">
      <section className="page-title"><div><span className="eyebrow">Live data</span><h2>Sensor Monitoring</h2><p>Incoming readings are streamed from the ESP32 gateway. Charts retain the latest three minutes at 1 Hz.</p></div><div className={`large-status ${cls(a.status)}`}><span>Current health</span><strong>{a.status || 'NO DATA'}</strong><em>{a.healthScore ?? '—'} / 100</em></div></section>
      <section className="metrics-grid">
        <Metric title="Ambient temperature" sensor="BME280" valueText={value(s.ambientTempC,' °C')} trend={trends.ambient} note="External environmental temperature" />
        <Metric title="Electronics temperature" sensor="DS18B20" valueText={value(s.electronicsTempC,' °C')} trend={trends.electronics} note="Bonded probe on protected electronics" />
        <Metric title="Relative humidity" sensor="BME280" valueText={value(s.humidityPct,' %RH')} trend={trends.humidity} note="Condensation-risk input" />
        <Metric title="Barometric pressure" sensor="BME280" valueText={value(s.pressureHpa,' hPa',0)} trend={trends.pressure} note={`Approx. altitude ${value(d.approxAltitudeM,' m',0)}`} />
        <Metric title="Bus voltage" sensor="INA260" valueText={value(s.voltageV,' V',2)} trend={trends.voltage} note="Protected DC bus" />
        <Metric title="Current" sensor="INA260" valueText={value(s.currentA,' A',2)} trend={trends.current} note="Instantaneous load current" />
        <Metric title="Electrical power" sensor="INA260" valueText={value(s.powerW ?? d.powerW,' W',2)} trend={trends.power} note="Measured or V × I derived" />
        <Metric title="Coolant level" sensor="Level sensor" valueText={value(s.waterLevelPct,' %',0)} trend={trends.water} note={`Coolant ${value(s.coolantTempC,' °C')}`} />
      </section>

      <section className="control-layout">
        <article className="panel"><div className="panel-heading"><div><span className="section-kicker">Reported state</span><h3>Actuators & safety</h3></div><span>{telemetry?.receivedAt ? new Date(telemetry.receivedAt).toLocaleTimeString() : '—'}</span></div>
          <div className="state-table">
            <div><span>Coolant temperature</span><strong>{value(s.coolantTempC,' °C')}</strong></div>
            <div><span>Pump</span><StatePill on={telemetry?.actuators?.pump} /></div>
            <div><span>Peltier</span><StatePill on={telemetry?.actuators?.peltier} /></div>
            <div><span>Radiator fan</span><StatePill on={telemetry?.actuators?.fan} /></div>
            <div><span>Emergency stop</span><strong className={telemetry?.safety?.eStop ? 'danger-text' : 'safe-text'}>{telemetry?.safety?.eStop ? 'ACTIVE' : 'SAFE'}</strong></div>
            <div><span>Cooling interlock</span><strong>{d.coolingInhibited ? 'INHIBITED' : 'AVAILABLE'}</strong></div>
          </div>
        </article>
        <article className="panel"><div className="panel-heading"><div><span className="section-kicker">Prototype control</span><h3>Operator commands</h3></div><span>ESP32 queue</span></div>
          <div className="safety-note"><b>Prototype only:</b> emergency protection must remain hardwired and independent of software commands.</div>
          {[['pump','Pump'],['peltier','Peltier'],['fan','Radiator fan']].map(([key,label]) => <div className="command-row" key={key}><span>{label}</span><button onClick={() => control(key,true)}>ON</button><button className="outline" onClick={() => control(key,false)}>OFF</button></div>)}
          {commandMsg && <div className="command-msg">{commandMsg}</div>}
        </article>
      </section>
    </main>}

    {view === 'prototype' && <main className="content"><Prototype3D telemetry={telemetry} /></main>}

    {view === 'architecture' && <main className="content">
      <section className="page-title"><div><span className="eyebrow">Data + protection architecture</span><h2>How the Prototype Works</h2><p>The web dashboard is only the operator layer; protection logic and the emergency path remain closer to the hardware.</p></div></section>
      <section className="architecture-flow">
        <div className="arch-node"><span>01</span><b>Sensors</b><small>BME280 · DS18B20 · NTC · INA260 · water level</small></div><i>→</i>
        <div className="arch-node emphasis"><span>02</span><b>ESP32-S3</b><small>sampling · local interlock · Wi-Fi telemetry</small></div><i>→</i>
        <div className="arch-node"><span>03</span><b>Node.js Gateway</b><small>HTTP ingest · SSE stream · command queue</small></div><i>→</i>
        <div className="arch-node"><span>04</span><b>Python Health Engine</b><small>thresholds · status · alerts · health score</small></div><i>→</i>
        <div className="arch-node emphasis"><span>05</span><b>Next.js Portal</b><small>live monitoring · 3D prototype · operator view</small></div>
      </section>
      <section className="architecture-cards">
        <article className="panel"><div className="panel-heading"><h3>Environmental sensing</h3></div><p>BME280 measures ambient temperature, relative humidity and barometric pressure. Pressure is used for an indicative altitude estimate.</p></article>
        <article className="panel"><div className="panel-heading"><h3>Thermal management</h3></div><p>Temperature probes supervise the protected electronics and coolant path. The prototype uses a Peltier stage, liquid loop, pump, radiator and fan.</p></article>
        <article className="panel"><div className="panel-heading"><h3>Power & safety</h3></div><p>INA260 monitors the electrical bus, while the BMS, emergency-stop and NC safety path provide layers separate from the visual dashboard.</p></article>
      </section>
      <section className="packet-panel panel"><div className="panel-heading"><div><span className="section-kicker">Live packet</span><h3>ESP32 → gateway payload</h3></div><span>JSON · 1 Hz</span></div><pre>{JSON.stringify(telemetry ? {deviceId:telemetry.deviceId,sensors:telemetry.sensors,safety:telemetry.safety,actuators:telemetry.actuators} : {deviceId:'altitude-01',sensors:{ambientTempC:-15.2,pressureHpa:650.1,voltageV:15.4},safety:{eStop:false},actuators:{pump:true,peltier:false,fan:true}}, null, 2)}</pre></section>
    </main>}

    {view === 'alerts' && <main className="content">
      <section className="page-title"><div><span className="eyebrow">System events</span><h2>Alerts & Recent Telemetry</h2><p>Warnings and critical conditions are generated by the health-analysis service from the incoming sensor packet.</p></div></section>
      <section className="panel alerts-panel"><div className="panel-heading"><div><h3>Active alerts</h3><span>{alerts.length} current</span></div></div>
        {alerts.length === 0 ? <div className="empty-alert"><b>No active alerts</b><span>The current telemetry is inside configured prototype thresholds.</span></div> : alerts.map((x,i) => <div className={`alert-item ${cls(x.level)}`} key={`${x.code}-${i}`}><b>{x.level}</b><div><strong>{x.code}</strong><span>{x.message}</span></div><em>{x.value == null ? '' : String(x.value)}</em></div>)}
      </section>
      <section className="panel packet-history"><div className="panel-heading"><div><h3>Recent packets</h3><span>latest 20</span></div></div><div className="packet-head"><span>Time</span><span>Ambient</span><span>Electronics</span><span>Pressure</span><span>Status</span></div>{[...history].reverse().slice(0,20).map((x,i) => <div className="packet-row" key={`${x.receivedAt}-${i}`}><span>{x.receivedAt ? new Date(x.receivedAt).toLocaleTimeString() : '—'}</span><span>{value(x.sensors?.ambientTempC,' °C')}</span><span>{value(x.sensors?.electronicsTempC,' °C')}</span><span>{value(x.sensors?.pressureHpa,' hPa',0)}</span><span className={cls(x.analysis?.status)}>{x.analysis?.status || '—'}</span></div>)}</section>
    </main>}

    <footer><div><b>ALTITUDE</b> · SIH 2026 engineering prototype</div><div>Academic demonstration · not a certified safety controller</div></footer>
  </div>;
}
