import { isDetached, history } from './git.js';

export const elements = {
  video: document.getElementById('video'),
  statusEl: document.getElementById('status'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  dot: document.getElementById('dot'),
  recTxt: document.getElementById('recTxt'),
  hudRight: document.getElementById('hudRight'),
  deltaVal: document.getElementById('deltaVal'),
  deltaBar: document.getElementById('deltaBar'),
  commitCount: document.getElementById('commitCount'),
  thresh: document.getElementById('thresh'),
  threshVal: document.getElementById('threshVal'),
  logEl: document.getElementById('log'),
  cmdEl: document.getElementById('cmd'),
  commitBtn: document.getElementById('commitBtn'),
  branchBadge: document.getElementById('branchBadge'),
  modeBanner: document.getElementById('modeBanner'),
  hudLeft: document.getElementById('hudLeft'),
};

export function setStatus(mode, msg) {
  elements.statusEl.textContent = msg;
  elements.dot.className = mode;
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function tipTags(repo, hash) {
  const tags = [];
  for (const [b, hh] of repo.branches) {
    if (hh === hash) tags.push(`[${b}]`);
  }
  return tags.length ? ' ' + tags.join(' ') : '';
}

export function headLabel(repo) {
  return repo.HEAD.hash
    ? (isDetached(repo) ? `detached @ ${repo.HEAD.hash}` : `⎇ ${repo.HEAD.branch}`)
    : '⎇ main (empty)';
}

export function renderLog(repo) {
  const h = history(repo, 30);
  elements.commitCount.textContent = `${repo.commits.size} commit${repo.commits.size === 1 ? '' : 's'}`;
  const head = headLabel(repo);
  if (!h.length) {
    elements.logEl.textContent = `HUMAN REPOSITORY — ${head}\n(no commits yet — stand in frame)`;
    return;
  }
  const lines = h.map((c) =>
    `${c.hash === repo.HEAD.hash ? '*' : ' '} ${c.hash}${tipTags(repo, c.hash)}  ${c.message} (${ago(c.timestamp)})`
  );
  elements.logEl.textContent = `HUMAN REPOSITORY — ${head}\n\n` + lines.join('\n');
  elements.logEl.scrollTop = 0;
}

// All branches at once, newest first, with merge edges —
// `git log --graph --all --decorate` for bodies. `log` stays HEAD-lineage.
export function graphLog(repo) {
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
  const head = headLabel(repo);
  if (!all.length) {
    elements.logEl.textContent = `HUMAN GRAPH — ${head}\n(no commits yet — stand in frame)`;
    return;
  }
  const lines = all.map((c) =>
    `${c.hash === repo.HEAD.hash ? '*' : 'o'} ${c.hash}${tipTags(repo, c.hash)}  ${c.message} (${ago(c.timestamp)})` +
    (c.secondParent ? ` ╮+${c.secondParent.slice(0, 4)}` : '')
  );
  elements.logEl.textContent = `HUMAN GRAPH — ${head}\n\n` + lines.join('\n');
  elements.logEl.scrollTop = 0;
}

export function updateHeadUI(repo) {
  if (isDetached(repo) && repo.HEAD.hash) {
    elements.branchBadge.textContent = `detached @ ${repo.HEAD.hash}`;
    elements.hudLeft.textContent = `$ pose @ ${repo.HEAD.hash}`;
    if (elements.modeBanner) elements.modeBanner.textContent = `time-travel @ ${repo.HEAD.hash} — checkout ${repo.HEAD.branch} to resume`;
  } else {
    elements.branchBadge.textContent = `⎇ ${repo.HEAD.branch}`;
    elements.hudLeft.textContent = '$ pose --live';
    if (elements.modeBanner) elements.modeBanner.textContent = 'live — checkout an old hash to time-travel';
  }
}

export function appendLog(msg) {
  elements.logEl.textContent += `\n${msg}`;
  elements.logEl.scrollTop = elements.logEl.scrollHeight;
}

// Change-detected DOM writes: identical values (e.g. parked 0s while
// detached, or a held still pose) skip layout/style recalc entirely.
let lastDeltaText = null;
let lastDeltaWidth = null;
let lastDeltaColor = null;

export function updateDeltaUI(mean, score, threshold = 0.18) {
  const lastScore = score ?? mean;
  const text = lastScore.toFixed(3);
  const width = `${Math.min(100, (lastScore / (threshold * 1.5)) * 100).toFixed(0)}%`;
  const color = lastScore > threshold ? '#00ff66' : '#0a5c2a';
  if (text !== lastDeltaText) { elements.deltaVal.textContent = text; lastDeltaText = text; }
  if (width !== lastDeltaWidth) { elements.deltaBar.style.width = width; lastDeltaWidth = width; }
  if (color !== lastDeltaColor) { elements.deltaBar.style.background = color; lastDeltaColor = color; }
}

export function initThreshold(onInput) {
  elements.thresh.oninput = () => {
    const val = parseFloat(elements.thresh.value);
    elements.threshVal.textContent = val.toFixed(2);
    if (onInput) onInput(val);
  };
  return parseFloat(elements.thresh.value);
}
