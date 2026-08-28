import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  hash,
  instanceIndex,
  instancedArray,
  max,
  mix,
  mod,
  cos,
  sin,
  select,
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
  const targetFromBuffer = instancedArray(count, 'vec3');
  const targetToBuffer = instancedArray(count, 'vec3');

  // INITIALIZATION --------------------------------------------------------
  // A compute pass writes the initial state for every particle in parallel.
  const initParticles = Fn(() => {
    const i = instanceIndex;
    const p = positionBuffer.element(i);
    const v = velocityBuffer.element(i);
    const targetFrom = targetFromBuffer.element(i);
    const targetTo = targetToBuffer.element(i);

    const r1 = hash(i.add(uint(11)));
    const r2 = hash(i.add(uint(23)));
    const r3 = hash(i.add(uint(37)));
    const r4 = hash(i.add(uint(53)));
    const r5 = hash(i.add(uint(71)));
    const r6 = hash(i.add(uint(89)));

    const angle = r1.mul(Math.PI * 2.0);
    const spiralAngle = r1.mul(Math.PI * 12.0);
    const spiralRadius = r1.mul(4.3);
    const spiral = vec3(cos(spiralAngle).mul(spiralRadius), sin(spiralAngle).mul(spiralRadius), r2.sub(0.5).mul(0.35));
    const starRadius = cos(angle.mul(5.0)).mul(1.45).add(3.0).mul(r2.mul(0.55).add(0.45));
    const star = vec3(cos(angle).mul(starRadius), sin(angle).mul(starRadius), r3.sub(0.5).mul(0.3));
    const heart = vec3(
      sin(angle).pow(3.0).mul(3.2),
      cos(angle).mul(2.1).sub(cos(angle.mul(2.0))).sub(cos(angle.mul(3.0)).mul(0.45)).sub(cos(angle.mul(4.0)).mul(0.22)).mul(0.9),
      r3.sub(0.5).mul(0.25)
    );
    const initialPosition = select(params.shapeMode.equal(2.0), heart, select(params.shapeMode.equal(1.0), star, spiral));
    p.assign(initialPosition);
    targetFrom.assign(initialPosition);
    targetTo.assign(initialPosition);
    v.assign(vec3(r4, r5, r6).sub(0.5).mul(params.initialSpeed));
  })().compute(count).setName('Initialize Particles');

  // Writes only the destination mandala; position stays continuous.
  const writeShapeTarget = Fn(() => {
    const i = instanceIndex;
    const r1 = hash(i.add(uint(11)));
    const r2 = hash(i.add(uint(23)));
    const r3 = hash(i.add(uint(37)));
    const angle = r1.mul(Math.PI * 2.0);
    const spiralAngle = r1.mul(Math.PI * 12.0);
    const spiralRadius = r1.mul(4.3);
    const spiral = vec3(cos(spiralAngle).mul(spiralRadius), sin(spiralAngle).mul(spiralRadius), r2.sub(0.5).mul(0.35));
    const starRadius = cos(angle.mul(5.0)).mul(1.45).add(3.0).mul(r2.mul(0.55).add(0.45));
    const star = vec3(cos(angle).mul(starRadius), sin(angle).mul(starRadius), r3.sub(0.5).mul(0.3));
    const heart = vec3(
      sin(angle).pow(3.0).mul(3.2),
      cos(angle).mul(2.1).sub(cos(angle.mul(2.0))).sub(cos(angle.mul(3.0)).mul(0.45)).sub(cos(angle.mul(4.0)).mul(0.22)).mul(0.9),
      r3.sub(0.5).mul(0.25)
    );
    targetToBuffer.element(i).assign(select(params.shapeMode.equal(2.0), heart, select(params.shapeMode.equal(1.0), star, spiral)));
  })().compute(count).setName('Set Mandala Destination');

  const commitShapeTarget = Fn(() => {
    targetFromBuffer.element(instanceIndex).assign(targetToBuffer.element(instanceIndex));
  })().compute(count).setName('Commit Mandala Destination');

  // UPDATE / COMPUTE SHADER ----------------------------------------------
  // This is the conceptual heart of the project:
  // state -> forces -> acceleration -> velocity -> position.
  const updateParticles = Fn(() => {
    const p = positionBuffer.element(instanceIndex);
    const v = velocityBuffer.element(instanceIndex);

    const dt = params.dt.mul(params.timeScale);
    const force = vec3(0.0).toVar();

    // Shape memory keeps the choreography legible while other forces act.
    const shapeTarget = mix(targetFromBuffer.element(instanceIndex), targetToBuffer.element(instanceIndex), params.shapeBlend);
    force.addAssign(shapeTarget.sub(p).mul(params.shapeStrength));

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
    // Three phase-shifted waves traverse the entire chromatic circle.
    const hue = instanceIndex.mul(0.0007).add(t.mul(1.6)).add(params.colorShift);
    const spectrum = vec3(
      sin(hue).mul(0.5).add(0.5),
      sin(hue.add(2.094)).mul(0.5).add(0.5),
      sin(hue.add(4.188)).mul(0.5).add(0.5)
    );
    return vec4(spectrum, 1.0);
  })();

  // Circular sprite mask, avoiding visible square planes.
  material.opacityNode = step(uv().xy.sub(0.5).length(), 0.5).mul(step(instanceIndex, params.activeCount));

  const geometry = new THREE.PlaneGeometry(1, 1);
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
    targetFromBuffer,
    targetToBuffer,
    setShapeTarget() { renderer.compute(writeShapeTarget); },
    commitShapeTarget() { renderer.compute(commitShapeTarget); },
    reset,
    stepSimulation,
    dispose
  };
}
