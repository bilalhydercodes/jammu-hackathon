'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const DETAILS = {
  controller: { title: 'ESP32-S3 Controller', text: 'Collects sensor readings, applies local interlocks and sends telemetry to the Node.js gateway over Wi-Fi.' },
  sensor: { title: 'Environmental Sensors', text: 'BME280 tracks ambient temperature, humidity and pressure. Bonded temperature probes track protected electronics and the thermal loop.' },
  power: { title: 'Power Monitoring', text: 'INA260 monitors bus voltage, current and power. The BMS protects the battery pack.' },
  cooling: { title: 'Active Thermal Loop', text: 'Peltier, cold plate, pump, reservoir, radiator and fan form the prototype thermal-management path.' },
  safety: { title: 'Independent Safety Path', text: 'Emergency-stop and NC safety relay are represented as a hardwired protection layer independent of the web controls.' },
};

function fmt(v, suffix = '', digits = 1) {
  const x = Number(v);
  return Number.isFinite(x) ? `${x.toFixed(digits)}${suffix}` : '—';
}

function addBox(THREE, parent, name, pos, size, color, opts = {}) {
  const geo = new THREE.BoxGeometry(...size);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.45,
    metalness: opts.metalness ?? 0.15,
    transparent: Boolean(opts.transparent),
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.set(...pos);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (opts.tag) mesh.userData.tag = opts.tag;
  parent.add(mesh);
  return mesh;
}

function addCylinder(THREE, parent, name, pos, radius, height, color, opts = {}) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 32);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.45,
    metalness: opts.metalness ?? 0.2,
    transparent: Boolean(opts.transparent),
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.set(...pos);
  const axis = opts.axis || 'Z';
  if (axis === 'Z') mesh.rotation.x = Math.PI / 2;
  else if (axis === 'X') mesh.rotation.z = Math.PI / 2;
  if (opts.tag) mesh.userData.tag = opts.tag;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function addPipe(THREE, parent, name, pts, color) {
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, 42, 0.055, 10, false);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.78 });
  const pipe = new THREE.Mesh(geo, mat);
  pipe.name = name;
  parent.add(pipe);
  return pipe;
}

export default function Prototype3D({ telemetry }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const [selected, setSelected] = useState('controller');
  const [exploded, setExploded] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);

  const live = useMemo(() => ({
    status: telemetry?.analysis?.status || 'NO DATA',
    temp: telemetry?.sensors?.electronicsTempC,
    ambient: telemetry?.sensors?.ambientTempC,
    water: telemetry?.sensors?.waterLevelPct,
    voltage: telemetry?.sensors?.voltageV,
    pump: telemetry?.actuators?.pump,
    peltier: telemetry?.actuators?.peltier,
    fan: telemetry?.actuators?.fan,
    estop: telemetry?.safety?.eStop,
  }), [telemetry]);

  useEffect(() => {
    let renderer, controls, frame, disposed = false;
    let resize;

    (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      if (!mountRef.current || disposed) return;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xe9eef3);
      scene.fog = new THREE.Fog(0xe9eef3, 20, 42);

      const camera = new THREE.PerspectiveCamera(39, 1, 0.05, 120);
      camera.position.set(10.6, -12.5, 8.5);
      camera.up.set(0, 0, 1);

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mountRef.current.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 0, 1.45);
      controls.enableDamping = true;
      controls.minDistance = 5.5;
      controls.maxDistance = 26;
      controls.maxPolarAngle = Math.PI * 0.48;

      scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7f8e, 2.2));
      const key = new THREE.DirectionalLight(0xffffff, 4.2);
      key.position.set(-7, -8, 13);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xffd2a6, 1.8);
      rim.position.set(8, 5, 8);
      scene.add(rim);

      const floorMat = new THREE.MeshStandardMaterial({ color: 0xd8e0e7, roughness: 0.95 });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(55, 55), floorMat);
      floor.receiveShadow = true;
      floor.position.z = -0.25;
      scene.add(floor);

      const root = new THREE.Group();
      root.name = 'ALTITUDE Web Prototype';
      scene.add(root);

      const C = {
        shell: 0x183a58, steel: 0x8998a5, black: 0x111923, pcb: 0x14613f,
        copper: 0xb66c32, ceramic: 0xdbe7ed, battery: 0x234760, blue: 0x1882b8,
        red: 0xb3261e, amber: 0xd18a10, coolant: 0x2d8cc7, white: 0xecf4f9,
      };

      // Enclosure and removable panels — proportions follow the uploaded Blender concept.
      addBox(THREE, root, 'Rugged aluminum base', [0, 0, 0.75], [7.6, 5.4, 0.22], C.shell, { metalness: .65, roughness: .3 });
      addBox(THREE, root, 'Rear enclosure wall', [0, 2.62, 1.83], [7.6, .16, 2.12], C.shell, { metalness: .65 });
      addBox(THREE, root, 'Left enclosure wall', [-3.72, 0, 1.83], [.16, 5.12, 2.12], C.shell, { metalness: .65 });
      addBox(THREE, root, 'Right enclosure wall', [3.72, 0, 1.83], [.16, 5.12, 2.12], C.shell, { metalness: .65 });
      addBox(THREE, root, 'Dry wet divider', [.55, 0, 1.69], [.10, 5.08, 1.72], C.shell, { metalness: .65 });

      const lid = new THREE.Group();
      lid.name = 'Sealed lid';
      addBox(THREE, lid, 'Sealed top lid', [0, 0, 0], [7.65, 5.44, .20], C.shell, { metalness: .7, roughness: .28 });
      root.add(lid);

      const front = new THREE.Group();
      front.name = 'Front service panel';
      addBox(THREE, front, 'Front panel plate', [0, 0, 0], [7.6, .16, 2.12], C.shell, { metalness: .7 });
      addBox(THREE, front, 'OLED display', [-1.43, -.12, .25], [2.05, .04, .64], 0x07131d, { emissive: 0x0b6ea8, emissiveIntensity: .3 });
      addCylinder(THREE, front, 'E-stop mushroom', [1.87, -.23, .14], .25, .2, C.red, { axis: 'Y', tag: 'safety', emissive: C.red, emissiveIntensity: .15 });
      root.add(front);

      // Dry-bay electronics.
      addBox(THREE, root, 'Controller carrier PCB', [-1.88, .80, 1.20], [2.87, 1.57, .055], C.pcb, { tag: 'controller' });
      addBox(THREE, root, 'ESP32-S3 controller', [-1.99, .74, 1.34], [1.08, .78, .20], C.steel, { tag: 'controller', metalness: .6 });
      addBox(THREE, root, 'BME280 sensor', [-3.30, 1.99, 1.40], [.34, .34, .08], 0x7a274f, { tag: 'sensor', emissive: 0x2d8cc7, emissiveIntensity: .05 });
      addBox(THREE, root, 'INA260 power monitor', [-.01, .98, 1.24], [.68, 1.72, .12], C.pcb, { tag: 'power' });
      addBox(THREE, root, 'Safety relay', [.01, 2.00, 1.32], [.43, .32, .36], C.amber, { tag: 'safety' });

      addBox(THREE, root, 'Protected electronics board', [-1.95, -.51, 1.18], [2.55, .91, .065], C.pcb, { tag: 'sensor' });
      addBox(THREE, root, 'Electronics heat spreader', [-1.63, -.48, 1.40], [2.25, .74, .32], C.steel, { tag: 'cooling', metalness: .8 });
      for (let i = 0; i < 12; i++) addBox(THREE, root, `Heat sink fin ${i}`, [-2.63 + i * .18, -.48, 1.66], [.055, .72, .28], C.steel, { metalness: .8, tag: 'cooling' });

      // Peltier stack.
      addBox(THREE, root, 'Cold-side thermal bridge', [-.20, -.43, 1.39], [1.05, .59, .16], C.copper, { tag: 'cooling', metalness: .75 });
      addBox(THREE, root, 'Peltier cold ceramic', [.70, -.43, 1.40], [.08, .55, .53], C.ceramic, { tag: 'cooling' });
      addBox(THREE, root, 'Peltier active layer', [.77, -.43, 1.40], [.06, .49, .46], C.black, { tag: 'cooling', emissive: C.amber, emissiveIntensity: .05 });
      addBox(THREE, root, 'Hot-side exchanger', [1.05, -.43, 1.40], [.38, .72, .67], C.copper, { tag: 'cooling', metalness: .75 });

      // Battery + BMS.
      addBox(THREE, root, 'Battery cradle', [-2.04, -1.94, 1.10], [2.63, 1.02, .36], C.black, { tag: 'power' });
      for (let i = 0; i < 6; i++) addCylinder(THREE, root, `Battery cell ${i + 1}`, [-3.04 + i * .40, -1.94, 1.40], .17, .84, C.battery, { axis: 'Y', tag: 'power', metalness: .35 });
      addBox(THREE, root, 'BMS board', [-.24, -1.96, 1.25], [.67, .90, .08], C.pcb, { tag: 'power' });

      // Wet-bay cooling loop.
      addCylinder(THREE, root, 'Reservoir shell', [2.42, 1.35, 1.82], .43, 1.30, 0xa8d9ed, { tag: 'cooling', transparent: true, opacity: .28 });
      const liquid = addCylinder(THREE, root, 'Reservoir coolant', [2.42, 1.35, 1.63], .37, .95, C.coolant, { tag: 'cooling', transparent: true, opacity: .72, emissive: 0x0b5c85, emissiveIntensity: .1 });
      addCylinder(THREE, root, 'Pump motor', [2.49, -1.60, 1.34], .33, .73, C.black, { axis: 'Y', tag: 'cooling', emissive: C.blue, emissiveIntensity: .05 });
      const pumpFace = addCylinder(THREE, root, 'Pump active ring', [2.49, -1.18, 1.34], .28, .08, C.steel, { axis: 'Y', tag: 'cooling', emissive: C.blue, emissiveIntensity: .05 });
      addBox(THREE, root, 'External radiator core', [4.04, .45, 1.73], [.43, 2.64, 1.57], C.black, { tag: 'cooling' });
      for (let j = 0; j < 22; j++) addBox(THREE, root, `Radiator fin ${j}`, [4.10, -.80 + j * .075, 1.73], [.62, .024, 1.48], C.steel, { tag: 'cooling', metalness: .7 });

      const fan = new THREE.Group();
      fan.name = 'Radiator fan';
      fan.position.set(4.52, .44, 1.75);
      fan.userData.tag = 'cooling';
      addCylinder(THREE, fan, 'Fan hub', [0, 0, 0], .15, .10, C.steel, { axis: 'X' });
      for (let j = 0; j < 7; j++) {
        const a = j * Math.PI * 2 / 7;
        const blade = addBox(THREE, fan, `Fan blade ${j}`, [0, .34 * Math.cos(a), .34 * Math.sin(a)], [.05, .45, .15], C.black);
        blade.rotation.x = a;
      }
      root.add(fan);

      addPipe(THREE, root, 'Coolant return', [[2.3,1.05,1.3],[2.1,.65,1.18],[2.1,-.7,1.18],[2.49,-1.05,1.34]], C.coolant);
      addPipe(THREE, root, 'Coolant hot path', [[2.7,-1.18,1.34],[3.05,-.85,1.55],[3.55,-.40,1.78],[3.9,-.38,1.83]], 0xd06434);
      addPipe(THREE, root, 'Radiator return', [[3.9,1.26,1.83],[3.65,1.26,1.83],[3.1,1.65,2.1],[2.65,1.46,2.25]], C.coolant);

      // Status beacon and cable hints.
      const beacon = addCylinder(THREE, root, 'Status beacon', [-3.24, -1.10, 1.32], .09, .10, 0x14863d, { tag: 'safety', emissive: 0x14863d, emissiveIntensity: 1.0 });
      addPipe(THREE, root, 'Sensor harness', [[-3.3,1.9,1.35],[-3.2,1.5,1.08],[-2.8,1.25,1.25]], 0x1c6ca1);
      addPipe(THREE, root, 'Power harness', [[-.1,-1.25,1.35],[.28,-.9,1.15],[.28,.8,1.2]], 0xa8322a);

      // Presentation plinth.
      addBox(THREE, root, 'Presentation plinth', [0,0,.12], [10.9,8,.46], 0x1a2836, { metalness: .15, roughness: .65 });

      // Make plinth render behind prototype by ordering; Three uses depth so fine.
      lid.position.set(0, 0, 4.75);
      front.position.set(0, -4.1, 1.83);

      const clickable = [];
      root.traverse(o => { if (o.isMesh && o.userData.tag) clickable.push(o); });

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const onPointer = e => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(clickable, false)[0];
        if (hit?.object?.userData?.tag) setSelected(hit.object.userData.tag);
      };
      renderer.domElement.addEventListener('pointerdown', onPointer);

      resize = () => {
        if (!mountRef.current) return;
        const w = mountRef.current.clientWidth || 900;
        const h = mountRef.current.clientHeight || 600;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      };
      resize();
      window.addEventListener('resize', resize);

      sceneRef.current = { THREE, scene, root, camera, controls, lid, front, liquid, beacon, pumpFace, fan, explodedTarget: 1, autoRotate: false, fanActive: false };

      const clock = new THREE.Clock();
      const render = () => {
        const ctx = sceneRef.current;
        if (!ctx) return;
        const dt = Math.min(clock.getDelta(), .04);
        const t = ctx.explodedTarget;
        const lidTargetZ = t ? 4.75 : 2.99;
        const frontTargetY = t ? -4.1 : -2.63;
        ctx.lid.position.z += (lidTargetZ - ctx.lid.position.z) * Math.min(1, dt * 5);
        ctx.front.position.y += (frontTargetY - ctx.front.position.y) * Math.min(1, dt * 5);
        ctx.front.position.z = 1.83;
        if (ctx.autoRotate) ctx.root.rotation.z += dt * .11;
        if (ctx.fanActive) ctx.fan.rotation.x += dt * 11;
        controls.update();
        renderer.render(scene, camera);
        frame = requestAnimationFrame(render);
      };
      render();

      return () => renderer.domElement.removeEventListener('pointerdown', onPointer);
    })();

    return () => {
      disposed = true;
      sceneRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      if (resize) window.removeEventListener('resize', resize);
      controls?.dispose();
      if (renderer) {
        renderer.domElement?.remove();
        renderer.dispose();
      }
    };
  }, []);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.explodedTarget = exploded ? 1 : 0;
  }, [exploded]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const { THREE, root, liquid, beacon, pumpFace } = ctx;
    ctx.fanActive = Boolean(live.fan);
    const status = live.status;
    const statusColor = status === 'CRITICAL' ? 0xc1261b : status === 'WARNING' ? 0xc87900 : 0x18834b;

    if (beacon?.material) {
      beacon.material.color.setHex(live.estop ? 0xc1261b : statusColor);
      beacon.material.emissive.setHex(live.estop ? 0xc1261b : statusColor);
      beacon.material.emissiveIntensity = 1.2;
    }
    if (pumpFace?.material) {
      pumpFace.material.emissive.setHex(live.pump ? 0x168fcd : 0x202b35);
      pumpFace.material.emissiveIntensity = live.pump ? .9 : .05;
    }
    const pct = Number(live.water);
    if (liquid && Number.isFinite(pct)) {
      const h = Math.max(.08, .95 * Math.min(100, Math.max(0, pct)) / 100);
      liquid.scale.y = h / .95;
      liquid.position.z = 1.16 + h / 2;
      liquid.material.color.setHex(pct < 20 ? 0xc1261b : 0x2d8cc7);
    }
    root.traverse(obj => {
      if (!obj.isMesh || !obj.material) return;
      if (obj.name === 'Peltier active layer') {
        obj.material.emissive.setHex(live.peltier ? 0xd98512 : 0x222b32);
        obj.material.emissiveIntensity = live.peltier ? 1 : .03;
      }
    });
  }, [live]);

  function focus(tag) {
    setSelected(tag);
    const ctx = sceneRef.current;
    if (!ctx) return;
    const spots = {
      controller: { p: [-1.9, .6, 1.35], c: [-5.7, -6.4, 4.8] },
      sensor: { p: [-2.8, 1.2, 1.5], c: [-6.5, -5.0, 4.7] },
      power: { p: [-1.1, -1.3, 1.3], c: [-5.7, -6.8, 4.3] },
      cooling: { p: [2.35, .05, 1.6], c: [7.7, -6.8, 5.2] },
      safety: { p: [.4, -1.4, 1.5], c: [4.0, -8.8, 5.4] },
    };
    const s = spots[tag];
    ctx.controls.target.set(...s.p);
    ctx.camera.position.set(...s.c);
    ctx.controls.update();
  }

  const d = DETAILS[selected] || DETAILS.controller;

  return (
    <section className="prototype-wrap">
      <div className="prototype-head">
        <div>
          <div className="eyebrow">Interactive engineering prototype</div>
          <h2>ALTITUDE 3D System View</h2>
          <p>This browser model recreates the uploaded Blender prototype so the physical concept and live telemetry can be presented together.</p>
        </div>
        <div className="prototype-actions">
          <button className={exploded ? 'active' : ''} onClick={() => setExploded(v => !v)}>{exploded ? 'Exploded view' : 'Closed view'}</button>
          <button className={autoRotate ? 'active' : ''} onClick={() => setAutoRotate(v => !v)}>Auto rotate</button>
        </div>
      </div>

      <div className="prototype-layout">
        <div className="model-column">
          <div className="model-stage" ref={mountRef}>
            <div className="model-badge"><span className={`status-led ${live.status.toLowerCase().replace(' ', '-')}`}></span>{live.status}</div>
            <div className="model-help">Drag to rotate · wheel to zoom · click a component</div>
          </div>
          <div className="focus-strip">
            {Object.keys(DETAILS).map(key => <button key={key} className={selected === key ? 'selected' : ''} onClick={() => focus(key)}>{DETAILS[key].title.replace(' Monitoring', '')}</button>)}
          </div>
        </div>

        <aside className="prototype-info">
          <div className="component-card">
            <span className="section-kicker">Selected subsystem</span>
            <h3>{d.title}</h3>
            <p>{d.text}</p>
          </div>
          <div className="live-mini-grid">
            <div><span>Ambient</span><strong>{fmt(live.ambient, ' °C')}</strong></div>
            <div><span>Electronics</span><strong>{fmt(live.temp, ' °C')}</strong></div>
            <div><span>Coolant level</span><strong>{fmt(live.water, ' %', 0)}</strong></div>
            <div><span>Bus voltage</span><strong>{fmt(live.voltage, ' V', 2)}</strong></div>
          </div>
          <div className="actuator-list">
            <div><span>Pump</span><strong className={live.pump ? 'state-on' : ''}>{live.pump ? 'RUNNING' : 'OFF'}</strong></div>
            <div><span>Peltier</span><strong className={live.peltier ? 'state-on' : ''}>{live.peltier ? 'ACTIVE' : 'OFF'}</strong></div>
            <div><span>Radiator fan</span><strong className={live.fan ? 'state-on' : ''}>{live.fan ? 'RUNNING' : 'OFF'}</strong></div>
            <div><span>Emergency stop</span><strong className={live.estop ? 'state-danger' : 'state-safe'}>{live.estop ? 'ACTIVE' : 'SAFE'}</strong></div>
          </div>
          <div className="prototype-note">The original Blender Python generator is included in the project under <code>blender/</code>. This web version is optimized for a live hackathon demo.</div>
        </aside>
      </div>
    </section>
  );
}
