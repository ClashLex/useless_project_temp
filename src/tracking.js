import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import {
  COMMIT_JOINTS,
  toNormalizedPose,
  toNormalizedPoseWorld,
  poseDelta,
  clonePose,
  poseQuality,
  visMap,
  hiddenSides,
} from './pose.js';
import { headCommit, isDetached, commitPose } from './git.js';
import { describeMovement, movementDebug } from './messages.js';
import { EuroPose } from './filters.js';

export function createTracker({ repo, avatar, ui, getPendingMerge, setPendingMerge }) {
  let landmarker = null;
  let stream = null;
  let running = false;
  let lastLandmarks = null;
  let lastWorld = null;
  let lastTracked = false; // live right now (not stale from before tracking loss)
  let lastVideoTime = -1;
  let lastTs = 0;
  let frames = 0;
  let detects = 0;
  let detectMs = 0;
  let fpsT0 = performance.now();
  let detectStride = 1;
  let stridePhase = 0;

  // commit engine state (separate from render smoothing)
  let commitSmooth = null;
  let commitVel = {};
  let lastVis = {};
  let liveDbg = '';
  const euro = new EuroPose({ joints: COMMIT_JOINTS, freq: 30, mincutoff: 1.1, beta: 0.4, dcutoff: 1.0 });
  let stableFrames = 0;
  let cooldownUntil = 0;
  let threshold = 0.18;
  let lastDeltaMean = 0;
  let lastScore = 0;
  let needRefreeze = false; // after tracking loss, settle before committing
  let refreezeFrames = 0;
  let lastCommitTick = 0; // commit pipeline runs at ~10Hz, render stays full-rate
  const torsoEMA = { value: null };
  // stash preview owns the stage while active: avatar holds the stashed pose
  // (amber), HUD announces it, and live auto-resumes when the hold expires.
  let previewUntil = 0;
  let previewLabel = '';

  function setThreshold(val) {
    threshold = val;
    ui.updateDeltaUI(lastDeltaMean, lastScore, threshold);
  }

  function requestRefreeze() {
    needRefreeze = true;
    refreezeFrames = 0;
  }

  // Play a stashed pose on stage: tween there, hold it visibly, then hand the
  // stage back to live tracking. Returns false when there is nothing to play.
  // Tick-driven expiry (not setTimeout) so overlapping pops and mode changes
  // can't strand or double-trigger the resume.
  function previewScene(scene, label, holdMs = 2200) {
    if (!scene || !avatar.playTo(scene, 600)) return false;
    avatar.clearDiff();
    requestRefreeze(); // don't instant-commit drift when live resumes
    previewUntil = performance.now() + holdMs;
    previewLabel = label || 'stash';
    return true;
  }

  function cancelPreview() {
    previewUntil = 0;
    previewLabel = '';
  }

  function previewing() {
    return previewUntil > performance.now();
  }

  async function initPose() {
    ui.setStatus('', 'loading pose model…');
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    const model =
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
    try {
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });
    } catch {
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });
    }
  }

  async function startCamera() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    ui.elements.video.srcObject = stream;
    await ui.elements.video.play();
  }

  function stop() {
    running = false;
    previewUntil = 0;
    previewLabel = '';
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
    lastTracked = false;
    if (setPendingMerge) setPendingMerge(null);
    avatar.clearDiff();
    avatar.resumeLive();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    ui.elements.video.srcObject = null;
    ui.elements.startBtn.disabled = false;
    ui.elements.stopBtn.disabled = true;
    ui.setStatus('', 'stopped. click START to resume.');
    ui.elements.recTxt.textContent = 'idle';
    ui.elements.hudRight.textContent = 'no pose';
    avatar.update(null);
  }

  async function start() {
    ui.elements.startBtn.disabled = true;
    try {
      if (!window.isSecureContext && location.hostname !== 'localhost') {
        throw new Error('camera needs localhost or https');
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unsupported in this browser');
      if (!landmarker) await initPose();
      await startCamera();
      running = true;
      ui.elements.stopBtn.disabled = false;
      ui.elements.recTxt.textContent = 'starting…';
      ui.setStatus('', 'camera on — hold still for initial human…');
    } catch (e) {
      console.error(e);
      ui.setStatus('err', 'FAILED: ' + e.message + '\nCheck permission + use Chrome/Edge over localhost/https.');
      ui.elements.dot.className = 'err';
      ui.elements.startBtn.disabled = false;
    }
  }

  function doCommit(pose, forcedMsg) {
    if (isDetached(repo)) {
      ui.appendLog('$ commits frozen while time-traveling — checkout ' + repo.HEAD.branch + ' to resume');
      return null;
    }
    const pendingMerge = getPendingMerge ? getPendingMerge() : null;
    if (pendingMerge) {
      ui.appendLog(`$ commits frozen mid-merge — resolve '${pendingMerge.target}' or merge --abort`);
      return null;
    }
    const head = headCommit(repo);
    const delta = head ? poseDelta(head.pose, pose) : null;
    const msg = forcedMsg || describeMovement(head?.pose || null, pose, delta, { velMap: commitVel, vis: lastVis });
    const scene = avatar.getScene();
    const c = commitPose(repo, pose, msg, scene);
    cooldownUntil = performance.now() + 800;
    ui.renderLog(repo);
    return c;
  }

  function forceCommit(msg) {
    // commitSmooth survives tracking loss — never commit (or stash) a ghost.
    if (!lastTracked || !commitSmooth) {
      if (!lastTracked) ui.appendLog('$ no live track — step into frame first');
      return;
    }
    if (isDetached(repo)) {
      ui.appendLog(`$ commits frozen @ ${repo.HEAD.hash} — checkout ${repo.HEAD.branch} to resume`);
      return;
    }
    doCommit(clonePose(commitSmooth), msg);
  }

  function commitTick(tracked) {
    if (isDetached(repo)) return; // frozen while time-traveling
    if (!tracked || (!lastLandmarks && !lastWorld)) {
      stableFrames = 0;
      needRefreeze = true; // settle on reacquire so stale pose can't instant-commit
      refreezeFrames = 0;
      euro.reset();
      liveDbg = '';
      ui.updateDeltaUI(0, 0, threshold);
      return;
    }
    // quality-gate commits only — render stays permissive so avatar never freezes.
    // visibility exists on both image and world outputs.
    const rawFrame = lastWorld || lastLandmarks;
    const q = poseQuality(rawFrame);
    if (!q.usable) {
      liveDbg = `only ${q.visible}/12 joints visible (need 6+) — move into frame`;
      ui.updateDeltaUI(0, 0, threshold);
      return;
    }
    // world landmarks first: metric meters, isotropic, stable torso.
    // image path is the fallback (aspect-corrected + torso EMA).
    let norm = null;
    if (lastWorld) {
      norm = toNormalizedPoseWorld(lastWorld);
    } else {
      const vid = ui.elements.video;
      const aspect = vid.videoWidth && vid.videoHeight ? vid.videoWidth / vid.videoHeight : 16 / 9;
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
      stableFrames++;
      ui.updateDeltaUI(0, 0, threshold);
      if (stableFrames >= 3) doCommit(commitSmooth);
      return;
    }
    if (needRefreeze) {
      refreezeFrames++;
      const delta = poseDelta(head.pose, commitSmooth);
      ui.updateDeltaUI(delta.mean, delta.score, threshold);
      liveDbg = movementDebug(head.pose, commitSmooth, delta, { velMap: commitVel, vis: lastVis });
      if (refreezeFrames >= 3) needRefreeze = false;
      return;
    }
    const delta = poseDelta(head.pose, commitSmooth);
    ui.updateDeltaUI(delta.mean, delta.score, threshold);
    liveDbg = movementDebug(head.pose, commitSmooth, delta, { velMap: commitVel, vis: lastVis });
    if (delta.score < threshold * 0.5) {
      const hidden = hiddenSides(rawFrame);
      if (hidden.length === 1) liveDbg = `${hidden[0]} arm hidden — reframe / add light on that side`;
      else if (hidden.length === 2) liveDbg = 'both arms hidden — show your arms to commit';
    }
    const pendingMerge = getPendingMerge ? getPendingMerge() : null;
    if (!pendingMerge && delta.score > threshold && delta.count >= 3 && performance.now() > cooldownUntil) {
      doCommit(commitSmooth);
    }
  }

  function detect(video) {
    if (running && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
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
  }

  function tick(tracked) {
    lastTracked = tracked;
    if (previewUntil && performance.now() >= previewUntil) {
      cancelPreview();
      if (running && !isDetached(repo) && avatar.isPlayback()) avatar.resumeLive();
    }
    const detached = isDetached(repo);
    const tickNow = performance.now();
    if (!detached && tickNow - lastCommitTick >= 100) {
      lastCommitTick = tickNow;
      commitTick(tracked);
    } else if (detached) {
      ui.updateDeltaUI(0, 0, threshold);
    }

    frames++;
    const now = performance.now();
    if (now - fpsT0 > 800) {
      const fps = (frames * 1000) / (now - fpsT0);
      const avgMs = detects ? detectMs / detects : 0;
      const nDetects = detects;
      frames = 0;
      detects = 0;
      detectMs = 0;
      fpsT0 = now;

      if (avgMs > 40 && detectStride === 1 && nDetects > 0) {
        detectStride = 2;
        stridePhase = 0;
      } else if (avgMs < 18 && detectStride === 2 && nDetects > 0) {
        detectStride = 1;
        stridePhase = 0;
      }
      const strideTag = detectStride === 2 ? '/2f' : '';
      const pendingMerge = getPendingMerge ? getPendingMerge() : null;

      if (previewing()) {
        ui.elements.hudRight.textContent = `◉ stash ${previewLabel} · previewing`;
        ui.setStatus(
          'warn',
          `STASH ${previewLabel} · previewing saved pose (amber) — hands off, live resumes`
        );
        ui.elements.recTxt.textContent = 'preview';
        ui.elements.dot.className = 'warn';
      } else if (pendingMerge) {
        const rem = pendingMerge.conflicts.filter((c) => !pendingMerge.resolved[c.key]).length;
        ui.elements.hudRight.textContent = `◉ merging ${pendingMerge.target}→${pendingMerge.baseBranch} · ${rem} left`;
        ui.setStatus(
          'warn',
          `MERGE ${pendingMerge.target} → ${pendingMerge.baseBranch} — ${rem} conflict${rem === 1 ? '' : 's'} left · commits frozen\nkeep <n> (=${pendingMerge.baseBranch}) · take <n> (=${pendingMerge.target}) · merge --abort`
        );
        ui.elements.recTxt.textContent = 'merging';
        ui.elements.dot.className = 'warn';
      } else if (detached && repo.HEAD.hash) {
        ui.elements.hudRight.textContent = `◉ @ ${repo.HEAD.hash} · frozen`;
        ui.setStatus(
          'warn',
          `TIME-TRAVEL @ ${repo.HEAD.hash}\nAvatar holds history (amber). Commits frozen.\ncheckout ${repo.HEAD.branch} to resume live.`
        );
        ui.elements.recTxt.textContent = 'detached';
        ui.elements.dot.className = 'warn';
      } else if (tracked) {
        ui.elements.hudRight.textContent = `● tracked ${fps.toFixed(0)}fps · ${repo.commits.size} commits`;
        const cooling = now < cooldownUntil ? ' (cooldown)' : '';
        const dbg = liveDbg ? `\nlive: ${liveDbg}` : '';
        ui.setStatus(
          'ok',
          `TRACKED  fps=${fps.toFixed(0)} detect=${avgMs.toFixed(1)}ms${strideTag} Δ=${lastScore.toFixed(3)}${cooling}${dbg}\nMove sharply to commit. [c]=force commit.`
        );
        ui.elements.recTxt.textContent = 'tracking';
        ui.elements.dot.className = 'ok';
      } else {
        ui.elements.hudRight.textContent = '○ no pose';
        ui.setStatus(
          'warn',
          `NO POSE  fps=${fps.toFixed(0)}\nFace the camera, show head + shoulders (sitting is fine), add frontal light.`
        );
        ui.elements.recTxt.textContent = 'no pose';
      }
    }
  }

  return {
    start,
    stop,
    detect,
    tick,
    commitTick,
    forceCommit,
    doCommit,
    requestRefreeze,
    previewScene,
    cancelPreview,
    previewing,
    setThreshold,
    getThreshold: () => threshold,
    isRunning: () => running,
    isTracked: () => lastTracked && running,
    isReady: () => !!landmarker,
    getLastLandmarks: () => lastLandmarks,
    getLastWorld: () => lastWorld,
    getCommitSmooth: () => commitSmooth,
    getState: () => ({
      running,
      landmarker,
      lastLandmarks,
      lastWorld,
      commitSmooth,
      liveDbg,
      lastScore,
      lastDeltaMean,
      cooldownUntil,
      threshold,
    }),
  };
}
