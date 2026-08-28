import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// Uniforms are CPU-side values that TSL exposes to the GPU.
// Changing .value does not rebuild the compute shader.
export function createParameters() {
  return {
    dt: uniform(1 / 60),
    timeScale: uniform(1.0),
    initialSpeed: uniform(0.12),
    maxSpeed: uniform(5.0),
    boundsSize: uniform(10.0),
    particleSize: uniform(0.018),
    activeCount: uniform(131072.0),
    shapeMode: uniform(0.0),
    shapeStrength: uniform(2.4),
    shapeBlend: uniform(0.0),
    shapeScale: uniform(1.0),
    pointerPulse: uniform(0.0),
    pointerStrength: uniform(3.2),
    forceScale: uniform(1.0),
    colorShift: uniform(0.0),
    colorA: uniform(new THREE.Color('#ff2b9a')),
    colorB: uniform(new THREE.Color('#50e6ff')),
    colorC: uniform(new THREE.Color('#ffe35c')),

    windEnabled: uniform(0.0),
    wind: uniform(new THREE.Vector3(0.0, 0.0, 0.0)),

    radialEnabled: uniform(0.0),
    attractor: uniform(new THREE.Vector3(0.0, 0.0, 0.0)),
    radialStrength: uniform(2.2),
    softening: uniform(0.35),

    vortexEnabled: uniform(0.0),
    vortexStrength: uniform(1.4),

    dragEnabled: uniform(1.0),
    dragCoefficient: uniform(0.12)
  };
}
