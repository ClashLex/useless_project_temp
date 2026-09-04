import * as THREE from 'three';
import { JOINTS, BONES, idlePose } from './pose.js';

// Raw MediaPipe x,y in [0,1] -> scene units. Mirror x for mirror feel.
// FIXED span (not camera.aspect): coupling body shape to window size made the
// skeleton stretch every time the window resized. Camera handles aspect.
const SCENE_X = 1.35;
function toScene(lm) {
  return {
    x: (0.5 - lm.x) * 2 * SCENE_X,
    y: (0.5 - lm.y) * 2 + 0.05,
    z: (lm.z ?? 0) * -1,
  };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function placeLimb(mesh, pa, pb) {
  _a.set(pa.x, pa.y, pa.z);
  _b.set(pb.x, pb.y, pb.z);
  _mid.addVectors(_a, _b).multiplyScalar(0.5);
  _dir.subVectors(_b, _a);
  const len = Math.max(_dir.length(), 1e-4);
  mesh.position.copy(_mid);
  mesh.quaternion.setFromUnitVectors(_up, _dir.normalize());
  mesh.scale.set(1, len, 1);
}

export function createAvatar(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 5, 9);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0.05, 3.4);
  camera.lookAt(0, -0.05, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(1.5, 2.5, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x00ff66, 0.5);
  rim.position.set(-2, 1, -2);
  scene.add(rim);

  const grid = new THREE.GridHelper(6, 12, 0x00ff66, 0x0a3d1f);
  grid.position.y = -1.15;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.matrixAutoUpdate = false; // static — skip per-frame matrix recompute
  grid.updateMatrix();
  scene.add(grid);

  const jointMat = new THREE.MeshStandardMaterial({ color: 0x00ff66, roughness: 0.4, metalness: 0.1 });
  const limbMat = new THREE.MeshStandardMaterial({ color: 0x00cc52, roughness: 0.5, metalness: 0.1 });
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.25 });
  // amber = time-travel: instantly reads as "history, not live"
  const playJointMat = new THREE.MeshStandardMaterial({ color: 0xffbd2e, roughness: 0.4, metalness: 0.1 });
  const playLimbMat = new THREE.MeshStandardMaterial({ color: 0xcc9420, roughness: 0.5, metalness: 0.1 });

  const joints = new Map();
  for (const j of JOINTS) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(j.r, 12, 12), jointMat);
    scene.add(m);
    joints.set(j.name, m);
  }

  const limbGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 8, 1);
  const limbs = BONES.map(([a, b]) => {
    const m = new THREE.Mesh(limbGeo, limbMat);
    m.frustumCulled = false;
    scene.add(m);
    return { a, b, m };
  });

  // faint idle ghost so stage is never black
  const ghost = new THREE.Group();
  const ghostPts = idlePose();
  for (const [, p] of ghostPts) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), ghostMat);
    m.position.set(p.x, p.y, p.z);
    ghost.add(m);
  }
  scene.add(ghost);

  // visual diff overlay: two ghost skeletons, A green vs B amber.
  // Independent of live/playback rendering — persists until cleared.
  const diffGroup = new THREE.Group();
  diffGroup.visible = false;
  scene.add(diffGroup);
  function makeGhost(color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 });
    const geo = new THREE.SphereGeometry(0.024, 10, 10);
    const spheres = new Map();
    for (const j of JOINTS) {
      const s = new THREE.Mesh(geo, mat);
      g.add(s);
      spheres.set(j.name, s);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BONES.length * 6), 3));
    const lines = new THREE.LineSegments(
      bg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
    );
    lines.frustumCulled = false;
    g.add(lines);
    diffGroup.add(g);
    return { spheres, lines };
  }
  const ghostA = makeGhost(0x00ff66);
  const ghostB = makeGhost(0xffbd2e);
  function poseGhost(ghost, sceneObj) {
    const pts = new Map();
    for (const j of JOINTS) {
      const p = sceneObj?.[j.name];
      const s = ghost.spheres.get(j.name);
      if (!p) { s.visible = false; continue; }
      s.visible = true;
      s.position.set(p.x, p.y, p.z);
      pts.set(j.name, p);
    }
    const arr = ghost.lines.geometry.attributes.position.array;
    BONES.forEach(([a, b], i) => {
      const pa = pts.get(a) || { x: 0, y: -99, z: 0 };
      const pb = pts.get(b) || { x: 0, y: -99, z: 0 };
      arr.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
    });
    ghost.lines.geometry.attributes.position.needsUpdate = true;
  }
  function showDiff(sceneA, sceneB) {
    if (!sceneA || !sceneB) return false;
    poseGhost(ghostA, sceneA);
    poseGhost(ghostB, sceneB);
    diffGroup.visible = true;
    return true;
  }
  function clearDiff() { diffGroup.visible = false; }

  // visual smoothing state (render-only, not commit logic)
  let smooth = idlePose();
  let hasLock = false;
  const SMOOTH = 0.6;

  // playback (checkout): tweened time-travel pose. While active, live
  // landmarks are ignored and commit logic must stay frozen (see main.js).
  let playback = null;
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function copyMap(m) {
    const out = new Map();
    for (const [k, p] of m) out.set(k, { x: p.x, y: p.y, z: p.z });
    return out;
  }

  // current rendered pose, so a new checkout mid-tween starts from what's
  // on screen instead of snapping back to the stale live pose
  function currentView() {
    if (playback) {
      const k = easeInOutCubic(Math.min(1, (performance.now() - playback.start) / playback.dur));
      const out = new Map();
      for (const [name, a] of playback.from) {
        const b = playback.to.get(name) || a;
        out.set(name, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
      }
      return out;
    }
    return copyMap(hasLock ? smooth : ghostPts);
  }

  // render-space snapshot for commit storage (plain object, 13 joints)
  function getScene() {
    if (!hasLock) return null;
    const out = {};
    for (const [n, p] of smooth) out[n] = { x: p.x, y: p.y, z: p.z };
    return out;
  }

  function playTo(sceneObj, dur = 600) {
    if (!sceneObj) return false;
    const from = currentView();
    const to = new Map();
    for (const j of JOINTS) {
      to.set(j.name, sceneObj[j.name] ? { ...sceneObj[j.name] } : { ...(from.get(j.name) || { x: 0, y: 0, z: 0 }) });
    }
    playback = { from, to, start: performance.now(), dur };
    ghost.visible = false;
    return true;
  }

  function resumeLive() {
    playback = null;
    hasLock = false; // snap to live body on next frame, no float-in
  }

  function resize() {
    const w = canvas.parentElement.clientWidth || 640;
    const h = canvas.parentElement.clientHeight || 480;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  window.addEventListener('resize', resize);
  resize();

  // last processed input ref — camera runs ~30fps on 60Hz displays, so half
  // the rAFs would redo identical math. Same ref + lock = just re-render.
  let lastInput = null;

  function drawLive(isTracked) {
    const pts = isTracked ? smooth : ghostPts;
    for (const [name, mesh] of joints) {
      const p = pts.get(name);
      if (!p) { mesh.visible = false; continue; }
      mesh.visible = true;
      // idle ghost pose is static; live pose uses smoothed values
      const src = isTracked ? smooth.get(name) : p;
      mesh.position.set(src.x, src.y, src.z);
      mesh.material = isTracked ? jointMat : ghostMat;
    }
    for (const { a, b, m } of limbs) {
      const pa = (isTracked ? smooth : pts).get(a);
      const pb = (isTracked ? smooth : pts).get(b);
      if (!pa || !pb) { m.visible = false; continue; }
      m.visible = true;
      m.material = isTracked ? limbMat : ghostMat;
      placeLimb(m, pa, pb);
    }
    renderer.render(scene, camera);
  }

  function update(landmarks) {
    // checkout playback: hold history pose, ignore live landmarks entirely
    if (playback) {
      const k = easeInOutCubic(Math.min(1, (performance.now() - playback.start) / playback.dur));
      for (const [name, mesh] of joints) {
        const a = playback.from.get(name), b = playback.to.get(name);
        if (!a || !b) { mesh.visible = false; continue; }
        mesh.visible = true;
        mesh.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
        mesh.material = playJointMat;
      }
      for (const { a, b, m } of limbs) {
        const pa = joints.get(a)?.position, pb = joints.get(b)?.position;
        if (!pa || !pb) { m.visible = false; continue; }
        m.visible = true;
        m.material = playLimbMat;
        placeLimb(m, pa, pb);
      }
      renderer.render(scene, camera);
      return { tracked: false, playback: true, done: k >= 1 };
    }

    // v1 rule: any landmarks array = tracked. No visibility gating.
    let tracked = !!landmarks;
    let target = null;

    if (landmarks) {
      if (landmarks === lastInput && hasLock) {
        drawLive(true);
        return { tracked: true, playback: false };
      }
      lastInput = landmarks;
      target = new Map();
      for (const j of JOINTS) {
        const lm = landmarks[j.idx];
        if (!lm) continue;
        target.set(j.name, toScene(lm));
      }
      // require most joints present, but ignore visibility scores
      tracked = target.size >= 10;
    }

    if (tracked) {
      ghost.visible = false;
      if (!hasLock) {
        // snap on first lock so avatar jumps to you instantly (no float-in)
        smooth = new Map(target);
        hasLock = true;
      } else {
        for (const [name, p] of target) {
          const s = smooth.get(name) || p;
          // outlier clamp: single-frame teleport (>0.9 units) is a glitch,
          // not motion — ease it instead of snapping
          const jump = Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z);
          const k = jump > 0.9 ? 0.15 : SMOOTH;
          smooth.set(name, {
            x: s.x + (p.x - s.x) * k,
            y: s.y + (p.y - s.y) * k,
            z: s.z + (p.z - s.z) * k,
          });
        }
      }
    } else {
      lastInput = null;
      hasLock = false;
      ghost.visible = true;
      ghost.rotation.y += 0.008;
    }

    drawLive(tracked);
    return { tracked, playback: false };
  }

  return { update, resize, playTo, resumeLive, getScene, isPlayback: () => !!playback, showDiff, clearDiff };
}
