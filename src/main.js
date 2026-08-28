import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import './styles.css';

import { createParameters } from './simulation/parameters.js';
import { createSimulation } from './simulation/createSimulation.js';
import { createLabPanel } from './ui/labPanel.js';

const PARTICLE_COUNT = 131072; // 2^17. The visible amount is controlled live.

async function main() {
  const mount = document.querySelector('#app');

  if (!WebGPU.isAvailable()) {
    mount.appendChild(WebGPU.getErrorMessage());
    throw new Error('Este proyecto requiere WebGPU para ejecutar compute shaders.');
  }

  // THREE.JS MENTAL MODEL: scene + camera + renderer ---------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#12051d');

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(0, 0, 11);

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  mount.appendChild(renderer.domElement);
  await renderer.init();

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.target.set(0, 0, 0);

  const params = createParameters();
  const simulation = createSimulation({ renderer, scene, params, count: PARTICLE_COUNT });

  // LAB HELPERS -----------------------------------------------------------
  const attractorHelper = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshBasicMaterial({ color: '#ffffff' })
  );
  scene.add(attractorHelper);
  const axes = new THREE.AxesHelper(1.5);
  scene.add(axes);

  // POINTER -> WORLD POSITION --------------------------------------------
  // This is a useful camera concept: screen coordinates are not world coords.
  const pointerNdc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const interactionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();

  addEventListener('pointermove', (event) => {
    pointerNdc.x = (event.clientX / innerWidth) * 2 - 1;
    pointerNdc.y = -(event.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    if (raycaster.ray.intersectPlane(interactionPlane, hit)) {
      params.attractor.value.copy(hit);
      attractorHelper.position.copy(hit);
    }
  });

  let paused = false;
  let mode = 'LAB';
  let panel;
  let savedRadialStrength = params.radialStrength.value;
  const palettes = [
    ['#12051d', '#ff2b9a', '#50e6ff'],
    ['#071b27', '#f5e742', '#ff5c35'],
    ['#19102d', '#bd7bff', '#7affc4'],
    ['#250b10', '#ff786a', '#ffe56b']
  ];
  const controlLevels = {
    radius: [0.15, 0.3, 0.55, 0.9, 1.3], size: [0.016, 0.028, 0.04, 0.058, 0.08],
    drag: [0.03, 0.08, 0.15, 0.25, 0.38], particles: [16384, 32768, 65536, 98304, 131072],
    power: [0.45, 0.75, 1, 1.5, 2.1]
  };
  const levelIndex = { radius: 2, size: 2, drag: 2, particles: 4, power: 2 };

  const cycle = (name) => {
    levelIndex[name] = (levelIndex[name] + 1) % controlLevels[name].length;
    const value = controlLevels[name][levelIndex[name]];
    if (name === 'radius') params.softening.value = value;
    if (name === 'size') params.particleSize.value = value;
    if (name === 'drag') params.dragCoefficient.value = value;
    if (name === 'particles') params.activeCount.value = value;
    if (name === 'power') params.forceScale.value = value;
    panel?.refresh();
  };

  const randomPalette = () => {
    const [background, slow, fast] = palettes[Math.floor(Math.random() * palettes.length)];
    scene.background.set(background);
    params.colorSlow.value.set(slow);
    params.colorFast.value.set(fast);
    document.documentElement.style.setProperty('--accent', slow);
    document.documentElement.style.setProperty('--accent-cool', fast);
  };

  const updateHud = () => {
    const form = ['ESPIRAL', 'ESTRELLA', 'CORAZÓN'][params.shapeMode.value];
    hud.innerHTML = mode === 'LAB'
      ? '<strong>LAB · GEOMETRÍAS EN FUERZA</strong><br>Q gravedad · W repulsión · E atracción · R vórtice · T aire<br>1 radio · 2 tamaño · 3 amortiguamiento · 4 partículas · 5 potencia · 8 forma · C color · P performance'
      : `<strong>PERFORMANCE · ${form}</strong><br>Q/W/E/R/T fuerzas · 1–5 parámetros · 8 forma · C paleta · P interfaz`;
  };

  const setShape = (shape) => {
    params.shapeMode.value = shape;
    simulation.reset();
    updateHud();
  };

  const applyPreset = (id) => {
    params.windEnabled.value = 0;
    params.radialEnabled.value = 0;
    params.vortexEnabled.value = 0;
    params.dragEnabled.value = 0;
    params.wind.value.set(0, 0, 0);
    params.initialSpeed.value = 0;

    if (id === 'attract') {
      params.radialEnabled.value = 1;
      params.radialStrength.value = 3.0;
    } else if (id === 'repel') {
      params.radialEnabled.value = 1;
      params.radialStrength.value = -3.0;
    } else if (id === 'vortex') {
      params.radialEnabled.value = 1;
      params.radialStrength.value = 1.0;
      params.vortexEnabled.value = 1;
      params.vortexStrength.value = 3.0;
      params.dragEnabled.value = 1;
      params.dragCoefficient.value = 0.08;
    }
    simulation.reset();
    panel?.refresh();
  };

  const applyGravityDrop = () => {
    params.windEnabled.value = 1;
    params.wind.value.set(0, -12.0, 0);
    params.radialEnabled.value = 0;
    params.vortexEnabled.value = 0;
    params.dragEnabled.value = 0;
    params.initialSpeed.value = 0;
    simulation.reset();
    panel?.refresh();
  };

  const setMode = (next) => {
    mode = next;
    const lab = mode === 'LAB';
    panel.setVisible(lab);
    axes.visible = lab;
    attractorHelper.visible = lab;
    orbit.enabled = lab;
    updateHud();
  };

  panel = createLabPanel({
    params,
    onReset: () => simulation.reset(),
    onPreset: applyPreset,
    onModeChange: () => setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB'),
    onPauseChange: () => paused = !paused,
    onGravityDrop: applyGravityDrop
  });

  const hud = document.createElement('div');
  hud.className = 'hud';
  document.body.append(hud);
  setMode('LAB');

  // BASELINE LIVE INSTRUMENT MAPPING -------------------------------------
  // Students are expected to redesign this mapping for their own instrument.
  addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === 'KeyP') setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB');
    if (event.code === 'KeyC') randomPalette();
    if (event.code === 'Digit1') cycle('radius');
    if (event.code === 'Digit2') cycle('size');
    if (event.code === 'Digit3') cycle('drag');
    if (event.code === 'Digit4') cycle('particles');
    if (event.code === 'Digit5') cycle('power');
    if (event.code === 'Digit8') setShape((params.shapeMode.value + 1) % 3);

    // These can be combined: the keyboard becomes an instrument.
    if (event.code === 'KeyQ') {
      params.windEnabled.value = params.windEnabled.value > 0 ? 0 : 1;
      if (params.windEnabled.value > 0) params.wind.value.set(0, -12.0, 0);
      panel?.refresh();
    }
    if (event.code === 'KeyW') { params.radialEnabled.value = 1; params.radialStrength.value = -3.0; panel?.refresh(); }
    if (event.code === 'KeyE') { params.radialEnabled.value = 1; params.radialStrength.value = 3.0; panel?.refresh(); }
    if (event.code === 'KeyR') { params.vortexEnabled.value = params.vortexEnabled.value > 0 ? 0 : 1; panel?.refresh(); }
    if (event.code === 'KeyT') { params.dragEnabled.value = params.dragEnabled.value > 0 ? 0 : 1; panel?.refresh(); }

    if (event.code === 'Space') {
      event.preventDefault();
      savedRadialStrength = params.radialStrength.value || 2.0;
      params.radialEnabled.value = 1;
      params.radialStrength.value = -savedRadialStrength;
    }

    // + key: increase drag coefficient
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      event.preventDefault();
      params.dragCoefficient.value = Math.min(1, params.dragCoefficient.value + 0.05);
      panel?.refresh();
    }

    // - key: decrease drag coefficient
    if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      params.dragCoefficient.value = Math.max(0, params.dragCoefficient.value - 0.05);
      panel?.refresh();
    }

    if (event.code === 'Enter') simulation.reset();
  });

  addEventListener('keyup', (event) => {
    if (event.code === 'Space') params.radialStrength.value = savedRadialStrength;
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  simulation.reset();
  updateHud();

  // FRAME LOOP ------------------------------------------------------------
  renderer.setAnimationLoop(() => {
    if (!paused) simulation.stepSimulation();
    orbit.update();
    renderer.render(scene, camera);
  });
}

main().catch((error) => {
  console.error(error);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:16px;white-space:pre-wrap;color:#fff;z-index:50';
  pre.textContent = String(error?.stack || error);
  document.body.append(pre);
});
