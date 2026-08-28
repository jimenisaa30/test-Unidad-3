import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import './styles.css';

import { createParameters } from './simulation/parameters.js';
import { createSimulation } from './simulation/createSimulation.js';
import { createLabPanel } from './ui/labPanel.js';

const PARTICLE_COUNT = 131072; // 2^17. Increase only after measuring performance.

async function main() {
  const mount = document.querySelector('#app');

  if (!WebGPU.isAvailable()) {
    mount.appendChild(WebGPU.getErrorMessage());
    throw new Error('Este proyecto requiere WebGPU para ejecutar compute shaders.');
  }

  // THREE.JS MENTAL MODEL: scene + camera + renderer ---------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050607');

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

  let paused = false;
  let mode = 'LAB';
  let panel;
  let shapeIndex = 0;
  const levels = {
    radius: [0.18, 0.35, 0.55, 0.8, 1.1],
    size: [0.008, 0.012, 0.018, 0.026, 0.038],
    air: [0.03, 0.08, 0.14, 0.22, 0.32],
    speed: [1.8, 3, 4.5, 6.5, 8],
    power: [0.35, 0.6, 0.9, 1.25, 1.65]
  };
  const levelIndex = { radius: 2, size: 2, air: 2, speed: 2, power: 2 };

  const cycle = (name) => {
    levelIndex[name] = (levelIndex[name] + 1) % levels[name].length;
    const value = levels[name][levelIndex[name]];
    if (name === 'radius') params.softening.value = value;
    if (name === 'size') params.particleSize.value = value;
    if (name === 'air') params.dragCoefficient.value = value;
    if (name === 'speed') params.maxSpeed.value = value;
    if (name === 'power') params.forceScale.value = value;
    panel?.refresh();
  };

  const randomPalette = () => {
    const hue = Math.random();
    params.colorA.value.setHSL(hue, 0.9, 0.58);
    params.colorB.value.setHSL((hue + 1 / 3) % 1, 0.9, 0.62);
    params.colorC.value.setHSL((hue + 2 / 3) % 1, 0.9, 0.66);
    scene.background.setHSL((hue + 0.58) % 1, 0.52, 0.07);
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
    hud.innerHTML = lab
      ? '<strong>LAB · GEOMETRÍAS EN FUERZA</strong><br>Q gravedad · W repulsión · E atracción · R vórtice · T aire<br>1 radio · 2 tamaño · 3 amortiguamiento · 4 velocidad · 5 potencia · 8 forma · C paleta · Enter reinicia'
      : '<strong>PERFORMANCE</strong> · Q/W/E/R/T fuerzas · 1–5 parámetros · 8 forma · C paleta · P interfaz';
  };

  panel = createLabPanel({
    params,
    onReset: () => simulation.reset(),
    onPreset: applyPreset,
    onModeChange: () => setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB'),
    onPauseChange: () => paused = !paused,
    onGravityDrop: applyGravityDrop,
    onShape: (shape) => { shapeIndex = shape; simulation.setShape(shape); }
  });

  const hud = document.createElement('div');
  hud.className = 'hud';
  document.body.append(hud);
  setMode('LAB');

  addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === 'KeyP') setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB');
    if (event.code === 'KeyC') randomPalette();
    if (event.code === 'Digit1') cycle('radius');
    if (event.code === 'Digit2') cycle('size');
    if (event.code === 'Digit3') cycle('air');
    if (event.code === 'Digit4') cycle('speed');
    if (event.code === 'Digit5') cycle('power');
    if (event.code === 'Digit8') { shapeIndex = (shapeIndex + 1) % 3; simulation.setShape(shapeIndex); }
    if (event.code === 'Enter') simulation.reset();

    if (event.code === 'KeyQ') { params.windEnabled.value = params.windEnabled.value > 0 ? 0 : 1; params.wind.value.set(0, -1.1, 0); }
    if (event.code === 'KeyW') { params.radialEnabled.value = 1; params.radialStrength.value = -1.4; }
    if (event.code === 'KeyE') { params.radialEnabled.value = 1; params.radialStrength.value = 1.4; }
    if (event.code === 'KeyR') params.vortexEnabled.value = params.vortexEnabled.value > 0 ? 0 : 1;
    if (event.code === 'KeyT') params.dragEnabled.value = params.dragEnabled.value > 0 ? 0 : 1;
    panel?.refresh();
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  simulation.reset();

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
