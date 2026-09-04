import { clonePose } from './pose.js';

export function randomHash(n = 6) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => (b % 16).toString(16)).join('');
}

export function createRepo() {
  return {
    commits: new Map(),
    branches: new Map([['main', null]]),
    HEAD: { branch: 'main', hash: null, detached: false },
    stash: null, // single slot: {pose, scene, message, timestamp}
  };
}

export function headCommit(repo) {
  return repo.HEAD.hash ? repo.commits.get(repo.HEAD.hash) || null : null;
}

export function isDetached(repo) {
  return !!repo.HEAD.detached;
}

export function branchHead(repo, name) {
  const h = repo.branches.get(name);
  return h ? repo.commits.get(h) || null : null;
}

export function commitPose(repo, pose, message, scene = null, cap = 200) {
  const parent = repo.HEAD.hash;
  const commit = {
    hash: randomHash(6),
    parent,
    branch: repo.HEAD.branch,
    message,
    timestamp: Date.now(),
    pose: clonePose(pose),
    // render-space snapshot for checkout playback (13 scene joints).
    // null only for commits made before the checkout update.
    scene: scene ? clonePose(scene) : null,
  };
  // collision-proof hash (6 hex is demo-short)
  while (repo.commits.has(commit.hash)) commit.hash = randomHash(6);
  repo.commits.set(commit.hash, commit);
  repo.branches.set(commit.branch, commit.hash);
  repo.HEAD.hash = commit.hash;
  // bound memory on long sessions; drop oldest (non-HEAD ancestry tail)
  if (repo.commits.size > cap) {
    const oldest = repo.commits.keys().next().value;
    if (oldest !== commit.hash) repo.commits.delete(oldest);
  }
  return commit;
}

// most-recent-first by following parents
export function history(repo, max = 50) {
  const out = [];
  let h = repo.HEAD.hash;
  while (h && out.length < max) {
    const c = repo.commits.get(h);
    if (!c) break;
    out.push(c);
    h = c.parent;
  }
  return out;
}

export function resolveHash(repo, prefix) {
  if (!prefix || prefix.length < 3) return null;
  prefix = prefix.toLowerCase();
  const hits = [...repo.commits.keys()].filter((h) => h.startsWith(prefix));
  if (hits.length === 1) return repo.commits.get(hits[0]);
  // allow full match even if ambiguous logic changes later
  if (repo.commits.has(prefix)) return repo.commits.get(prefix);
  return null;
}

// Side-effect-free hash lookup shared by checkout and diff.
export function lookupCommit(repo, prefix) {
  if (repo.commits.size === 0) {
    return { ok: false, error: 'no commits yet — stand in frame first' };
  }
  if (!prefix || prefix.length < 3) {
    return { ok: false, error: 'need ≥3 hash chars. try: log' };
  }
  prefix = prefix.toLowerCase();
  const hits = [...repo.commits.keys()].filter((h) => h.startsWith(prefix));
  if (hits.length === 0) {
    if (repo.commits.has(prefix)) hits.push(prefix);
    else return { ok: false, error: `'${prefix}' matches no commit. try: log` };
  }
  if (hits.length > 1) {
    return { ok: false, error: `ambiguous '${prefix}': ${hits.slice(0, 4).join(', ')} — type more chars` };
  }
  return { ok: true, commit: repo.commits.get(hits[0]) };
}

// History following a branch tip (not HEAD) — for diff and branch-aware log.
export function branchHistory(repo, name, max = 50) {
  const out = [];
  let h = repo.branches.get(name);
  while (h && out.length < max) {
    const c = repo.commits.get(h);
    if (!c) break;
    out.push(c);
    h = c.parent;
  }
  return out;
}

// Fork a new branch at HEAD (like real `git branch`: creates, doesn't switch).
// Allowed while detached too — the new branch simply starts at HEAD.
export function createBranch(repo, name) {
  if (!name) return { ok: false, error: 'usage: branch <name>' };
  if (!/^[\w][\w\-/]{0,31}$/.test(name)) {
    return { ok: false, error: `'${name}' is not a valid branch name (letters, digits, -, /, _)` };
  }
  if (repo.branches.has(name)) {
    return { ok: false, error: `branch '${name}' already exists. try: checkout ${name}` };
  }
  if (!repo.HEAD.hash) {
    return { ok: false, error: 'no commits yet — stand in frame first' };
  }
  repo.branches.set(name, repo.HEAD.hash);
  return { ok: true };
}

// Delete a branch. Refuses the checked-out branch (real git does too) and
// protects main — losing the trunk mid-demo ruins every later command.
export function deleteBranch(repo, name) {
  if (!repo.branches.has(name)) {
    return { ok: false, error: `branch '${name}' not found. try: branch` };
  }
  if (name === repo.HEAD.branch && !repo.HEAD.detached) {
    return { ok: false, error: `can't delete checked-out branch '${name}' — checkout another first` };
  }
  if (name === 'main') {
    return { ok: false, error: `won't delete 'main' (demo safety)` };
  }
  repo.branches.delete(name);
  return { ok: true };
}

// Checkout a branch by name: attach HEAD, resume live.
export function checkoutBranch(repo, name) {
  if (!repo.branches.has(name)) {
    return { ok: false, error: `branch '${name}' not found. try: branch` };
  }
  repo.HEAD = { branch: name, hash: repo.branches.get(name), detached: false };
  return { ok: true, commit: headCommit(repo) };
}

// Resolve a hash prefix OR branch name to a commit (for diff and friends).
export function resolveRef(repo, token) {
  if (repo.branches.has(token)) {
    const h = repo.branches.get(token);
    if (!h || !repo.commits.get(h)) {
      return { ok: false, error: `branch '${token}' has no commits yet` };
    }
    return { ok: true, commit: repo.commits.get(h) };
  }
  return lookupCommit(repo, token);
}

// Stash: park the current pose without committing. Single slot per the
// report's data model — push refuses while occupied, pop restores + clears.
export function stashPush(repo, pose, scene, message) {
  if (!pose) return { ok: false, error: 'nothing to stash — no tracked pose yet' };
  if (repo.stash) return { ok: false, error: 'stash occupied — pop or drop it first' };
  repo.stash = {
    pose: clonePose(pose),
    scene: scene ? clonePose(scene) : null,
    message: message || 'stashed pose',
    timestamp: Date.now(),
  };
  return { ok: true, stash: repo.stash };
}

export function stashPop(repo) {
  if (!repo.stash) return { ok: false, error: 'nothing stashed — try: stash' };
  const s = repo.stash;
  repo.stash = null;
  return { ok: true, stash: s };
}

export function stashDrop(repo) {
  if (!repo.stash) return { ok: false, error: 'nothing stashed' };
  repo.stash = null;
  return { ok: true };
}

// Checkout a commit hash prefix: detach HEAD, freeze commits, play back pose.
export function checkoutHash(repo, prefix) {
  const r = lookupCommit(repo, prefix);
  if (!r.ok) return r;
  const commit = r.commit;
  repo.HEAD = { branch: commit.branch, hash: commit.hash, detached: true };
  return { ok: true, commit };
}
