import { createAvatar } from './avatar.js';
import { createRepo } from './git.js';
import * as ui from './ui.js';
import { createTracker } from './tracking.js';
import { initCommands } from './commands.js';

// Core instances
const avatar = createAvatar(document.getElementById('c'));
const repo = createRepo();
let pendingMerge = null;

const tracker = createTracker({
  repo,
  avatar,
  ui,
  getPendingMerge: () => pendingMerge,
  setPendingMerge: (val) => {
    pendingMerge = val;
  },
});

initCommands({
  repo,
  avatar,
  ui,
  tracker,
  getPendingMerge: () => pendingMerge,
  setPendingMerge: (val) => {
    pendingMerge = val;
  },
});

// UI controls & event wiring
ui.initThreshold((val) => tracker.setThreshold(val));
tracker.setThreshold(parseFloat(ui.elements.thresh.value));

ui.elements.commitBtn.onclick = () => tracker.forceCommit();

window.addEventListener('keydown', (e) => {
  if (
    (e.key === 'c' || e.key === 'C') &&
    tracker.isRunning() &&
    document.activeElement !== ui.elements.cmdEl
  ) {
    tracker.forceCommit();
  }
});

ui.elements.startBtn.onclick = () => tracker.start();
ui.elements.stopBtn.onclick = () => tracker.stop();

// Main render & tracking loop
function loop() {
  requestAnimationFrame(loop);
  if (!tracker.isReady() || document.hidden) return;

  tracker.detect(ui.elements.video);

  if (!tracker.isRunning()) {
    avatar.update(null);
    return;
  }

  const { tracked } = avatar.update(tracker.getLastLandmarks());
  tracker.tick(tracked);
}

// Boot
ui.renderLog(repo);
ui.updateHeadUI(repo);
avatar.update(null);
loop();
