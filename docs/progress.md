# human.git — Progress So Far

## The idea

**human.git puts your body under Git version control.** A webcam tracks your pose in the browser. Significant movements become **commits**. You then use Git-like commands on yourself: `log`, `checkout`, `diff`, `branch` — and later `merge`.

It solves no real problem on purpose. The joke is the premise; the engineering is real. Success = a judge thinks *"completely unnecessary"* followed by *"but how did they build that?"*

Everything runs client-side in one browser tab. No backend. Libraries (Three.js, MediaPipe Tasks Vision) load from CDN.

## What works today

### 1. Live body tracking (Hours 0–2)
- Webcam → MediaPipe `PoseLandmarker` (33 landmarks + metric world landmarks, 1 pose) → Three.js avatar.
- 13-joint subset rendered: head, shoulders, elbows, wrists, hips, knees, ankles. Spheres for joints, cylinders for limbs, ground grid, idle ghost T-pose before lock.
- Mirror view (raise RIGHT hand → avatar mirrors it on screen-right). Render mapping is window-size independent. Labels are anatomical person-view (MediaPipe does not auto-mirror; Task API has no selfie mode — mirroring is handled manually and consistently in render + preview).
- Robustness: GPU with CPU fallback, detection confidence 0.3, monotonic timestamps, duplicate-frame skip, render/decoupled detect so the stage never freezes, snap-on-lock (no float-in), single-frame teleport clamp, STOP/START with track cleanup, secure-context checks with clear errors.

### 2. Auto-commit engine (Hours 2–5, hardened since)
- **Normalize:** world-landmark path first — metric meters, hips-origin, isotropic, real ~0.5 m torso, stable across camera distance. Image path (aspect-corrected + torso EMA) is the fallback. Output y-sign auto-calibrated from the skeleton itself, always y-down downstream. **Standing is optional:** poses store only visible joints (`null` otherwise); origin/scale prefers hips+torso, falls back to shoulders+width for seated/cropped framings.
- **Smooth:** One Euro filter per joint axis (`src/filters.js`) — tight when still (no drift-commits), loose when fast (no lag). Replaced the old fixed-alpha EMA. Render smoothing (0.6) stays separate so visuals stay snappy. Null-safe (holds last known, adopts newly visible).
- **Delta:** `score = 0.4·mean + 0.6·max` over visible joints only (depth half-weighted — MediaPipe documents z as far less accurate). Max-led so tentative half-raises (~0.20) still fire; full raises (~0.40) fire hard; sway (~0.06) stays silent at 0.18. Head carries ×2.5: turns/nods rotate more than they translate, so unweighted the nose could never reach threshold — direction vectors stay raw, and diff/merge (separate metric) are untouched.
- **Trigger:** `threshold` slider (0.08–0.35, default 0.18) + 800 ms cooldown + refreeze settle after tracking loss + framing-agnostic quality gate (6+ visible joints of 12 — seated works; avatar stays fully permissive) + minimum 3 compared joints per auto-commit. A faulty hysteresis gate that locked out commits after the first one was found and removed.
- **Messages:** biggest mover wins, but occluded joints (visibility < 0.5) can't vote — `presence` ignored per MediaPipe's own guidance. Live One Euro velocity must agree with displacement direction, else velocity wins (fixes "said lowered while I raised"). Whole-body crouch/stand patterns beat single-joint max. Status shows a live debug line (`live: rightWrist y↓0.38 (v↓2.4)`) narrating every label.
- **Log:** `HUMAN REPOSITORY` terminal panel, most-recent-first, `*` marks HEAD, `[branch]` tags mark tips, header shows branch/detached state. Force commit via button, `c` key, or `commit [-m "msg"]`.

### 3. Checkout / time-travel (Hours 5–8)
- Every commit stores two poses: normalized `pose` (diff/merge) + render-space `scene` snapshot (playback).
- `checkout <hash>` (≥3 chars, ambiguous/short/unknown handled): HEAD detaches, avatar tweens 600 ms ease-in-out to the stored pose, rendered **amber** (green = live, amber = history). Mid-tween re-checkout starts from what's on screen.
- While detached: auto and force commits frozen with hints, delta meter parked, HUD shows `◉ @ <hash> · frozen`, status shows TIME-TRAVEL, branch badge shows `detached @ <hash>`.
- `checkout main` (or any branch): re-attaches HEAD, resumes live after a short settle, committing restarts.

### 4. Diff + branch (Hours 8–11)
- `branch <name>` forks HEAD (creates without switching, like real Git; works detached too; names validated). `branch` lists with `*` + tip hashes.
- `diff [--text] [<a> [<b>]]` — no args: HEAD vs parent; one: commit vs its parent; two: A vs B. Text report (`+ RIGHT_HAND moved upward (0.42)`, unchanged count, identical-pose case) avoids left/right words (mirror-ambiguous by design) in favor of upward/downward/sideways + magnitude.
- Visual diff: both snapshots render as stage ghosts (green = A, amber = B) beside live tracking until `clear`, `checkout`, or STOP. `--text` skips the overlay.

### 5. Merge + conflicts (Hours 11–14)
- `merge <branch>`: up-to-date (same tip / already inside), fast-forward (ref jump, no commit), clean auto-merge (all joints within 0.15), or conflicts.
- Conflicts list disagreeing joints (`1. RIGHT_HAND: main UP vs dance DOWN (Δ0.95)`, vertical words only) with both poses overlaid (green = current, amber = incoming). Resolve via `keep`/`take`/`resolve <n|joint> [ours|theirs]` (numbers or names, re-resolvable); last resolution auto-creates the merge commit (two parents, scene mixed joint-wise so it stays check-out-able). `merge --abort` bails clean.
- Frozen mid-merge (commits, checkout, new merges block with hints); `diff` stays read-only; `status`/HUD show the merge state. Ancestry walks both parents so later merges resolve correctly.

### 6. Command reference (`git` prefix optional everywhere)
- `log` — HEAD-lineage history with HEAD marker, branch tags, time-ago. `graph` — all branches newest-first with merge edges (`╮+hash`).
- `checkout <hash|branch>` — time-travel / resume live.
- `diff [--text] [<a> [<b>]]` — a/b are hashes or branch names; text + green/amber overlay.
- `branch [<name>]` — list (with tip hashes) / fork; `branch -d <name>` deletes (checked-out branch and `main` protected).
- `merge <branch>` — fast-forward / clean auto-merge / visual conflicts (`keep`/`take`/`resolve`, `merge --abort`).
- `stash [-m "msg"]` — park current pose; `stash pop` previews then resumes live; `stash list`/`drop`.
- `status` — branch/detached state, count, HEAD message, merge + stash lines.
- `commit [-m "msg"]` — force-commit current pose now.
- `clear` — re-render log + wipe overlay (a shell-ism, not Git; commits untouched).
- `help` — one-line command list.

### 7. UI rework
- Topbar (brand, `⎇ main` / detached badge, status pill, commit count, START/STOP), left column (webcam source + status console + motion trigger + framing tips), center 3D stage (floating HUD + mode banner), right repository terminal (scrollable log, `$` input, quick chips: log / checkout / diff / status / commit / clear / help), footer shortcuts.
- Green-on-black terminal theme, responsive (3-column → 2-column → stacked, stage first on mobile). Preview stays mirrored. CDN preconnects + dark color-scheme for load polish.

### 8. Performance pass (+ audit)
- Render: same-frame input skip (camera 30 fps vs 60 Hz display ≈ half the avatar math eliminated), single `drawLive()` path, cheaper GL context (`high-performance`, no stencil), lighter geometries, static grid skips matrix updates.
- Commit pipeline throttled 60 Hz → ~10 Hz (filter math uses real timestamps, so behavior identical; settle counts adjusted to preserve feel). Meter DOM writes are change-detected — parked/throttled values skip layout recalc entirely.
- Adaptive detect stride: inference > 40 ms averages → every 2nd video frame (render smoothing covers the gap), recovers below 18 ms, shown live as `detect=45.2ms/2f`.
- Audit: all git/merge/diff walks capped (500/200/50/30), fixed-size filter state, textContent-only DOM (no injection surface), every import used, frozen-state guards verified (detach/merge/stop), stash-pop edge without snapshot now reports honestly.

## Repo layout

```
index.html                  # UI shell (topbar, source, stage, terminal)
src/main.js                 # boot, detect loop, commitTick, commands, status
src/pose.js                 # joints, world/image normalize, delta/score, quality, visMap
src/filters.js              # One Euro filter + per-pose wrapper
src/git.js                  # Repo {commits, branches, HEAD}, commit/checkout/branch/history
src/messages.js             # visibility-gated, velocity-confirmed commit messages + debug
src/diff.js                 # joint-by-joint diff + text formatting
src/avatar.js               # Three.js avatar, smoothing, playback tween, diff overlay
human-git-final-report.md   # original concept + 18h plan
```

## Run it

```
python3 -m http.server 8000
# open http://localhost:8000 → START → hold still → move
```

Confirm health: hold still → `initial human`; raise hand → one commit with a matching label + `live:` debug line; sit still → no spam and meter DOM goes quiet; `diff` → text + green/amber ghosts; `branch dance` → pose → commits land on `dance`; `checkout <first-hash>` → amber time-travel; `checkout main` → green live resumes; `stash` → `stash pop` previews then resumes.

## What's next (per the 18h plan)

Plan core is complete (pipeline → commits → checkout → diff/branch → merge). Remaining:

- **Polish (done this round):** `stash`/`pop`/`list`/`drop`, `graph` view, rich log rows (time-ago, tip tags, merge edges), `branch -d`, diff by branch name.
- **Hours 16–18: demo lockdown** — no new features: threshold tuning on real lighting, full demo rehearsal, fallback clip, console-error sweep.
