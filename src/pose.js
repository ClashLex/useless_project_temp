// MediaPipe subset used for human.git.
// Indices follow MediaPipe PoseLandmarker 33-point topology.
export const JOINTS = [
  { name: 'head', idx: 0, r: 0.055 },
  { name: 'leftShoulder', idx: 11, r: 0.042 },
  { name: 'rightShoulder', idx: 12, r: 0.042 },
  { name: 'leftElbow', idx: 13, r: 0.034 },
  { name: 'rightElbow', idx: 14, r: 0.034 },
  { name: 'leftWrist', idx: 15, r: 0.03 },
  { name: 'rightWrist', idx: 16, r: 0.03 },
  { name: 'leftHip', idx: 23, r: 0.045 },
  { name: 'rightHip', idx: 24, r: 0.045 },
  { name: 'leftKnee', idx: 25, r: 0.038 },
  { name: 'rightKnee', idx: 26, r: 0.038 },
  { name: 'leftAnkle', idx: 27, r: 0.03 },
  { name: 'rightAnkle', idx: 28, r: 0.03 },
];

// pairs by joint name
export const BONES = [
  ['head', 'leftShoulder'], ['head', 'rightShoulder'],
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
];

export const VIS_THRESHOLD = 0.4;

// 12 commit joints (hip singular = midpoint of 23/24)
export const COMMIT_JOINTS = [
  'head', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist', 'hip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
];

function rawPt(landmarks, idx) {
  const lm = landmarks[idx];
  return { x: lm.x, y: lm.y, z: lm.z ?? 0 };
}
function avg(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

// Inclusion threshold for pose joints: below this a joint is stored as null
// (no vote in delta/messages) instead of a phantom coordinate. Deliberately a
// touch below the 0.5 label-voting bar in messages.js — boundary flicker then
// only affects wording, never motion evidence.
export const VIS_MIN = 0.4;

function visOf(frame, idx) {
  return frame?.[idx]?.visibility ?? 1;
}

// Standing is optional: any stable framing commits — full body, seated,
// or close-up. Poses store only visible joints (null otherwise) and every
// downstream consumer (delta, messages, diff, filter) already skips nulls.
// Origin/scale prefers hips+torso; falls back to shoulders+width when the
// lower body is out of frame. A framing switch mid-session reads as one
// honest commit (the visible state really did change), then re-baselines.

// index per commit joint (hip = avg visibility of 23/24)
const COMMIT_INDEX = {
  head: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
};

// visibility per commit joint from a raw 33-landmark frame (image or world —
// both outputs carry the same visibility field). Missing field = trust it.
export function visMap(rawLandmarks) {
  const m = {};
  if (!rawLandmarks) return m;
  for (const [name, idx] of Object.entries(COMMIT_INDEX)) {
    m[name] = rawLandmarks[idx]?.visibility ?? 1;
  }
  m.hip = Math.min(rawLandmarks[23]?.visibility ?? 1, rawLandmarks[24]?.visibility ?? 1);
  return m;
}

// World-landmark normalize: meters, hips-midpoint origin (per MediaPipe docs).
// No aspect hack needed (metric space is isotropic) and torso is a real ~0.5m,
// stable across camera distance — unlike image-space torso which breathes with
// lean/rotation and faked motion. y sign is auto-detected from the skeleton
// itself (nose vs hips), so output is always y-down like the image path.
export function toNormalizedPoseWorld(world) {
  if (!world || world.length < 29) return null;
  try {
    const g = (i) => ({ x: world[i].x, y: world[i].y, z: world[i].z ?? 0 });
    const hip = avg(g(23), g(24));
    const sho = avg(g(11), g(12));
    const hipsOk = visOf(world, 23) >= VIS_MIN && visOf(world, 24) >= VIS_MIN &&
      visOf(world, 11) >= VIS_MIN && visOf(world, 12) >= VIS_MIN;
    let torso = dist3(sho, hip); // meters
    let origin = hip;
    let useHips = hipsOk && isFinite(torso) && torso >= 0.15 && torso <= 1.2;
    if (!useHips) {
      // seated / cropped: scale from shoulder width (≈ torso / 1.4), origin on shoulders
      const shoW = dist3(g(11), g(12));
      const shoOk = visOf(world, 11) >= VIS_MIN && visOf(world, 12) >= VIS_MIN;
      if (!shoOk || !isFinite(shoW) || shoW < 0.1 || shoW > 1.0) return null;
      torso = shoW * 1.4;
      origin = sho;
    }
    const refY = useHips ? hip.y : sho.y;
    // nose sits ABOVE the reference: under y-down it has the SMALLER value.
    // (The old `>` test was backwards — it inverted every vertical label.)
    const yDown = g(0).y < refY;
    const cv = (p) => ({
      x: (p.x - origin.x) / torso,
      y: ((yDown ? p.y : -p.y) - (yDown ? refY : -refY)) / torso,
      z: (p.z - origin.z) / torso,
    });
    const ok = (i) => visOf(world, i) >= VIS_MIN;
    return {
      head: ok(0) ? cv(g(0)) : null,
      leftShoulder: ok(11) ? cv(g(11)) : null,
      rightShoulder: ok(12) ? cv(g(12)) : null,
      leftElbow: ok(13) ? cv(g(13)) : null,
      rightElbow: ok(14) ? cv(g(14)) : null,
      leftWrist: ok(15) ? cv(g(15)) : null,
      rightWrist: ok(16) ? cv(g(16)) : null,
      hip: useHips ? { x: 0, y: 0, z: 0 } : null,
      leftKnee: ok(25) ? cv(g(25)) : null,
      rightKnee: ok(26) ? cv(g(26)) : null,
      leftAnkle: ok(27) ? cv(g(27)) : null,
      rightAnkle: ok(28) ? cv(g(28)) : null,
    };
  } catch {
    return null;
  }
}
// Image-space normalize (fallback when world landmarks are missing).
// Scale-invariant, hips-centered. Raw MediaPipe y grows downward — preserved.
// hip is always (0,0,0) by construction; crouch reads as shoulders/head +y.
//
// videoAspect (width/height) corrects the x/y anisotropy of image-space
// landmarks: without it, a wide 16:9 frame exaggerates horizontal moves and
// the torso length (hence the scale) wobbles with window/camera changes.
// torsoEMA: pass a {value} holder to smooth scale frame-to-frame and stop
// lean-forward / crouch from popping the scale in one frame.
export function toNormalizedPose(landmarks, videoAspect = 16 / 9, torsoEMA = null) {
  if (!landmarks || landmarks.length < 29) return null;
  try {
    const corr = (p) => ({ x: p.x * videoAspect, y: p.y, z: p.z ?? 0 });
    const ok = (i) => visOf(landmarks, i) >= VIS_MIN;
    const hipC = avg(corr(rawPt(landmarks, 23)), corr(rawPt(landmarks, 24)));
    const shoC = avg(corr(rawPt(landmarks, 11)), corr(rawPt(landmarks, 12)));
    const hipsOk = ok(23) && ok(24) && ok(11) && ok(12);
    let scale = dist3(shoC, hipC);
    let origin = hipC;
    let useHips = hipsOk && isFinite(scale) && scale >= 1e-6 && scale <= 0.9;
    if (!useHips) {
      // seated / cropped fallback: shoulder width ≈ torso / 1.4
      const shoW = dist3(corr(rawPt(landmarks, 11)), corr(rawPt(landmarks, 12)));
      if (!ok(11) || !ok(12) || !isFinite(shoW) || shoW < 1e-6 || shoW > 2.0) return null;
      scale = shoW * 1.4;
      origin = shoC;
    }
    if (torsoEMA) {
      torsoEMA.value = torsoEMA.value == null ? scale : torsoEMA.value + (scale - torsoEMA.value) * 0.2;
      scale = torsoEMA.value;
    }
    const raw = {
      head: corr(rawPt(landmarks, 0)),
      leftShoulder: corr(rawPt(landmarks, 11)),
      rightShoulder: corr(rawPt(landmarks, 12)),
      leftElbow: corr(rawPt(landmarks, 13)),
      rightElbow: corr(rawPt(landmarks, 14)),
      leftWrist: corr(rawPt(landmarks, 15)),
      rightWrist: corr(rawPt(landmarks, 16)),
      hip: hipC,
      leftKnee: corr(rawPt(landmarks, 25)),
      rightKnee: corr(rawPt(landmarks, 26)),
      leftAnkle: corr(rawPt(landmarks, 27)),
      rightAnkle: corr(rawPt(landmarks, 28)),
    };
    const gate = {
      head: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
      leftWrist: 15, rightWrist: 16, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
    };
    const pose = {};
    for (const k of COMMIT_JOINTS) {
      if (k === 'hip') { pose.hip = useHips ? { x: 0, y: 0, z: 0 } : null; continue; }
      if (!ok(gate[k])) { pose[k] = null; continue; }
      const v = sub(raw[k], origin);
      pose[k] = { x: v.x / scale, y: v.y / scale, z: v.z / scale };
    }
    return pose;
  } catch {
    return null;
  }
}

export function clonePose(pose) {
  const out = {};
  for (const k in pose) out[k] = pose[k] ? { ...pose[k] } : null;
  return out;
}

export function smoothPose(prev, next, alpha = 0.3) {
  if (!prev) return clonePose(next);
  const out = {};
  for (const k of COMMIT_JOINTS) {
    const p = prev[k], n = next[k];
    if (!n) { out[k] = p ? { ...p } : null; continue; } // hold last known
    if (!p) { out[k] = { ...n }; continue; } // adopt newly visible
    out[k] = {
      x: p.x + (n.x - p.x) * alpha,
      y: p.y + (n.y - p.y) * alpha,
      z: p.z + (n.z - p.z) * alpha,
    };
  }
  return out;
}

// mean per-joint distance + max mover for messages.
// score = 0.4*mean + 0.6*max: mean alone dilutes single-limb moves
// (full raise ≈ mean 0.10 but max 0.60; a tentative half-raise reads
// mean 0.06 / max 0.30 and must still fire). Max-led weighting hears small
// one-arm moves while sway (mean 0.03, max 0.06 → 0.05) stays silent at 0.18.
// Depth (z) carries half weight — MediaPipe documents it as far less accurate
// than x/y, and full weight lets depth noise fake motion.
// Head carries HEAD_WEIGHT: turns/nods rotate the skull, so the nose landmark
// only translates ~0.1–0.15 torso units where a hand raise moves 0.6 —
// unweighted, head-only motion could never reach threshold. Direction vectors
// stay raw (only magnitudes scale), and diff/merge use diffPoses, so this
// touches commit triggering alone.
const HEAD_WEIGHT = 2.5;
export function poseDelta(a, b) {
  let sum = 0, n = 0;
  let maxName = null, maxDist = -1, maxVec = null;
  let second = 0;
  const perJoint = {};
  for (const k of COMMIT_JOINTS) {
    if (k === 'hip') continue; // always zero
    const pa = a[k], pb = b[k];
    if (!pa || !pb) continue;
    const raw = Math.hypot(pb.x - pa.x, pb.y - pa.y, 0.5 * (pb.z - pa.z));
    const d = k === 'head' ? raw * HEAD_WEIGHT : raw;
    perJoint[k] = d;
    sum += d; n++;
    if (d > maxDist) { second = maxDist; maxDist = d; maxName = k; maxVec = sub(pb, pa); }
    else if (d > second) second = d;
  }
  const mean = n ? sum / n : 0;
  if (second < 0) second = 0;
  return { mean, perJoint, maxName, maxDist, maxVec, count: n, top2: (maxDist + Math.max(second, 0)) / 2, score: mean * 0.4 + maxDist * 0.6 };
}

// per-side arm visibility for occlusion hints: a side counts as hidden when
// BOTH wrist and elbow read low — one weak joint is noise, two is a pattern
// (out of frame, occlusion, or one-sided lighting killing the track).
// Returns [] | ['left'] | ['right'] | ['left','right'].
export function hiddenSides(rawLandmarks) {
  const out = [];
  const pairs = { left: [15, 13], right: [16, 14] };
  for (const [side, [w, e]] of Object.entries(pairs)) {
    if (visOf(rawLandmarks, w) < VIS_MIN && visOf(rawLandmarks, e) < VIS_MIN) out.push(side);
  }
  return out;
}

// Frame quality for the commit path (render stays permissive).
// Framing-agnostic: needs 6+ visible commit joints (of 12), so seated or
// cropped framings commit on their visible subset instead of demanding a
// full standing body. Null joints never enter delta, so the unseen legs
// can't inflate it into false commits.
export function poseQuality(landmarks) {
  if (!landmarks) return { usable: false, lowVis: 99, visible: 0 };
  let visible = 0;
  for (const idx of Object.values(COMMIT_INDEX)) {
    if (visOf(landmarks, idx) >= 0.5) visible++;
  }
  if (Math.min(visOf(landmarks, 23), visOf(landmarks, 24)) >= 0.5) visible++;
  return { usable: visible >= 6, lowVis: 12 - visible, visible };
}

// Reference T-pose in scene units, shown before tracking locks.
export function idlePose() {
  return new Map([
    ['head', { x: 0, y: 0.75, z: 0 }],
    ['leftShoulder', { x: -0.42, y: 0.45, z: 0 }],
    ['rightShoulder', { x: 0.42, y: 0.45, z: 0 }],
    ['leftElbow', { x: -0.72, y: 0.45, z: 0 }],
    ['rightElbow', { x: 0.72, y: 0.45, z: 0 }],
    ['leftWrist', { x: -0.98, y: 0.45, z: 0 }],
    ['rightWrist', { x: 0.98, y: 0.45, z: 0 }],
    ['leftHip', { x: -0.18, y: -0.1, z: 0 }],
    ['rightHip', { x: 0.18, y: -0.1, z: 0 }],
    ['leftKnee', { x: -0.2, y: -0.55, z: 0 }],
    ['rightKnee', { x: 0.2, y: -0.55, z: 0 }],
    ['leftAnkle', { x: -0.22, y: -0.95, z: 0 }],
    ['rightAnkle', { x: 0.22, y: -0.95, z: 0 }],
  ]);
}
