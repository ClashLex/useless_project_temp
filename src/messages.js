// Auto commit-message from the biggest joint move.
// Normalized space is always y-down here (world path auto-detects the sign,
// image path preserves MediaPipe's y-down): up = negative y.
//
// Two research-backed guards against wrong labels:
// 1. visibility gate — occluded joints get phantom coordinates pointing
//    anywhere; they may not vote for the label (presence is ignored per
//    MediaPipe's own guidance — only visibility matters).
// 2. velocity confirmation — the One Euro derivative is the freshest direction
//    estimate. If lagged displacement disagrees with live velocity, trust
//    velocity: that's the "said lowered while I raised" class of bug.

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

// visibility-gated max mover. Returns { name, dist, vec } or null.
function pickMax(prevPose, newPose, delta, vis = {}) {
  const entries = Object.entries(delta.perJoint || {}).filter(([k]) => k !== 'hip');
  if (!entries.length) return null;
  const anyVis = entries.some(([k]) => (vis[k] ?? 1) >= 0.5);
  const pool = anyVis ? entries.filter(([k]) => (vis[k] ?? 1) >= 0.5) : entries;
  if (!pool.length) return null;
  let name = pool[0][0], dist = pool[0][1];
  for (const [k, d] of pool) {
    if (d > dist) { dist = d; name = k; }
  }
  if (!prevPose[name] || !newPose[name]) return null;
  return { name, dist, vec: sub(newPose[name], prevPose[name]) };
}

// If displacement and live velocity disagree on the dominant axis, the filter
// was still catching up when we sampled — velocity (fresh) wins over
// displacement (lagged). Threshold 0.25 u/s ignores hold-still tremor.
function confirmWithVelocity(vec, vel) {
  if (!vel) return vec;
  const axis = Math.abs(vec.x) >= Math.abs(vec.y) ? 'x' : 'y';
  if (vec[axis] === 0) return vec;
  if (Math.abs(vel[axis]) > 0.25 && Math.sign(vel[axis]) !== Math.sign(vec[axis])) {
    return { ...vec, [axis]: vel[axis] };
  }
  return vec;
}

function labelMove(maxName, vec) {
  const { x, y } = vec;
  const wrist = (side) => {
    if (y < -0.18) return `feat: raise ${side} hand`;
    if (y > 0.18) return `feat: lower ${side} hand`;
    if (Math.abs(x) > 0.15) return `feat: extend ${side} hand`;
    return `feat: move ${side} hand`;
  };
  switch (maxName) {
    case 'rightWrist': return wrist('right');
    case 'leftWrist': return wrist('left');
    case 'rightElbow': return y < -0.12 ? 'feat: lift right arm' : 'feat: move right arm';
    case 'leftElbow': return y < -0.12 ? 'feat: lift left arm' : 'feat: move left arm';
    case 'head':
      if (Math.abs(x) > 0.12) return 'feat: turn head';
      return y > 0.1 ? 'feat: nod down' : 'feat: lift head';
    case 'leftShoulder':
    case 'rightShoulder': {
      // crouch = shoulders move down (+y); stand = up
      if (y > 0.15) return 'feat: crouch';
      if (y < -0.15) return 'feat: stand';
      return Math.abs(x) > 0.1 ? 'feat: rotate torso' : 'feat: shift shoulders';
    }
    case 'leftKnee':
    case 'rightKnee':
      return y > 0.12 ? 'feat: bend knee' : 'feat: step';
    case 'leftAnkle':
    case 'rightAnkle':
      return Math.abs(y) > 0.12 || Math.abs(x) > 0.12 ? 'feat: step' : 'feat: shift weight';
    default:
      return `feat: move ${maxName}`;
  }
}

export function describeMovement(prevPose, newPose, delta, opts = {}) {
  if (!prevPose) return 'initial human';
  const pick = pickMax(prevPose, newPose, delta, opts.vis);
  if (!pick || pick.dist < 0.10) return 'feat: shift weight';
  const vec = confirmWithVelocity(pick.vec, opts.velMap?.[pick.name]);

  // whole-body patterns beat single-joint max (arms swing during crouch)
  const shoL = delta.perJoint.leftShoulder ?? 0;
  const shoR = delta.perJoint.rightShoulder ?? 0;
  const headD = delta.perJoint.head ?? 0;
  if (shoL > 0.12 && shoR > 0.12 && headD > 0.12) {
    const avgY =
      (newPose.leftShoulder.y + newPose.rightShoulder.y) / 2 -
      (prevPose.leftShoulder.y + prevPose.rightShoulder.y) / 2;
    if (avgY > 0.12) return 'feat: crouch';
    if (avgY < -0.12) return 'feat: stand';
  }
  return labelMove(pick.name, vec);
}

// One-line human-readable reason for the live debug readout in status:
// e.g. "rightWrist y↓0.38 (v↓2.4)". y arrows are safe (down/up is absolute);
// x is shown signed (commit-space +x = screen-left in our mirrored view).
export function movementDebug(prevPose, newPose, delta, opts = {}) {
  if (!prevPose || !newPose) return '';
  const pick = pickMax(prevPose, newPose, delta, opts.vis);
  if (!pick) return '';
  const { x, y } = pick.vec;
  const axis = Math.abs(x) >= Math.abs(y) ? 'x' : 'y';
  const v = axis === 'x' ? x : y;
  const arrow = axis === 'y' ? (v >= 0 ? '↓' : '↑') : '';
  const vv = opts.velMap?.[pick.name]?.[axis];
  const varrow = vv === undefined ? '' : axis === 'y' ? (vv >= 0 ? '↓' : '↑') : '';
  const vtxt = vv === undefined ? '' : ` v${varrow}${Math.abs(vv).toFixed(1)}`;
  return `${pick.name} ${axis}${arrow}${Math.abs(v).toFixed(2)} (${vtxt.trim() || 'v—'})`;
}
