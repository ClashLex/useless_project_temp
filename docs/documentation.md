# human.git — Complete Documentation

## 1. What this is

**human.git puts your body under Git version control.** A webcam tracks your pose in the browser. Significant movements become **commits**. You then operate on yourself with Git semantics: `log`, `checkout`, `diff`, `branch`, `merge` (with conflicts), `stash`, `graph`, `status`.

It solves no real problem on purpose. The premise is a joke; the engineering is genuine — real-time pose estimation, metric-space normalization, adaptive filtering, a custom version-control data model, 3D rendering, and a terminal UI, all client-side with no backend.

> **One-sentence pitch:** human.git is a computer-vision system that puts your body under Git version control, letting you commit, branch, diff, merge, and check out previous versions of yourself.

## 2. How it works (pipeline)

```
webcam → MediaPipe PoseLandmarker → normalize → One Euro smooth
       → delta score → threshold? → commit → log / checkout / diff / branch / merge
                                     ↘ Three.js avatar (live green, history amber, diff ghosts)
```

1. **Detect** — MediaPipe `PoseLandmarker` (lite model, GPU with CPU fallback) yields 33 image landmarks + 33 metric world landmarks per frame at ~30 fps.
2. **Normalize** — world path first (meters, hips-origin, isotropic, y-sign auto-calibrated); image path as fallback. Standing is optional: only visible joints are stored (`null` otherwise); origin/scale prefers hips+torso, falls back to shoulders+width for seated/cropped framings.
3. **Smooth** — One Euro adaptive filter per joint axis: tight when still (no drift-commits), loose when fast (no lag). Render smoothing is separate so visuals stay snappy.
4. **Score** — `score = 0.4·mean + 0.6·max` over visible joints (depth half-weighted; head ×2.5 since rotations barely translate the nose). Raises (~0.40) and half-raises (~0.20) fire at the 0.18 default; sway (~0.06) stays silent.
5. **Commit** — threshold + 800 ms cooldown + settle-after-relock + 6+ visible joints + 3+ compared joints. Messages auto-generated from the biggest visible mover, velocity-confirmed (`raise right hand`, `crouch`, `turn head`…).
6. **Render** — Three.js avatar mirrors you (green = live, amber = history, green/amber ghosts = diff/merge overlays).

## 3. Git concept mapping

| Git concept | Human equivalent |
|---|---|
| Commit | A captured pose snapshot |
| Commit message | Auto-generated description of what moved |
| Log / graph | Chronological movement history / all branches newest-first |
| Checkout | Avatar tweens to an old pose (amber, detached HEAD, commits frozen) |
| Diff | Joint-by-joint comparison + overlaid ghost skeletons |
| Branch | Forked alternate movement sequence |
| Merge | Per-joint reconcile (0.15 tolerance) with visual conflicts |
| Merge conflict | Two branches disagreeing about a limb (`keep`/`take`) |
| Stash | Parked pose, previewed on pop |
| Status | Branch/detached state, counts, merge + stash lines |

## 4. Command reference (`git` prefix optional)

- `log` — HEAD-lineage history (`*` = HEAD, `[branch]` tip tags, time-ago).
- `graph` — all branches newest-first with merge edges (`╮+hash`).
- `checkout <hash|branch>` — time-travel (hash detaches, freezes commits) / resume live (branch).
- `diff [--text] [<a> [<b>]]` — a/b are hashes or branch names; text (`+ RIGHT_HAND moved upward (0.42)`) + green/amber stage overlay.
- `branch [<name>]` — list (with tip hashes) / fork HEAD; `branch -d <name>` deletes (checked-out branch and `main` protected).
- `merge <branch>` — up-to-date / fast-forward / clean auto-merge / visual conflicts; `keep`/`take`/`resolve <n|joint> [ours|theirs]`, `merge --abort`.
- `stash [-m "msg"]` — park current pose; `stash pop` previews ~1.6 s then resumes live; `stash list`/`drop`.
- `status` — state, counts, merge + stash lines. `commit [-m "msg"]` — force-commit now (button or `c` key too). `clear` — re-render + wipe overlay. `help` — one-liner.

## 5. Architecture

```
index.html          UI shell: topbar, source column, 3D stage, terminal
src/main.js         boot, detect loop (~30 Hz), commitTick (~10 Hz), commands, status
src/pose.js         joints, world/image normalize, delta/score, quality, visMap, occlusion hints
src/filters.js      One Euro filter + per-pose wrapper (value + velocity)
src/git.js          Repo {commits, branches, HEAD, stash}; commit/checkout/branch/stash/history
src/messages.js     visibility-gated, velocity-confirmed labels + live debug readout
src/diff.js         joint-by-joint diff + text formatting (mirror-safe wording)
src/merge.js        ancestry, merge analysis, conflict finalize (two-parent commits)
src/avatar.js       Three.js avatar: smoothing, checkout tween, diff/merge ghosts
```

**Data model** — `Commit {hash, parent, secondParent?, mergedBranch?, branch, message, timestamp, pose (normalized), scene (render snapshot)}`; `Repo {commits, branches, HEAD {branch, hash, detached}, stash}`. All state is in-memory; reload resets (by design).

## 6. Key design decisions

- **World landmarks first.** Image-space scale breathes with lean/rotation and fakes motion; metric space doesn't. y-sign self-calibrates, so labels can't invert on any firmware.
- **Presence ignored, visibility rules.** Per MediaPipe's own guidance, `presence` is meaningless; `visibility < 0.5` joints can't vote for labels and `< 0.4` don't enter poses.
- **No left/right words in diffs.** Commit-space +x is screen-left in the mirrored view; diffs say upward/downward/sideways + magnitude instead of risking wrong sides.
- **Frozen states.** Time-travel and merging freeze commits (auto + forced) with hints naming the way out — history can't shift under a checkout or a conflict resolution.
- **Mirror handling.** The Task API doesn't auto-mirror; coordinates are unmirrored sensor frames with anatomical labels. Render + preview mirror manually and consistently.

## 7. Performance

- Commit pipeline + meter DOM at ~10 Hz (filter math uses real timestamps — identical behavior); meter writes change-detected.
- Avatar skips redundant math when the input frame hasn't changed (30 fps camera vs 60 Hz display).
- Adaptive detect stride: slow inference → every 2nd frame (shown as `detect=NNms/2f`), recovers automatically.
- Cheaper GL context, lighter geometries, capped repo (200 commits), bounded graph/ancestry walks. Status shows live `fps` + `detect` ms.

## 8. Run it

```
python3 -m http.server 8000
# open http://localhost:8000 (webcam needs localhost or HTTPS) → START
```

Hold still → `initial human`. Move sharply → commits with narrated labels (`live:` line). Try: `diff`, `branch dance`, `checkout <hash>`, `merge dance`, `stash`, `graph`. Full checklist: `docs/guide.md`. Build history: `docs/progress.md`. Original concept: `docs/human-git-final-report.md`.

## 9. Limitations & next step

- Single person, frontal light, torso-ish framing works best; extreme angles degrade tracking (the UI says so when it happens: occlusion hints, low-visibility counts).
- In-memory only — no persistence, no remotes (there is nothing worth pushing).
- Remaining work is **demo lockdown**: real-lighting threshold tuning, rehearsed 90-second script, fallback clip, console-error sweep.
