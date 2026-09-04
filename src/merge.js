// Merge: reconcile two movement histories joint-by-joint.
// Joints that agree within MERGE_EPS merge automatically; the rest become
// conflicts resolved visually (green=current vs amber=incoming ghosts) with
// keep/take per joint. Merge commits carry secondParent so ancestry stays
// walkable; history() keeps following first-parent, unchanged.

import { diffPoses, PRETTY } from './diff.js';
import { clonePose } from './pose.js';
import { commitPose } from './git.js';

export const MERGE_EPS = 0.15;

const KEY_OF_PRETTY = Object.fromEntries(Object.entries(PRETTY).map(([k, v]) => [v, k]));

// Vertical position words only — left/right naming is mirror-ambiguous.
export function posWord(v) {
  if (!v) return '—';
  if (v.y < -0.25) return 'UP';
  if (v.y > 0.25) return 'DOWN';
  return 'LEVEL';
}

// Ancestry over both parents (merge commits link two histories).
export function isAncestor(repo, ancHash, descHash, cap = 500) {
  if (!ancHash || !descHash) return false;
  if (ancHash === descHash) return true;
  const seen = new Set();
  const stack = [descHash];
  while (stack.length && seen.size < cap) {
    const h = stack.pop();
    if (h === ancHash) return true;
    if (seen.has(h)) continue;
    seen.add(h);
    const c = repo.commits.get(h);
    if (!c) continue;
    if (c.parent) stack.push(c.parent);
    if (c.secondParent) stack.push(c.secondParent);
  }
  return false;
}

// Pure analysis — mutates nothing. Statuses:
// up-to-date | fast-forward {tip} | merged-clean {current,incoming} |
// conflicts {current,incoming,conflicts,auto} ; or {ok:false,error}.
export function analyzeMerge(repo, target) {
  if (!repo.branches.has(target)) {
    return { ok: false, error: `branch '${target}' not found. try: branch` };
  }
  if (target === repo.HEAD.branch) {
    return { ok: true, status: 'up-to-date', reason: 'same branch' };
  }
  const cur = repo.HEAD.hash ? repo.commits.get(repo.HEAD.hash) : null;
  const tgtHash = repo.branches.get(target);
  const tgt = tgtHash ? repo.commits.get(tgtHash) : null;
  if (!cur) return { ok: false, error: 'no commits yet — stand in frame first' };
  if (!tgt) {
    return { ok: false, error: `branch '${target}' tip was pruned — checkout ${target} and move to refresh` };
  }
  if (tgt.hash === cur.hash) return { ok: true, status: 'up-to-date' };
  if (isAncestor(repo, tgt.hash, cur.hash)) {
    return { ok: true, status: 'up-to-date', reason: `'${target}' is already inside ${repo.HEAD.branch}` };
  }
  if (isAncestor(repo, cur.hash, tgt.hash)) {
    return { ok: true, status: 'fast-forward', tip: tgt };
  }
  const d = diffPoses(cur.pose, tgt.pose, MERGE_EPS);
  const conflicts = d.moves.map((m) => {
    const key = KEY_OF_PRETTY[m.joint];
    return {
      key, pretty: m.joint, dist: m.dist,
      curWord: posWord(cur.pose[key]), incWord: posWord(tgt.pose[key]),
    };
  });
  if (!conflicts.length) {
    return { ok: true, status: 'merged-clean', current: cur, incoming: tgt };
  }
  return { ok: true, status: 'conflicts', current: cur, incoming: tgt, conflicts, auto: d.unchanged };
}

// Build the merge commit from resolutions {jointKey: 'ours'|'theirs'}.
// Auto joints keep current values (within eps of incoming); scene snapshots
// merge joint-wise too when both tips have them, else scene stays null and
// checkout falls back with its existing message.
export function finalizeMerge(repo, pending) {
  const cur = repo.commits.get(pending.currentHash);
  const tgt = repo.commits.get(pending.targetHash);
  if (!cur || !tgt) return { ok: false, error: 'merge tip was pruned mid-merge — aborted' };
  const pose = clonePose(cur.pose);
  let scene = cur.scene && tgt.scene ? clonePose(cur.scene) : null;
  let nTheirs = 0;
  for (const [key, side] of Object.entries(pending.resolved)) {
    if (side !== 'theirs') continue;
    if (tgt.pose[key]) pose[key] = { ...tgt.pose[key] };
    if (scene && tgt.scene[key]) scene[key] = { ...tgt.scene[key] };
    nTheirs++;
  }
  const c = commitPose(repo, pose, `merge branch '${pending.target}'`, scene);
  c.secondParent = tgt.hash;
  c.mergedBranch = pending.target;
  return { ok: true, commit: c, nTheirs, nTotal: Object.keys(pending.resolved).length };
}
