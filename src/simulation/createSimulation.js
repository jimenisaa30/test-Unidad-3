import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  cos,
  hash,
  instanceIndex,
  instancedArray,
  max,
  mix,
  mod,
  sin,
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
  const targetBuffer = instancedArray(count, 'vec3');

  // INITIALIZATION --------------------------------------------------------
  // Each mandala is a separate initializer. This avoids dynamic shader
  // branches and keeps the forms reliable on every WebGPU implementation.
  const createInitializer = (name, positionFor) => Fn(() => {
    const i = instanceIndex;
    const p = positionBuffer.element(i);
    const v = velocityBuffer.element(i);
    const r1 = hash(i.add(uint(11)));
    const r2 = hash(i.add(uint(23)));
    const r3 = hash(i.add(uint(37)));
    const r4 = hash(i.add(uint(53)));
    const r5 = hash(i.add(uint(71)));
    const r6 = hash(i.add(uint(89)));
    p.assign(positionFor(r1, r2, r3));
    v.assign(vec3(r4, r5, r6).sub(0.5).mul(params.initialSpeed));
  })().compute(count).setName(name);

  const initScatter = createInitializer('Initialize Scatter', (r1, r2, r3) =>
    vec3(r1, r2, r3).sub(0.5).mul(params.boundsSize.mul(0.45))
  );
  const initSpiral = createInitializer('Initialize Spiral', (r1, r2, r3) => {
    const angle = r1.mul(Math.PI * 16.0);
    const radius = r1.mul(5.15).add(0.12);
    return vec3(cos(angle).mul(radius), sin(angle).mul(radius), r2.sub(0.5).mul(0.18));
  });
  const initStar = createInitializer('Initialize Star', (r1, r2, r3) => {
    const angle = r1.mul(Math.PI * 2.0);
    const radius = cos(angle.mul(12.0)).mul(1.65).add(3.35).mul(r2.mul(0.035).add(0.982));
    return vec3(cos(angle).mul(radius), sin(angle).mul(radius), r3.sub(0.5).mul(0.18));
  });
  const initHeart = createInitializer('Initialize Heart', (r1, r2, r3) => {
    const angle = r1.mul(Math.PI * 2.0);
    const sine = sin(angle);
    const x = sine.mul(sine).mul(sine).mul(4.25);
    const y = cos(angle).mul(2.1).sub(cos(angle.mul(2.0))).sub(cos(angle.mul(3.0)).mul(0.45)).sub(cos(angle.mul(4.0)).mul(0.22)).mul(1.22);
    return vec3(x, y, r3.sub(0.5).mul(0.18));
  });
  const initializers = [initSpiral, initStar, initHeart, initScatter];
  const createTargetInitializer = (name, positionFor) => Fn(() => {
    const i = instanceIndex;
    const r1 = hash(i.add(uint(11)));
    const r2 = hash(i.add(uint(23)));
    const r3 = hash(i.add(uint(37)));
    targetBuffer.element(i).assign(positionFor(r1, r2, r3));
  })().compute(count).setName(name);
  const targetInitializers = [
    createTargetInitializer('Target Spiral', (r1, r2) => {
      const angle = r1.mul(Math.PI * 16.0); const radius = r1.mul(5.15).add(0.12);
      return vec3(cos(angle).mul(radius), sin(angle).mul(radius), r2.sub(0.5).mul(0.18));
    }),
    createTargetInitializer('Target Star', (r1, r2, r3) => {
      const angle = r1.mul(Math.PI * 2.0); const radius = cos(angle.mul(12.0)).mul(1.65).add(3.35).mul(r2.mul(0.035).add(0.982));
      return vec3(cos(angle).mul(radius), sin(angle).mul(radius), r3.sub(0.5).mul(0.18));
    }),
    createTargetInitializer('Target Heart', (r1, r2, r3) => {
      const angle = r1.mul(Math.PI * 2.0); const sine = sin(angle);
      const x = sine.mul(sine).mul(sine).mul(4.25);
      const y = cos(angle).mul(2.1).sub(cos(angle.mul(2.0))).sub(cos(angle.mul(3.0)).mul(0.45)).sub(cos(angle.mul(4.0)).mul(0.22)).mul(1.22);
      return vec3(x, y, r3.sub(0.5).mul(0.18));
    })
  ];
  let shapeIndex = 0;
  let transitionFrames = 0;

  // UPDATE / COMPUTE SHADER ----------------------------------------------
  // This is the conceptual heart of the project:
  // state -> forces -> acceleration -> velocity -> position.
  const updateParticles = Fn(() => {
    const p = positionBuffer.element(instanceIndex);
    const v = velocityBuffer.element(instanceIndex);

    const dt = params.dt.mul(params.timeScale);
    const force = vec3(0.0).toVar();
    const pulseGain = params.pulse.mul(2.4).add(1.0);

    // 1) CONSTANT / WIND FORCE
    force.addAssign(params.wind.mul(params.windEnabled).mul(params.forceScale).mul(pulseGain));

    // 2) RADIAL FORCE (positive = attraction, negative = repulsion)
    const toAttractor = params.attractor.sub(p);
    const distance = max(toAttractor.length(), params.softening);
    const radialDirection = toAttractor.div(distance);
    const radialForce = radialDirection
      .mul(params.radialStrength)
      .div(distance.pow(2))
      .mul(params.radialEnabled);
    force.addAssign(radialForce.mul(params.forceScale).mul(pulseGain));

    // 3) VORTEX FORCE: tangent to the radial direction around Z.
    const zAxis = vec3(0.0, 0.0, 1.0);
    const tangent = zAxis.cross(radialDirection);
    force.addAssign(tangent.mul(params.vortexStrength).mul(params.vortexEnabled).mul(params.forceScale).mul(pulseGain));

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

  const transitionParticles = Fn(() => {
    const p = positionBuffer.element(instanceIndex);
    p.addAssign(targetBuffer.element(instanceIndex).sub(p).mul(0.045));
  })().compute(count).setName('Morph Mandala');

  // RENDER ---------------------------------------------------------------
  // Rendering does not recompute the physics. It consumes the GPU state.
  const material = new THREE.SpriteNodeMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true
  });

  material.positionNode = positionBuffer.toAttribute();
  material.scaleNode = params.particleSize;

  material.colorNode = Fn(() => {
    const speed = velocityBuffer.toAttribute().length();
    const t = speed.div(params.maxSpeed).clamp(0.0, 1.0);
    return vec4(mix(mix(params.colorA, params.colorB, t), params.colorC, t.mul(t)), 1.0);
  })();

  // Circular sprite mask, avoiding visible square planes.
  material.opacityNode = step(uv().xy.sub(0.5).length(), 0.5);

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  scene.add(mesh);

  function reset() {
    renderer.compute(initializers[shapeIndex]);
  }

  function setShape(nextShape) {
    shapeIndex = nextShape;
    renderer.compute(targetInitializers[shapeIndex]);
    transitionFrames = 125;
  }

  function stepSimulation() {
    if (transitionFrames > 0) {
      renderer.compute(transitionParticles);
      transitionFrames--;
    }
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
    targetBuffer,
    setShape,
    reset,
    stepSimulation,
    dispose
  };
}
