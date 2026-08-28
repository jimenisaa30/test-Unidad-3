import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  hash,
  instanceIndex,
  instancedArray,
  max,
  mix,
  mod,
  step,
  uint,
  uv,
  vec3,
  vec4
} from 'three/tsl';

export function createSimulation({ renderer, scene, params, count = 131072 }) {
  // STATE -----------------------------------------------------------------
  // Each particle owns position and velocity. The arrays live in GPU storage.
  const positionBuffer = instancedArray(count, 'vec3');
  const velocityBuffer = instancedArray(count, 'vec3');

  // CPU-authored target positions are only a render layer. This keeps the
  // WebGPU force pass simple and makes shape changes reliable across drivers.
  const mandalaFrom = new Float32Array(count * 3);
  const mandalaTo = new Float32Array(count * 3);
  const random = (i, seed) => {
    const value = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return value - Math.floor(value);
  };
  const fillMandala = (data, mode) => {
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = t * Math.PI * 2;
      // A very small variance preserves the readable contour of the mandala.
      const jitter = (random(i, 3) - 0.5) * 0.018;
      let x; let y;
      if (mode === 1) {
        const r = (2.1 + Math.cos(a * 5) * 1.35) * (0.96 + random(i, 5) * 0.04);
        x = Math.cos(a) * r;
        y = Math.sin(a) * r;
      } else if (mode === 2) {
        x = 3.2 * Math.pow(Math.sin(a), 3);
        y = (2.1 * Math.cos(a) - Math.cos(2 * a) - 0.45 * Math.cos(3 * a) - 0.22 * Math.cos(4 * a)) * 0.9;
      } else {
        const r = 0.25 + t * 4.1;
        const turn = t * Math.PI * 12;
        x = Math.cos(turn) * r;
        y = Math.sin(turn) * r;
      }
      data[i * 3] = x + jitter;
      data[i * 3 + 1] = y + jitter;
      data[i * 3 + 2] = (random(i, 7) - 0.5) * 0.12;
    }
  };
  fillMandala(mandalaFrom, 0);
  fillMandala(mandalaTo, 0);

  // INITIALIZATION --------------------------------------------------------
  // A compute pass writes the initial state for every particle in parallel.
  const initParticles = Fn(() => {
    const i = instanceIndex;
    const p = positionBuffer.element(i);
    const v = velocityBuffer.element(i);

    const r1 = hash(i.add(uint(11)));
    const r2 = hash(i.add(uint(23)));
    const r3 = hash(i.add(uint(37)));
    const r4 = hash(i.add(uint(53)));
    const r5 = hash(i.add(uint(71)));
    const r6 = hash(i.add(uint(89)));

    p.assign(vec3(r1, r2, r3).sub(0.5).mul(params.boundsSize.mul(0.45)));
    v.assign(vec3(r4, r5, r6).sub(0.5).mul(params.initialSpeed));
  })().compute(count).setName('Initialize Particles');

  // UPDATE / COMPUTE SHADER ----------------------------------------------
  // This is the conceptual heart of the project:
  // state -> forces -> acceleration -> velocity -> position.
  const updateParticles = Fn(() => {
    const p = positionBuffer.element(instanceIndex);
    const v = velocityBuffer.element(instanceIndex);

    const dt = params.dt.mul(params.timeScale);
    const force = vec3(0.0).toVar();

    // The geometric targets are prepared on the GPU for the next transition.
    // They are deliberately not part of this force pass yet: some WebGPU
    // drivers reject mixing storage-buffer reads here and leave no particles
    // on screen. The initial mandala and the physical forces remain visible.

    // 1) CONSTANT / WIND FORCE
    force.addAssign(params.wind.mul(params.windEnabled));

    // 2) RADIAL FORCE (positive = attraction, negative = repulsion)
    const toAttractor = params.attractor.sub(p);
    const distance = max(toAttractor.length(), params.softening);
    const radialDirection = toAttractor.div(distance);
    const radialForce = radialDirection
      .mul(params.radialStrength)
      .div(distance.pow(2))
      .mul(params.radialEnabled);
    force.addAssign(radialForce.mul(params.forceScale));

    // 3) VORTEX FORCE: tangent to the radial direction around Z.
    const zAxis = vec3(0.0, 0.0, 1.0);
    const tangent = zAxis.cross(radialDirection);
    force.addAssign(tangent.mul(params.vortexStrength).mul(params.vortexEnabled).mul(params.forceScale));

    // 4) LINEAR DRAG: F = -c v
    force.addAssign(v.mul(params.dragCoefficient).mul(params.dragEnabled).mul(-1.0));

    // INTEGRATION ---------------------------------------------------------
    // Unit mass: a = F. Semi-implicit Euler: update v, then p.
    v.addAssign(force.mul(dt));

    const speed = v.length();
    If(speed.greaterThan(params.maxSpeed), () => {
      v.assign(v.normalize().mul(params.maxSpeed));
    });

    p.addAssign(v.mul(dt));

    // Periodic boundary conditions: particles leaving one side re-enter.
    const half = params.boundsSize.mul(0.5);
    p.assign(mod(p.add(half), params.boundsSize).sub(half));
  })().compute(count).setName('Update Particles');

  // RENDER ---------------------------------------------------------------
  // Rendering does not recompute the physics. It consumes the GPU state.
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mandalaFromAttribute = new THREE.InstancedBufferAttribute(mandalaFrom, 3);
  const mandalaToAttribute = new THREE.InstancedBufferAttribute(mandalaTo, 3);
  geometry.setAttribute('mandalaFrom', mandalaFromAttribute);
  geometry.setAttribute('mandalaTo', mandalaToAttribute);

  const material = new THREE.SpriteNodeMaterial({
    // Normal blending keeps dense particle paths colorful instead of white.
    blending: THREE.NormalBlending,
    depthWrite: false,
    transparent: true
  });

  const physicsPosition = positionBuffer.toAttribute();
  const shapePosition = mix(attribute('mandalaFrom', 'vec3'), attribute('mandalaTo', 'vec3'), params.shapeBlend);
  // A little physical motion remains visible inside each mandala.
  material.positionNode = mix(physicsPosition, shapePosition, 0.92);
  material.scaleNode = params.particleSize;

  material.colorNode = Fn(() => {
    const speed = velocityBuffer.toAttribute().length();
    const t = speed.div(params.maxSpeed).clamp(0.0, 1.0);
    const firstBlend = mix(params.colorA, params.colorB, t);
    return vec4(mix(firstBlend, params.colorC, t.mul(t)), 1.0);
  })();

  // Circular sprite mask, avoiding visible square planes.
  // Keep the sprite mask independent from the instance index. Comparing a
  // uint instance index with a float uniform can compile differently across
  // WebGPU implementations and was making the whole mandala transparent.
  material.opacityNode = step(uv().xy.sub(0.5).length(), 0.5);

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  scene.add(mesh);

  function reset() {
    renderer.compute(initParticles);
  }

  function stepSimulation() {
    renderer.compute(updateParticles);
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    scene.remove(mesh);
  }

  return {
    count,
    positionBuffer,
    velocityBuffer,
    setShapeTarget(mode) {
      mandalaFrom.set(mandalaTo);
      fillMandala(mandalaTo, mode);
      mandalaFromAttribute.needsUpdate = true;
      mandalaToAttribute.needsUpdate = true;
    },
    commitShapeTarget() {
      mandalaFrom.set(mandalaTo);
      mandalaFromAttribute.needsUpdate = true;
    },
    reset,
    stepSimulation,
    dispose
  };
}
