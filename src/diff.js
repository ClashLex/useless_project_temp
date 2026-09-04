// Joint-by-joint pose comparison for `git diff`.
// Operates on normalized commit poses (y-down, torso units), so results are
// camera-distance invariant. Direction words deliberately avoid left/right:
// commit-space +x is screen-left in our mirrored view, and naming sides wrong
// is worse than not naming them — magnitude + vertical/sideways is unambiguous.

export const DIFF_EPS = 0.12;

export const PRETTY = {
  head: 'HEAD', leftShoulder: 'LEFT_SHOULDER', rightShoulder: 'RIGHT_SHOULDER',
  leftElbow: 'LEFT_ELBOW', rightElbow: 'RIGHT_ELBOW',
  leftWrist: 'LEFT_HAND', rightWrist: 'RIGHT_HAND',
  leftKnee: 'LEFT_KNEE', rightKnee: 'RIGHT_KNEE',
  leftAnkle: 'LEFT_FOOT', rightAnkle: 'RIGHT_FOOT',
};

function describeVec(vec) {
  const { x, y } = vec;
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ay >= ax) return y < 0 ? 'upward' : 'downward';
  return 'sideways';
}

// Returns { moves: [{joint, dist, vec, dir}] desc by dist, unchanged: count }.
export function diffPoses(poseA, poseB, eps = DIFF_EPS) {
  const moves = [];
  let unchanged = 0;
  for (const k of Object.keys(PRETTY)) {
    const pa = poseA?.[k], pb = poseB?.[k];
    if (!pa || !pb) continue;
    const vec = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
    const dist = Math.hypot(vec.x, vec.y, 0.5 * vec.z);
    if (dist < eps) { unchanged++; continue; }
    moves.push({ joint: PRETTY[k], dist, vec, dir: describeVec(vec) });
  }
  moves.sort((m1, m2) => m2.dist - m1.dist);
  return { moves, unchanged };
}

export function formatDiff(hashA, hashB, diff) {
  const lines = [`HUMAN DIFFERENCE  ${hashA}..${hashB}`, ''];
  if (!diff.moves.length) {
    lines.push('(identical poses — every joint within tolerance)');
    return lines.join('\n');
  }
  for (const m of diff.moves) {
    lines.push(`+ ${m.joint} moved ${m.dir} (${m.dist.toFixed(2)})`);
  }
  if (diff.unchanged > 0) {
    lines.push(`  ${diff.unchanged} joint${diff.unchanged === 1 ? '' : 's'} unchanged (<${DIFF_EPS})`);
  }
  return lines.join('\n');
}
