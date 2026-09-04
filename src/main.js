import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { createAvatar } from './avatar.js';
import { COMMIT_JOINTS, toNormalizedPose, toNormalizedPoseWorld, poseDelta, clonePose, poseQuality, visMap, hiddenSides } from './pose.js';
import { createRepo, commitPose, headCommit, history, checkoutBranch, checkoutHash, isDetached, createBranch, stashPush, stashPop, stashDrop, deleteBranch, resolveRef } from './git.js';
import { describeMovement, movementDebug } from './messages.js';
import { diffPoses, formatDiff } from './diff.js';
import { analyzeMerge, finalizeMerge } from './merge.js';
import { EuroPose } from './filters.js';

const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const dot = document.getElementById('dot');
const recTxt = document.getElementById('recTxt');
const hudRight = document.getElementById('hudRight');
const deltaVal = document.getElementById('deltaVal');
const deltaBar = document.getElementById('deltaBar');
const commitCount = document.getElementById('commitCount');
const thresh = document.getElementById('thresh');
const threshVal = document.getElementById('threshVal');
const logEl = document.getElementById('log');
const cmdEl = document.getElementById('cmd');
const commitBtn = document.getElementById('commitBtn');
const branchBadge = document.getElementById('branchBadge');
const modeBanner = document.getElementById('modeBanner');
const hudLeft = document.getElementById('hudLeft');

const avatar = createAvatar(document.getElementById('c'));
const repo = createRepo();

let landmarker = null;
let stream = null;
let running = false;
let lastLandmarks = null;
let lastWorld = null;
let lastVideoTime = -1;
let lastTs = 0;
let frames = 0;
let detects = 0;
let detectMs = 0;
let fpsT0 = performance.now();
// adaptive detect: if inference averages >40ms, process every 2nd video frame
// (render + smoothing stay at full rate, so motion stays fluid).
let detectStride = 1;
let stridePhase = 0;

// commit engine state (separate from render smoothing).
// One Euro replaces the old fixed-alpha EMA: still when still, no lag when fast.
let commitSmooth = null;
let commitVel = {};
let lastVis = {};
let liveDbg = '';
const euro = new EuroPose({ joints: COMMIT_JOINTS, freq: 30, mincutoff: 1.1, beta: 0.4, dcutoff: 1.0 });
let stableFrames = 0;
let cooldownUntil = 0;
let threshold = parseFloat(thresh.value);
let lastDeltaMean = 0;
let lastScore = 0;
let needRefreeze = false; // after tracking loss, settle before committing
let refreezeFrames = 0;
let lastCommitTick = 0; // commit pipeline runs at ~10Hz, render stays full-rate
let pendingMerge = null; // {target, baseBranch, currentHash, targetHash, conflicts, resolved, auto}
const torsoEMA = { value: null };

function setStatus(mode, msg) {
  statusEl.textContent = msg;
  dot.className = mode;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function tipTags(hash) {
  const tags = [];
  for (const [b, hh] of repo.branches) {
    if (hh === hash) tags.push(`[${b}]`);
  }
  return tags.length ? ' ' + tags.join(' ') : '';
}

function headLabel() {
  return repo.HEAD.hash
    ? (isDetached(repo) ? `detached @ ${repo.HEAD.hash}` : `⎇ ${repo.HEAD.branch}`)
    : '⎇ main (empty)';
}

function renderLog() {
  const h = history(repo, 30);
  commitCount.textContent = `${repo.commits.size} commit${repo.commits.size === 1 ? '' : 's'}`;
  const head = headLabel();
  if (!h.length) {
    logEl.textContent = `HUMAN REPOSITORY — ${head}\n(no commits yet — stand in frame)`;
    return;
  }
  const lines = h.map((c) =>
    `${c.hash === repo.HEAD.hash ? '*' : ' '} ${c.hash}${tipTags(c.hash)}  ${c.message} (${ago(c.timestamp)})`
  );
  logEl.textContent = `HUMAN REPOSITORY — ${head}\n\n` + lines.join('\n');
  logEl.scrollTop = 0;
}

// All branches at once, newest first, with merge edges —
// `git log --graph --all --decorate` for bodies. `log` stays HEAD-lineage.
function graphLog() {
  const seen = new Map();
  const stack = [];
  if (repo.HEAD.hash) stack.push(repo.HEAD.hash);
  for (const h of repo.branches.values()) if (h) stack.push(h);
  let guard = 0;
  while (stack.length && guard++ < 500) {
    const h = stack.pop();
    if (!h || seen.has(h)) continue;
    const c = repo.commits.get(h);
    if (!c) continue;
    seen.set(h, c);
    if (c.parent) stack.push(c.parent);
    if (c.secondParent) stack.push(c.secondParent);
  }
  const all = [...seen.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
  const head = headLabel();
  if (!all.length) {
    logEl.textContent = `HUMAN GRAPH — ${head}\n(no commits yet — stand in frame)`;
    return;
  }
  const lines = all.map((c) =>
    `${c.hash === repo.HEAD.hash ? '*' : 'o'} ${c.hash}${tipTags(c.hash)}  ${c.message} (${ago(c.timestamp)})` +
    (c.secondParent ? ` ╮+${c.secondParent.slice(0, 4)}` : '')
  );
  logEl.textContent = `HUMAN GRAPH — ${head}\n\n` + lines.join('\n');
  logEl.scrollTop = 0;
}

function updateHeadUI() {
  if (isDetached(repo) && repo.HEAD.hash) {
    branchBadge.textContent = `detached @ ${repo.HEAD.hash}`;
    hudLeft.textContent = `$ pose @ ${repo.HEAD.hash}`;
    if (modeBanner) modeBanner.textContent = `time-travel @ ${repo.HEAD.hash} — checkout ${repo.HEAD.branch} to resume`;
  } else {
    branchBadge.textContent = `⎇ ${repo.HEAD.branch}`;
    hudLeft.textContent = '$ pose --live';
    if (modeBanner) modeBanner.textContent = 'live — checkout an old hash to time-travel';
  }
}

function appendLog(msg) {
  logEl.textContent += `\n${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function doCommit(pose, forcedMsg) {
  if (isDetached(repo)) {
    appendLog('$ commits frozen while time-traveling — checkout ' + repo.HEAD.branch + ' to resume');
    return null;
  }
  if (pendingMerge) {
    appendLog(`$ commits frozen mid-merge — resolve '${pendingMerge.target}' or merge --abort`);
    return null;
  }
  const head = headCommit(repo);
  const delta = head ? poseDelta(head.pose, pose) : null;
  const msg = forcedMsg || describeMovement(head?.pose || null, pose, delta, { velMap: commitVel, vis: lastVis });
  const scene = avatar.getScene();
  const c = commitPose(repo, pose, msg, scene);
  cooldownUntil = performance.now() + 800;
  renderLog();
  return c;
}

// Change-detected DOM writes: identical values (e.g. parked 0s while
// detached, or a held still pose) skip layout/style recalc entirely.
let lastDeltaText = null, lastDeltaWidth = null, lastDeltaColor = null;
function updateDeltaUI(mean, score) {
  lastDeltaMean = mean;
  lastScore = score ?? mean;
  const text = lastScore.toFixed(3);
  const width = `${Math.min(100, (lastScore / (threshold * 1.5)) * 100).toFixed(0)}%`;
  const color = lastScore > threshold ? '#00ff66' : '#0a5c2a';
  if (text !== lastDeltaText) { deltaVal.textContent = text; lastDeltaText = text; }
  if (width !== lastDeltaWidth) { deltaBar.style.width = width; lastDeltaWidth = width; }
  if (color !== lastDeltaColor) { deltaBar.style.background = color; lastDeltaColor = color; }
}

thresh.oninput = () => {
  threshold = parseFloat(thresh.value);
  threshVal.textContent = threshold.toFixed(2);
  updateDeltaUI(lastDeltaMean, lastScore);
};

function forceCommit(msg) {
  if (!commitSmooth) return;
  if (isDetached(repo)) {
    appendLog(`$ commits frozen @ ${repo.HEAD.hash} — checkout ${repo.HEAD.branch} to resume`);
    return;
  }
  doCommit(clonePose(commitSmooth), msg);
}

function doCheckoutBranch(name) {
  if (pendingMerge) { appendLog(`$ can't checkout mid-merge — resolve '${pendingMerge.target}' or merge --abort`); return; }
  const r = checkoutBranch(repo, name);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  avatar.clearDiff();
  avatar.resumeLive();
  needRefreeze = true; // settle live smoothing before recommitting
  refreezeFrames = 0;
  renderLog();
  updateHeadUI();
}

function doCheckoutHash(prefix) {
  if (pendingMerge) { appendLog(`$ can't checkout mid-merge — resolve '${pendingMerge.target}' or merge --abort`); return; }
  const r = checkoutHash(repo, prefix);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  if (!r.commit.scene) {
    appendLog('$ that commit has no pose snapshot (pre-checkout build) — staying live');
    avatar.resumeLive();
    // revert HEAD detach since we can't show anything
    checkoutBranch(repo, r.commit.branch);
  } else {
    avatar.clearDiff();
    avatar.playTo(r.commit.scene, 600);
  }
  renderLog();
  updateHeadUI();
}

function doStatus() {
  const n = repo.commits.size;
  const head = headCommit(repo);
  const mergeLine = pendingMerge
    ? `\n$ merging '${pendingMerge.target}' → ${pendingMerge.baseBranch} — ${pendingMerge.conflicts.filter((c) => !pendingMerge.resolved[c.key]).length} conflict(s) left (keep/take, or merge --abort)`
    : '';
  appendLog(
    `$ status: ${isDetached(repo) ? `detached @ ${repo.HEAD.hash}` : `on branch ${repo.HEAD.branch}`} · ` +
    `${n} commit${n === 1 ? '' : 's'}` +
    (head ? ` · HEAD "${head.message}"` : ' · no commits yet') + mergeLine +
    (repo.stash ? `\n$ stash: "${repo.stash.message}" (${ago(repo.stash.timestamp)})` : '')
  );
}

function doMerge(target) {
  if (pendingMerge) { appendLog(`$ already merging '${pendingMerge.target}' — keep/take to resolve, or merge --abort`); return; }
  if (isDetached(repo)) { appendLog(`$ can't merge while time-traveling — checkout ${repo.HEAD.branch} first`); return; }
  const r = analyzeMerge(repo, target);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  if (r.status === 'up-to-date') {
    appendLog(`$ already up to date${r.reason ? ' — ' + r.reason : ''}`);
    return;
  }
  if (r.status === 'fast-forward') {
    repo.branches.set(repo.HEAD.branch, r.tip.hash);
    repo.HEAD.hash = r.tip.hash;
    needRefreeze = true; refreezeFrames = 0;
    renderLog(); updateHeadUI();
    appendLog(`$ fast-forwarded ${repo.HEAD.branch} → ${r.tip.hash} ("${r.tip.message}")`);
    return;
  }
  if (r.status === 'merged-clean') {
    const pend = { target, baseBranch: repo.HEAD.branch, currentHash: r.current.hash, targetHash: r.incoming.hash, resolved: {} };
    const f = finalizeMerge(repo, pend);
    if (!f.ok) { appendLog('$ ' + f.error); return; }
    needRefreeze = true; refreezeFrames = 0;
    renderLog(); updateHeadUI();
    appendLog(`$ merged '${target}' → ${f.commit.branch} as ${f.commit.hash} (clean — every joint agreed)`);
    return;
  }
  // conflicts: freeze commits, overlay both poses, resolve joint by joint
  pendingMerge = {
    target, baseBranch: repo.HEAD.branch,
    currentHash: r.current.hash, targetHash: r.incoming.hash,
    conflicts: r.conflicts, resolved: {}, auto: r.auto,
  };
  if (r.current.scene && r.incoming.scene) {
    avatar.showDiff(r.current.scene, r.incoming.scene);
  }
  printConflicts();
  renderLog(); updateHeadUI();
}

function printConflicts() {
  const p = pendingMerge;
  if (!p) return;
  const rem = p.conflicts.filter((c) => !p.resolved[c.key]);
  appendLog(`$ HUMAN MERGE CONFLICT — '${p.target}' → ${p.baseBranch} (${p.auto} auto, ${rem.length} left)`);
  if (pendingHasScenes(p)) appendLog(`  (stage: green=${p.baseBranch} · amber=${p.target})`);
  else appendLog('  (no pose snapshot on an old commit — resolving text-only)');
  rem.forEach((c) => {
    appendLog(`  ${p.conflicts.indexOf(c) + 1}. ${c.pretty}: ${p.baseBranch} ${c.curWord} vs ${p.target} ${c.incWord} (Δ${c.dist.toFixed(2)})`);
  });
  appendLog(`$ keep <n|joint> (=${p.baseBranch}) · take <n|joint> (=${p.target}) · merge --abort`);
}

function pendingHasScenes(p) {
  const cur = repo.commits.get(p.currentHash);
  const tgt = repo.commits.get(p.targetHash);
  return !!(cur?.scene && tgt?.scene);
}

function doMergeAbort() {
  if (!pendingMerge) { appendLog('$ no merge in progress'); return; }
  appendLog(`$ merge '${pendingMerge.target}' aborted — no commits created`);
  pendingMerge = null;
  avatar.clearDiff();
  renderLog(); updateHeadUI();
}

function normJoint(s) {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function findConflict(p, ref) {
  const n = parseInt(ref, 10);
  if (!isNaN(n) && n >= 1 && n <= p.conflicts.length) return p.conflicts[n - 1];
  const want = normJoint(ref);
  if (!want) return null;
  return p.conflicts.find((c) => normJoint(c.pretty) === want) || null;
}

function doResolve(cmd, rest) {
  if (!pendingMerge) { appendLog('$ nothing to resolve — try: merge <branch>'); return; }
  const p = pendingMerge;
  let side, ref;
  if (cmd === 'keep') { side = 'ours'; ref = rest; }
  else if (cmd === 'take') { side = 'theirs'; ref = rest; }
  else {
    const parts = rest.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) { appendLog('$ usage: resolve <n|joint> <ours|theirs>'); return; }
    ref = parts[0];
    const w = parts[1].toLowerCase();
    if (w !== 'ours' && w !== 'theirs') { appendLog('$ side must be ours (=current) or theirs (=incoming)'); return; }
    side = w;
  }
  if (!ref) { appendLog(`$ usage: ${cmd} <n|joint>${cmd === 'resolve' ? ' <ours|theirs>' : ''}`); return; }
  const c = findConflict(p, ref);
  if (!c) { appendLog(`$ no conflict '${ref}' — numbering follows the list above`); return; }
  p.resolved[c.key] = side;
  const rem = p.conflicts.filter((x) => !p.resolved[x.key]).length;
  if (rem > 0) {
    appendLog(`$ ${c.pretty} → ${side === 'ours' ? p.baseBranch : p.target} (${rem} left)`);
    return;
  }
  const target = p.target, nC = p.conflicts.length;
  const f = finalizeMerge(repo, p);
  pendingMerge = null;
  if (!f.ok) { appendLog('$ ' + f.error); avatar.clearDiff(); renderLog(); updateHeadUI(); return; }
  avatar.clearDiff();
  needRefreeze = true; refreezeFrames = 0;
  renderLog(); updateHeadUI();
  appendLog(`$ merged '${target}' → ${f.commit.branch} as ${f.commit.hash} (${nC} resolved)`);
}

function doBranch(name) {
  const r = createBranch(repo, name);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  renderLog();
  appendLog(`$ branched '${name}' @ ${repo.HEAD.hash} — checkout ${name} to move on it`);
}

function doBranchDelete(name) {
  const r = deleteBranch(repo, name);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  renderLog();
  appendLog(`$ deleted branch '${name}'`);
}

function doStashPush(msg) {
  if (isDetached(repo)) { appendLog(`$ can't stash while time-traveling — checkout ${repo.HEAD.branch} first`); return; }
  if (pendingMerge) { appendLog(`$ can't stash mid-merge — resolve '${pendingMerge.target}' or merge --abort`); return; }
  if (!commitSmooth) { appendLog('$ nothing to stash — no tracked pose yet'); return; }
  const scene = avatar.getScene();
  const r = stashPush(repo, clonePose(commitSmooth), scene, msg);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  appendLog(`$ stashed "${r.stash.message}" — pop to preview it`);
}

function doStashPop() {
  if (isDetached(repo)) { appendLog(`$ can't pop while time-traveling — checkout ${repo.HEAD.branch} first`); return; }
  if (pendingMerge) { appendLog(`$ can't pop mid-merge — resolve '${pendingMerge.target}' or merge --abort`); return; }
  const r = stashPop(repo);
  if (!r.ok) { appendLog('$ ' + r.error); return; }
  if (!r.stash.scene) { appendLog(`$ popped "${r.stash.message}" (no preview snapshot)`); return; }
  appendLog(`$ popped "${r.stash.message}" — previewing, live resumes`);
  avatar.playTo(r.stash.scene, 600);
  setTimeout(() => {
    if (running && !isDetached(repo) && !pendingMerge && avatar.isPlayback()) avatar.resumeLive();
  }, 1600);
}

function doStashList() {
  if (!repo.stash) { appendLog('$ stash: empty'); return; }
  appendLog(`$ stash: "${repo.stash.message}" (${ago(repo.stash.timestamp)})`);
}

// diff [--text] [<a> [<b>]] — a/b are hashes OR branch names. No args: HEAD
// vs parent; one arg: that ref vs its parent; two args: A vs B.
// the stage overlay (green=A, amber=B) shows too unless --text.
function doDiff(argStr) {
  const tokens = argStr.trim().split(/\s+/).filter(Boolean);
  const textOnly = tokens.includes('--text');
  const hashes = tokens.filter((t) => !t.startsWith('--'));
  if (hashes.length > 2) { appendLog('$ usage: diff [--text] [<a> [<b>]]  (hash or branch)'); return; }
  let a, b;
  if (hashes.length === 0) {
    const head = headCommit(repo);
    if (!head) { appendLog('$ no commits yet — stand in frame first'); return; }
    if (!head.parent || !repo.commits.get(head.parent)) {
      appendLog('$ need 2 commits to diff — move to commit again'); return;
    }
    b = head;
    a = repo.commits.get(head.parent);
  } else if (hashes.length === 1) {
    const rb = resolveRef(repo, hashes[0]);
    if (!rb.ok) { appendLog('$ ' + rb.error); return; }
    b = rb.commit;
    if (!b.parent || !repo.commits.get(b.parent)) {
      appendLog(`$ ${b.hash} has no parent — give two hashes: diff <a> <b>`); return;
    }
    a = repo.commits.get(b.parent);
  } else {
    const ra = resolveRef(repo, hashes[0]);
    if (!ra.ok) { appendLog('$ ' + ra.error); return; }
    const rb = resolveRef(repo, hashes[1]);
    if (!rb.ok) { appendLog('$ ' + rb.error); return; }
    a = ra.commit;
    b = rb.commit;
  }
  const d = diffPoses(a.pose, b.pose);
  appendLog(formatDiff(a.hash, b.hash, d).split('\n').map((l, i) => (i === 0 ? '$ ' + l : '  ' + l)).join('\n'));
  if (textOnly) return;
  if (pendingMerge) { appendLog('  (stage overlay kept for the merge — resolve first)'); return; }
  if (!a.scene || !b.scene) {
    appendLog('  (no pose snapshot on an old commit — overlay skipped)');
    return;
  }
  avatar.showDiff(a.scene, b.scene);
  appendLog(`  (stage: green=${a.hash} · amber=${b.hash} — clear wipes overlay)`);
}

commitBtn.onclick = () => forceCommit();
window.addEventListener('keydown', (e) => {
  if ((e.key === 'c' || e.key === 'C') && running && document.activeElement !== cmdEl) forceCommit();
});

cmdEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const rawIn = cmdEl.value.trim();
  cmdEl.value = '';
  if (!rawIn) return;
  // accept both `log` and `git log` styles
  const raw = rawIn.replace(/^git\s+/, '');
  const m = raw.match(/^commit\s+-m\s+"([^"]+)"|^commit\s+-m\s+'([^']+)'|^commit\s+-m\s+(\S+)/);
  if (/^(log|git log)$/.test(rawIn) || raw === 'log') { renderLog(); return; }
  const co = raw.match(/^checkout\s+(\S+)\s*$/);
  if (co) {
    const target = co[1];
    if (repo.branches.has(target)) doCheckoutBranch(target);
    else doCheckoutHash(target);
    return;
  }
  if (raw === 'checkout') { appendLog('$ usage: checkout <hash|branch>'); return; }
  if (raw === 'diff' || raw.startsWith('diff ')) { doDiff(raw.slice('diff'.length)); return; }
  if (raw === 'merge' || raw.startsWith('merge ')) {
    const arg = raw.slice('merge'.length).trim();
    if (!arg) { appendLog('$ usage: merge <branch> | merge --abort'); return; }
    if (arg === '--abort') { doMergeAbort(); return; }
    if (/\s/.test(arg)) { appendLog('$ usage: merge <branch>'); return; }
    doMerge(arg);
    return;
  }
  const rsm = raw.match(/^(keep|take|resolve)(?:\s+(.*))?$/);
  if (rsm) { doResolve(rsm[1], (rsm[2] || '').trim()); return; }
  if (raw === 'status') { doStatus(); return; }
  if (raw === 'branch' || raw.startsWith('branch ')) {
    const arg = raw.slice('branch'.length).trim();
    if (!arg) {
      const names = [...repo.branches.keys()].map((b) => `${b === repo.HEAD.branch && !isDetached(repo) ? '*' : ' '} ${b}@${repo.branches.get(b) || '(empty)'}`).join('\n');
      appendLog('$ branches:\n' + names);
    } else if (arg === '-d' || arg.startsWith('-d ')) {
      const name = arg.slice(2).trim();
      if (!name || /\s/.test(name)) appendLog('$ usage: branch -d <name>');
      else doBranchDelete(name);
    } else if (/\s/.test(arg)) {
      appendLog('$ usage: branch <name> | branch -d <name>');
    } else {
      doBranch(arg);
    }
    return;
  }
  if (raw === 'graph') { graphLog(); return; }
  if (raw === 'stash' || raw.startsWith('stash ')) {
    const rest = raw.slice('stash'.length).trim();
    const pushM = rest.match(/^(?:push\s+)?-m\s+"([^"]+)"|^(?:push\s+)?-m\s+'([^']+)'|^(?:push\s+)?-m\s+(\S+)/);
    if (!rest || rest === 'push' || pushM) {
      doStashPush(pushM ? (pushM[1] || pushM[2] || pushM[3]) : undefined);
    } else if (rest === 'pop') {
      doStashPop();
    } else if (rest === 'list') {
      doStashList();
    } else if (rest === 'drop') {
      const r = stashDrop(repo);
      appendLog(r.ok ? '$ stash dropped' : '$ ' + r.error);
    } else {
      appendLog('$ usage: stash [-m "msg"] | stash pop | stash list | stash drop');
    }
    return;
  }
  if (/^commit(\s|$)/.test(raw)) {
    forceCommit(m ? (m[1] || m[2] || m[3]) : undefined);
    return;
  }
  if (raw === 'clear') { avatar.clearDiff(); renderLog(); return; }
  if (raw === 'help') {
    appendLog('$ commands: log · graph · checkout <hash|branch> · diff [--text] [<a> [<b>]] · branch [<name>|-d <name>] · merge <branch> · keep/take <n|joint> · stash [pop|list|drop] · status · commit [-m "msg"] · clear');
    return;
  }
  appendLog(`$ unknown: ${rawIn} (try: log)`);
});

async function initPose() {
  setStatus('', 'loading pose model…');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  const model =
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: model, delegate: 'GPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.3, minTrackingConfidence: 0.3,
    });
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: model, delegate: 'CPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.3, minTrackingConfidence: 0.3,
    });
  }
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function stopCamera() {
  running = false;
  lastLandmarks = null;
  lastWorld = null;
  commitSmooth = null;
  commitVel = {};
  lastVis = {};
  liveDbg = '';
  euro.reset();
  torsoEMA.value = null;
  needRefreeze = false;
  stableFrames = 0;
  pendingMerge = null;
  avatar.clearDiff();
  avatar.resumeLive();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('', 'stopped. click START to resume.');
  recTxt.textContent = 'idle';
  hudRight.textContent = 'no pose';
  avatar.update(null);
}

function commitTick(tracked) {
  if (isDetached(repo)) return; // frozen while time-traveling
  if (!tracked || (!lastLandmarks && !lastWorld)) {
    stableFrames = 0;
    needRefreeze = true; // settle on reacquire so stale pose can't instant-commit
    refreezeFrames = 0;
    euro.reset();
    liveDbg = '';
    updateDeltaUI(0, 0);
    return;
  }
  // quality-gate commits only — render stays permissive so avatar never freezes.
  // visibility exists on both image and world outputs.
  const rawFrame = lastWorld || lastLandmarks;
  const q = poseQuality(rawFrame);
  if (!q.usable) {
    liveDbg = `only ${q.visible}/12 joints visible (need 6+) — move into frame`;
    updateDeltaUI(0, 0);
    return;
  }
  // world landmarks first: metric meters, isotropic, stable torso.
  // image path is the fallback (aspect-corrected + torso EMA).
  let norm = null;
  if (lastWorld) {
    norm = toNormalizedPoseWorld(lastWorld);
  } else {
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    norm = toNormalizedPose(lastLandmarks, aspect, torsoEMA);
  }
  if (!norm) return;
  const t = performance.now() / 1000;
  const f = euro.filterPose(norm, t);
  commitSmooth = f.pose;
  commitVel = f.vel;
  lastVis = visMap(rawFrame);

  const head = headCommit(repo);
  if (!head) {
    // need a few stable ticks before initial human so first commit isn't mid-fade
    // (commitTick runs at ~10Hz — 3 ticks ≈ 0.3s)
    stableFrames++;
    updateDeltaUI(0, 0);
    if (stableFrames >= 3) doCommit(commitSmooth);
    return;
  }
  if (needRefreeze) {
    // let smoothing settle after relock, no commits yet
    refreezeFrames++;
    const delta = poseDelta(head.pose, commitSmooth);
    updateDeltaUI(delta.mean, delta.score);
    liveDbg = movementDebug(head.pose, commitSmooth, delta, { velMap: commitVel, vis: lastVis });
    if (refreezeFrames >= 3) needRefreeze = false;
    return;
  }
  const delta = poseDelta(head.pose, commitSmooth);
  updateDeltaUI(delta.mean, delta.score);
  liveDbg = movementDebug(head.pose, commitSmooth, delta, { velMap: commitVel, vis: lastVis });
  if (delta.score < threshold * 0.5) {
    // quiet but a whole arm is invisible: say so, otherwise a dead side
    // looks exactly like "commits broken for that arm"
    const hidden = hiddenSides(rawFrame);
    if (hidden.length === 1) liveDbg = `${hidden[0]} arm hidden — reframe / add light on that side`;
    else if (hidden.length === 2) liveDbg = 'both arms hidden — show your arms to commit';
  }
  // cooldown alone paces commits; a held new pose keeps scoring high until
  // the next cooldown expires, then commits once and re-baselines.
  // count>=3: with tiny visible subsets a single jittery joint can't commit.
  // frozen mid-merge: resolving a conflict while auto-commits fire would move HEAD.
  if (!pendingMerge && delta.score > threshold && delta.count >= 3 && performance.now() > cooldownUntil) {
    doCommit(commitSmooth);
  }
}

async function loop() {
  requestAnimationFrame(loop);
  if (!landmarker || document.hidden) return;
  if (running && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    // adaptive stride: skip inference on alternate frames when slow.
    // Skipped frames reuse last landmarks; render smoothing covers the gap.
    stridePhase++;
    if (stridePhase % detectStride === 0) {
      const t0 = performance.now();
      try {
        const ts = Math.max(t0, lastTs + 1);
        lastTs = ts;
        const res = landmarker.detectForVideo(video, ts);
        lastLandmarks = res.landmarks?.length ? res.landmarks[0] : null;
        lastWorld = res.worldLandmarks?.length ? res.worldLandmarks[0] : null;
        detects++;
        detectMs += performance.now() - t0;
      } catch (e) {
        console.warn(e);
      }
    }
  }
  if (!running) {
    avatar.update(null);
    return;
  }

  const { tracked } = avatar.update(lastLandmarks);
  const detached = isDetached(repo);
  // commit pipeline + its DOM writes run at ~10Hz — commits don't need 60fps,
  // and per-frame textContent/style writes are layout-thrash territory.
  const tickNow = performance.now();
  if (!detached && tickNow - lastCommitTick >= 100) {
    lastCommitTick = tickNow;
    commitTick(tracked);
  } else if (detached) {
    updateDeltaUI(0, 0);
  }
  frames++;
  const now = performance.now();
  if (now - fpsT0 > 800) {
    const fps = (frames * 1000) / (now - fpsT0);
    const avgMs = detects ? detectMs / detects : 0;
    const nDetects = detects;
    frames = 0; detects = 0; detectMs = 0; fpsT0 = now;
    // adapt stride with hysteresis (up at >40ms, back down at <18ms)
    if (avgMs > 40 && detectStride === 1 && nDetects > 0) { detectStride = 2; stridePhase = 0; }
    else if (avgMs < 18 && detectStride === 2 && nDetects > 0) { detectStride = 1; stridePhase = 0; }
    const strideTag = detectStride === 2 ? '/2f' : '';
    if (pendingMerge) {
      const rem = pendingMerge.conflicts.filter((c) => !pendingMerge.resolved[c.key]).length;
      hudRight.textContent = `◉ merging ${pendingMerge.target}→${pendingMerge.baseBranch} · ${rem} left`;
      setStatus('warn', `MERGE ${pendingMerge.target} → ${pendingMerge.baseBranch} — ${rem} conflict${rem === 1 ? '' : 's'} left · commits frozen\nkeep <n> (=${pendingMerge.baseBranch}) · take <n> (=${pendingMerge.target}) · merge --abort`);
      recTxt.textContent = 'merging';
      dot.className = 'warn';
    } else if (detached && repo.HEAD.hash) {
      hudRight.textContent = `◉ @ ${repo.HEAD.hash} · frozen`;
      setStatus('warn', `TIME-TRAVEL @ ${repo.HEAD.hash}\nAvatar holds history (amber). Commits frozen.\ncheckout ${repo.HEAD.branch} to resume live.`);
      recTxt.textContent = 'detached';
      dot.className = 'warn';
    } else if (tracked) {
      hudRight.textContent = `● tracked ${fps.toFixed(0)}fps · ${repo.commits.size} commits`;
      const cooling = now < cooldownUntil ? ' (cooldown)' : '';
      const dbg = liveDbg ? `\nlive: ${liveDbg}` : '';
      setStatus('ok', `TRACKED  fps=${fps.toFixed(0)} detect=${avgMs.toFixed(1)}ms${strideTag} Δ=${lastScore.toFixed(3)}${cooling}${dbg}\nMove sharply to commit. [c]=force commit.`);
      recTxt.textContent = 'tracking';
      dot.className = 'ok';
    } else {
      hudRight.textContent = '○ no pose';
      setStatus('warn', `NO POSE  fps=${fps.toFixed(0)}\nFace the camera, show head + shoulders (sitting is fine), add frontal light.`);
      recTxt.textContent = 'no pose';
    }
  }
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  try {
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      throw new Error('camera needs localhost or https');
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unsupported in this browser');
    if (!landmarker) await initPose();
    await startCamera();
    running = true;
    stopBtn.disabled = false;
    recTxt.textContent = 'starting…';
    setStatus('', 'camera on — hold still for initial human…');
  } catch (e) {
    console.error(e);
    setStatus('err', 'FAILED: ' + e.message + '\nCheck permission + use Chrome/Edge over localhost/https.');
    dot.className = 'err';
    startBtn.disabled = false;
  }
};
stopBtn.onclick = stopCamera;

renderLog();
updateHeadUI();
avatar.update(null);
loop();
