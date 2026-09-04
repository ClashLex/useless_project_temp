import {
  checkoutBranch,
  checkoutHash,
  isDetached,
  createBranch,
  stashPush,
  stashPop,
  stashDrop,
  deleteBranch,
  resolveRef,
  headCommit,
} from './git.js';
import { clonePose } from './pose.js';
import { diffPoses, formatDiff } from './diff.js';
import { analyzeMerge, finalizeMerge } from './merge.js';

export function createCommands(ctx) {
  function doCheckoutBranch(name) {
    if (ctx.getPendingMerge()) {
      ctx.ui.appendLog(`$ can't checkout mid-merge — resolve '${ctx.getPendingMerge().target}' or merge --abort`);
      return;
    }
    const r = checkoutBranch(ctx.repo, name);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    ctx.avatar.clearDiff();
    ctx.avatar.resumeLive();
    ctx.tracker.requestRefreeze();
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.updateHeadUI(ctx.repo);
  }

  function doCheckoutHash(prefix) {
    if (ctx.getPendingMerge()) {
      ctx.ui.appendLog(`$ can't checkout mid-merge — resolve '${ctx.getPendingMerge().target}' or merge --abort`);
      return;
    }
    const r = checkoutHash(ctx.repo, prefix);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    if (!r.commit.scene) {
      ctx.ui.appendLog('$ that commit has no pose snapshot (pre-checkout build) — staying live');
      ctx.avatar.resumeLive();
      checkoutBranch(ctx.repo, r.commit.branch);
    } else {
      ctx.avatar.clearDiff();
      ctx.avatar.playTo(r.commit.scene, 600);
    }
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.updateHeadUI(ctx.repo);
  }

  function doStatus() {
    const n = ctx.repo.commits.size;
    const head = headCommit(ctx.repo);
    const pendingMerge = ctx.getPendingMerge();
    const mergeLine = pendingMerge
      ? `\n$ merging '${pendingMerge.target}' → ${pendingMerge.baseBranch} — ${pendingMerge.conflicts.filter((c) => !pendingMerge.resolved[c.key]).length} conflict(s) left (keep/take, or merge --abort)`
      : '';
    ctx.ui.appendLog(
      `$ status: ${isDetached(ctx.repo) ? `detached @ ${ctx.repo.HEAD.hash}` : `on branch ${ctx.repo.HEAD.branch}`} · ` +
        `${n} commit${n === 1 ? '' : 's'}` +
        (head ? ` · HEAD "${head.message}"` : ' · no commits yet') +
        mergeLine +
        (ctx.repo.stash ? `\n$ stash: "${ctx.repo.stash.message}" (${ctx.ui.ago(ctx.repo.stash.timestamp)})` : '')
    );
  }

  function doMerge(target) {
    if (ctx.getPendingMerge()) {
      ctx.ui.appendLog(`$ already merging '${ctx.getPendingMerge().target}' — keep/take to resolve, or merge --abort`);
      return;
    }
    if (isDetached(ctx.repo)) {
      ctx.ui.appendLog(`$ can't merge while time-traveling — checkout ${ctx.repo.HEAD.branch} first`);
      return;
    }
    const r = analyzeMerge(ctx.repo, target);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    if (r.status === 'up-to-date') {
      ctx.ui.appendLog(`$ already up to date${r.reason ? ' — ' + r.reason : ''}`);
      return;
    }
    if (r.status === 'fast-forward') {
      ctx.repo.branches.set(ctx.repo.HEAD.branch, r.tip.hash);
      ctx.repo.HEAD.hash = r.tip.hash;
      ctx.tracker.requestRefreeze();
      ctx.ui.renderLog(ctx.repo);
      ctx.ui.updateHeadUI(ctx.repo);
      ctx.ui.appendLog(`$ fast-forwarded ${ctx.repo.HEAD.branch} → ${r.tip.hash} ("${r.tip.message}")`);
      return;
    }
    if (r.status === 'merged-clean') {
      const pend = {
        target,
        baseBranch: ctx.repo.HEAD.branch,
        currentHash: r.current.hash,
        targetHash: r.incoming.hash,
        resolved: {},
      };
      const f = finalizeMerge(ctx.repo, pend);
      if (!f.ok) {
        ctx.ui.appendLog('$ ' + f.error);
        return;
      }
      ctx.tracker.requestRefreeze();
      ctx.ui.renderLog(ctx.repo);
      ctx.ui.updateHeadUI(ctx.repo);
      ctx.ui.appendLog(`$ merged '${target}' → ${f.commit.branch} as ${f.commit.hash} (clean — every joint agreed)`);
      return;
    }
    // conflicts: freeze commits, overlay both poses, resolve joint by joint
    const pending = {
      target,
      baseBranch: ctx.repo.HEAD.branch,
      currentHash: r.current.hash,
      targetHash: r.incoming.hash,
      conflicts: r.conflicts,
      resolved: {},
      auto: r.auto,
    };
    ctx.setPendingMerge(pending);
    if (r.current.scene && r.incoming.scene) {
      ctx.avatar.showDiff(r.current.scene, r.incoming.scene);
    }
    printConflicts();
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.updateHeadUI(ctx.repo);
  }

  function printConflicts() {
    const p = ctx.getPendingMerge();
    if (!p) return;
    const rem = p.conflicts.filter((c) => !p.resolved[c.key]);
    ctx.ui.appendLog(`$ HUMAN MERGE CONFLICT — '${p.target}' → ${p.baseBranch} (${p.auto} auto, ${rem.length} left)`);
    if (pendingHasScenes(p)) ctx.ui.appendLog(`  (stage: green=${p.baseBranch} · amber=${p.target})`);
    else ctx.ui.appendLog('  (no pose snapshot on an old commit — resolving text-only)');
    rem.forEach((c) => {
      ctx.ui.appendLog(
        `  ${p.conflicts.indexOf(c) + 1}. ${c.pretty}: ${p.baseBranch} ${c.curWord} vs ${p.target} ${c.incWord} (Δ${c.dist.toFixed(2)})`
      );
    });
    ctx.ui.appendLog(`$ keep <n|joint> (=${p.baseBranch}) · take <n|joint> (=${p.target}) · merge --abort`);
  }

  function pendingHasScenes(p) {
    const cur = ctx.repo.commits.get(p.currentHash);
    const tgt = ctx.repo.commits.get(p.targetHash);
    return !!(cur?.scene && tgt?.scene);
  }

  function doMergeAbort() {
    const pendingMerge = ctx.getPendingMerge();
    if (!pendingMerge) {
      ctx.ui.appendLog('$ no merge in progress');
      return;
    }
    ctx.ui.appendLog(`$ merge '${pendingMerge.target}' aborted — no commits created`);
    ctx.setPendingMerge(null);
    ctx.avatar.clearDiff();
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.updateHeadUI(ctx.repo);
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
    const p = ctx.getPendingMerge();
    if (!p) {
      ctx.ui.appendLog('$ nothing to resolve — try: merge <branch>');
      return;
    }
    let side, ref;
    if (cmd === 'keep') {
      side = 'ours';
      ref = rest;
    } else if (cmd === 'take') {
      side = 'theirs';
      ref = rest;
    } else {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 2) {
        ctx.ui.appendLog('$ usage: resolve <n|joint> <ours|theirs>');
        return;
      }
      ref = parts[0];
      const w = parts[1].toLowerCase();
      if (w !== 'ours' && w !== 'theirs') {
        ctx.ui.appendLog('$ side must be ours (=current) or theirs (=incoming)');
        return;
      }
      side = w;
    }
    if (!ref) {
      ctx.ui.appendLog(`$ usage: ${cmd} <n|joint>${cmd === 'resolve' ? ' <ours|theirs>' : ''}`);
      return;
    }
    const c = findConflict(p, ref);
    if (!c) {
      ctx.ui.appendLog(`$ no conflict '${ref}' — numbering follows the list above`);
      return;
    }
    p.resolved[c.key] = side;
    const rem = p.conflicts.filter((x) => !p.resolved[x.key]).length;
    if (rem > 0) {
      ctx.ui.appendLog(`$ ${c.pretty} → ${side === 'ours' ? p.baseBranch : p.target} (${rem} left)`);
      return;
    }
    const target = p.target;
    const nC = p.conflicts.length;
    const f = finalizeMerge(ctx.repo, p);
    ctx.setPendingMerge(null);
    if (!f.ok) {
      ctx.ui.appendLog('$ ' + f.error);
      ctx.avatar.clearDiff();
      ctx.ui.renderLog(ctx.repo);
      ctx.ui.updateHeadUI(ctx.repo);
      return;
    }
    ctx.avatar.clearDiff();
    ctx.tracker.requestRefreeze();
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.updateHeadUI(ctx.repo);
    ctx.ui.appendLog(`$ merged '${target}' → ${f.commit.branch} as ${f.commit.hash} (${nC} resolved)`);
  }

  function doBranch(name) {
    const r = createBranch(ctx.repo, name);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.appendLog(`$ branched '${name}' @ ${ctx.repo.HEAD.hash} — checkout ${name} to move on it`);
  }

  function doBranchDelete(name) {
    const r = deleteBranch(ctx.repo, name);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    ctx.ui.renderLog(ctx.repo);
    ctx.ui.appendLog(`$ deleted branch '${name}'`);
  }

  function doStashPush(msg) {
    if (isDetached(ctx.repo)) {
      ctx.ui.appendLog(`$ can't stash while time-traveling — checkout ${ctx.repo.HEAD.branch} first`);
      return;
    }
    if (ctx.getPendingMerge()) {
      ctx.ui.appendLog(`$ can't stash mid-merge — resolve '${ctx.getPendingMerge().target}' or merge --abort`);
      return;
    }
    const commitSmooth = ctx.tracker.getCommitSmooth();
    if (!commitSmooth) {
      ctx.ui.appendLog('$ nothing to stash — no tracked pose yet');
      return;
    }
    const scene = ctx.avatar.getScene();
    const r = stashPush(ctx.repo, clonePose(commitSmooth), scene, msg);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    ctx.ui.appendLog(`$ stashed "${r.stash.message}" — pop to preview it`);
  }

  function doStashPop() {
    if (isDetached(ctx.repo)) {
      ctx.ui.appendLog(`$ can't pop while time-traveling — checkout ${ctx.repo.HEAD.branch} first`);
      return;
    }
    if (ctx.getPendingMerge()) {
      ctx.ui.appendLog(`$ can't pop mid-merge — resolve '${ctx.getPendingMerge().target}' or merge --abort`);
      return;
    }
    const r = stashPop(ctx.repo);
    if (!r.ok) {
      ctx.ui.appendLog('$ ' + r.error);
      return;
    }
    if (!r.stash.scene) {
      ctx.ui.appendLog(`$ popped "${r.stash.message}" (no preview snapshot)`);
      return;
    }
    ctx.ui.appendLog(`$ popped "${r.stash.message}" — previewing, live resumes`);
    ctx.avatar.playTo(r.stash.scene, 600);
    setTimeout(() => {
      if (ctx.tracker.isRunning() && !isDetached(ctx.repo) && !ctx.getPendingMerge() && ctx.avatar.isPlayback()) {
        ctx.avatar.resumeLive();
      }
    }, 1600);
  }

  function doStashList() {
    if (!ctx.repo.stash) {
      ctx.ui.appendLog('$ stash: empty');
      return;
    }
    ctx.ui.appendLog(`$ stash: "${ctx.repo.stash.message}" (${ctx.ui.ago(ctx.repo.stash.timestamp)})`);
  }

  function doDiff(argStr) {
    const tokens = argStr.trim().split(/\s+/).filter(Boolean);
    const textOnly = tokens.includes('--text');
    const hashes = tokens.filter((t) => !t.startsWith('--'));
    if (hashes.length > 2) {
      ctx.ui.appendLog('$ usage: diff [--text] [<a> [<b>]]  (hash or branch)');
      return;
    }
    let a, b;
    if (hashes.length === 0) {
      const head = headCommit(ctx.repo);
      if (!head) {
        ctx.ui.appendLog('$ no commits yet — stand in frame first');
        return;
      }
      if (!head.parent || !ctx.repo.commits.get(head.parent)) {
        ctx.ui.appendLog('$ need 2 commits to diff — move to commit again');
        return;
      }
      b = head;
      a = ctx.repo.commits.get(head.parent);
    } else if (hashes.length === 1) {
      const rb = resolveRef(ctx.repo, hashes[0]);
      if (!rb.ok) {
        ctx.ui.appendLog('$ ' + rb.error);
        return;
      }
      b = rb.commit;
      if (!b.parent || !ctx.repo.commits.get(b.parent)) {
        ctx.ui.appendLog(`$ ${b.hash} has no parent — give two hashes: diff <a> <b>`);
        return;
      }
      a = ctx.repo.commits.get(b.parent);
    } else {
      const ra = resolveRef(ctx.repo, hashes[0]);
      if (!ra.ok) {
        ctx.ui.appendLog('$ ' + ra.error);
        return;
      }
      const rb = resolveRef(ctx.repo, hashes[1]);
      if (!rb.ok) {
        ctx.ui.appendLog('$ ' + rb.error);
        return;
      }
      a = ra.commit;
      b = rb.commit;
    }
    const d = diffPoses(a.pose, b.pose);
    ctx.ui.appendLog(
      formatDiff(a.hash, b.hash, d)
        .split('\n')
        .map((l, i) => (i === 0 ? '$ ' + l : '  ' + l))
        .join('\n')
    );
    if (textOnly) return;
    if (ctx.getPendingMerge()) {
      ctx.ui.appendLog('  (stage overlay kept for the merge — resolve first)');
      return;
    }
    if (!a.scene || !b.scene) {
      ctx.ui.appendLog('  (no pose snapshot on an old commit — overlay skipped)');
      return;
    }
    ctx.avatar.showDiff(a.scene, b.scene);
    ctx.ui.appendLog(`  (stage: green=${a.hash} · amber=${b.hash} — clear wipes overlay)`);
  }

  function execute(rawIn) {
    if (!rawIn) return;
    const raw = rawIn.replace(/^git\s+/, '');
    const m = raw.match(/^commit\s+-m\s+"([^"]+)"|^commit\s+-m\s+'([^']+)'|^commit\s+-m\s+(\S+)/);
    if (/^(log|git log)$/.test(rawIn) || raw === 'log') {
      ctx.ui.renderLog(ctx.repo);
      return;
    }
    const co = raw.match(/^checkout\s+(\S+)\s*$/);
    if (co) {
      const target = co[1];
      if (ctx.repo.branches.has(target)) doCheckoutBranch(target);
      else doCheckoutHash(target);
      return;
    }
    if (raw === 'checkout') {
      ctx.ui.appendLog('$ usage: checkout <hash|branch>');
      return;
    }
    if (raw === 'diff' || raw.startsWith('diff ')) {
      doDiff(raw.slice('diff'.length));
      return;
    }
    if (raw === 'merge' || raw.startsWith('merge ')) {
      const arg = raw.slice('merge'.length).trim();
      if (!arg) {
        ctx.ui.appendLog('$ usage: merge <branch> | merge --abort');
        return;
      }
      if (arg === '--abort') {
        doMergeAbort();
        return;
      }
      if (/\s/.test(arg)) {
        ctx.ui.appendLog('$ usage: merge <branch>');
        return;
      }
      doMerge(arg);
      return;
    }
    const rsm = raw.match(/^(keep|take|resolve)(?:\s+(.*))?$/);
    if (rsm) {
      doResolve(rsm[1], (rsm[2] || '').trim());
      return;
    }
    if (raw === 'status') {
      doStatus();
      return;
    }
    if (raw === 'branch' || raw.startsWith('branch ')) {
      const arg = raw.slice('branch'.length).trim();
      if (!arg) {
        const names = [...ctx.repo.branches.keys()]
          .map((b) => `${b === ctx.repo.HEAD.branch && !isDetached(ctx.repo) ? '*' : ' '} ${b}@${ctx.repo.branches.get(b) || '(empty)'}`)
          .join('\n');
        ctx.ui.appendLog('$ branches:\n' + names);
      } else if (arg === '-d' || arg.startsWith('-d ')) {
        const name = arg.slice(2).trim();
        if (!name || /\s/.test(name)) ctx.ui.appendLog('$ usage: branch -d <name>');
        else doBranchDelete(name);
      } else if (/\s/.test(arg)) {
        ctx.ui.appendLog('$ usage: branch <name> | branch -d <name>');
      } else {
        doBranch(arg);
      }
      return;
    }
    if (raw === 'graph') {
      ctx.ui.graphLog(ctx.repo);
      return;
    }
    if (raw === 'stash' || raw.startsWith('stash ')) {
      const rest = raw.slice('stash'.length).trim();
      const pushM = rest.match(/^(?:push\s+)?-m\s+"([^"]+)"|^(?:push\s+)?-m\s+'([^']+)'|^(?:push\s+)?-m\s+(\S+)/);
      if (!rest || rest === 'push' || pushM) {
        doStashPush(pushM ? pushM[1] || pushM[2] || pushM[3] : undefined);
      } else if (rest === 'pop') {
        doStashPop();
      } else if (rest === 'list') {
        doStashList();
      } else if (rest === 'drop') {
        const r = stashDrop(ctx.repo);
        ctx.ui.appendLog(r.ok ? '$ stash dropped' : '$ ' + r.error);
      } else {
        ctx.ui.appendLog('$ usage: stash [-m "msg"] | stash pop | stash list | stash drop');
      }
      return;
    }
    if (/^commit(\s|$)/.test(raw)) {
      ctx.tracker.forceCommit(m ? m[1] || m[2] || m[3] : undefined);
      return;
    }
    if (raw === 'clear') {
      ctx.avatar.clearDiff();
      ctx.ui.renderLog(ctx.repo);
      return;
    }
    if (raw === 'help') {
      ctx.ui.appendLog(
        '$ commands: log · graph · checkout <hash|branch> · diff [--text] [<a> [<b>]] · branch [<name>|-d <name>] · merge <branch> · keep/take <n|joint> · stash [pop|list|drop] · status · commit [-m "msg"] · clear'
      );
      return;
    }
    ctx.ui.appendLog(`$ unknown: ${rawIn} (try: log)`);
  }

  return {
    execute,
    doCheckoutBranch,
    doCheckoutHash,
    doStatus,
    doMerge,
    doMergeAbort,
    doResolve,
    doBranch,
    doBranchDelete,
    doStashPush,
    doStashPop,
    doStashList,
    doDiff,
  };
}

export function initCommands(ctx) {
  const handler = createCommands(ctx);
  ctx.ui.elements.cmdEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const rawIn = ctx.ui.elements.cmdEl.value.trim();
    ctx.ui.elements.cmdEl.value = '';
    handler.execute(rawIn);
  });
  return handler;
}
