# human.git — Feature Verification Guide

How to prove every feature works, in order. Each check lists **do → expect**.
Serve first: `python3 -m http.server 8000` → open `http://localhost:8000` (or your LAN `https` URL). Use Chrome/Edge.

## 0. Boot

- **Do:** load the page (no camera yet).
- **Expect:** topbar (`human.git`, `⎇ main`, idle pill, `0 commits`), webcam card with START, motion card (`Δ —`, threshold `0.18`), dark stage with faint rotating ghost T-pose + grid, terminal with `(no commits yet — stand in frame)`, HUD `$ pose --live` / `no pose`.

## 1. Tracking (webcam → avatar)

- **Do:** START → allow camera → face it, head + shoulders visible (sitting is fine).
- **Expect:** status `TRACKED fps=.. detect=..ms Δ=..`, pill green + `tracking`, HUD `● tracked`.
- **Do:** raise RIGHT hand.
- **Expect:** avatar mirrors it on screen-right; preview video is mirrored the same way.
- **Do:** cover camera / leave frame.
- **Expect:** `NO POSE` + hint, ghost T-pose returns. Return → tracking resumes after a short settle (no ghost commit).

## 2. Commits + messages + log

- **Do:** hold still ~1 s.
- **Expect:** `initial human` appears in log; header `HUMAN REPOSITORY — ⎇ main`; count `1 commit`.
- **Do:** raise right hand sharply, hold.
- **Expect:** within ~1 s a commit `feat: raise right hand`; status second line narrates it, e.g. `live: rightWrist y↑0.38 (v↑2.4)` with arrows matching the real direction.
- **Do:** lower the hand, turn head, crouch/stand (if standing).
- **Expect:** `feat: lower right hand`, `feat: turn head`, `feat: crouch` / `feat: stand` — labels matching motion. Sitting still produces nothing (`(cooldown)` may flash; never spam).
- **Do:** drag threshold to `0.35`, wave normally.
- **Expect:** (almost) no commits. Drag to `0.10`, sway.
- **Expect:** commits fire easily. Return to `0.18`.
- **Do:** press `c` or COMMIT NOW while still.
- **Expect:** immediate commit regardless of threshold.
- **Do:** type `log`, `commit -m "test pose"`, `help`, `clear`, `bogus`.
- **Expect:** `log` re-renders; custom message recorded; `help` lists commands; `clear` wipes extra lines (commits kept); `bogus` → `unknown (try: log)`. `git` prefix works (`git log`).

## 3. Checkout / time-travel

- **Do:** with 3+ commits, `checkout <first-6-chars-of-oldest>` (copy from `log`).
- **Expect:** badge → `detached @ <hash>`, HUD `$ pose @ <hash>`, stage banner `time-travel…`, avatar tweens (~0.6 s) to the old pose in **amber**, HUD `◉ @ <hash> · frozen`, status TIME-TRAVEL, commits frozen (`c` prints the frozen hint).
- **Do:** `checkout main`.
- **Expect:** badge back to `⎇ main`, avatar snaps to live body (green), committing restarts after a brief settle.
- **Do:** `checkout abc` (unknown), `checkout <2-chars>`.
- **Expect:** `matches no commit` / `need ≥3 hash chars` errors, state unchanged.

## 4. Diff

- **Do:** with 2+ commits, `diff`.
- **Expect:** `HUMAN DIFFERENCE <a>..<b>` with `+ RIGHT_HAND moved upward (0.42)`-style lines, unchanged-joint count, plus green/amber overlay ghosts on stage with a legend line.
- **Do:** `diff <hashA> <hashB>`, `diff <one-hash>`, `diff --text`.
- **Expect:** correct pair compared; `--text` prints without touching the overlay.
- **Do:** `clear` / `checkout`.
- **Expect:** overlay wiped.

## 5. Branch

- **Do:** `branch` → `branch dance` → `branch` again.
- **Expect:** list shows `* main@<hash>`; after create, log line for the tip gains `[dance]`, plus `branched 'dance' @ <hash>` hint. Re-creating `dance` → `already exists` error. `branch 'bad name!'` → invalid-name error.
- **Do:** `checkout dance` → strike a new pose → commit → `log`.
- **Expect:** badge `⎇ dance`, new commit tagged `[dance]`; `checkout main` → `log` no longer shows it (independent histories).

## 6. Merge + conflicts

- **Setup:** on `main` commit pose A (e.g. right hand up); `checkout dance`, commit pose B (e.g. right hand down + head turned); `checkout main`.
- **Do:** `merge dance`.
- **Expect:** `HUMAN MERGE CONFLICT` listing disagreeing joints (`1. RIGHT_HAND: main UP vs dance DOWN (Δ0.95)`), auto-count, green/amber overlay, instructions line; HUD `◉ merging dance→main · N left`; commits/checkout/new merges blocked with hints; `status` shows the merge line.
- **Do:** `keep 1` then `take 2` (numbers or names: `take right_hand`).
- **Expect:** per-joint confirmations with remaining count; final resolution auto-creates `merge branch 'dance'` (two parents — verify by checking out its hash later and seeing the resolved pose), overlay cleared, live resumes.
- **Do:** `merge main` (same branch), `merge nosuch`, `merge` (bare).
- **Expect:** `already up to date`, `not found`, usage errors.
- **Do:** on a clean fork (branch, no new commits on either side) `merge <it>`.
- **Expect:** `already up to date` (ancestor case).
- **Do:** start a merge, then `merge --abort`.
- **Expect:** `aborted — no commits created`, overlay cleared, HEAD unchanged.
- **Do:** mid-merge, try `commit`, `checkout main`.
- **Expect:** blocked-with-hint messages.

## 7. Framing + robustness

- **Do:** sit close (head + shoulders only), hold still, raise hands.
- **Expect:** commits work on the visible subset; gate line reads `only N/12 joints visible` if below 6.
- **Do:** raise LEFT hand slowly.
- **Expect:** commits fire; if the arm is out of frame, status says `left arm hidden — reframe / add light on that side` instead of failing silently.
- **Do:** STOP → START.
- **Expect:** clean stop (ghost stage, `idle`), fresh start; pending merge/detach/overlay cleared.
- **Do:** reload the page.
- **Expect:** empty repo (all state is in-memory by design — note for judges).

## 8. Performance sanity

- **Do:** watch status `fps` + `detect=..ms` for 30 s while moving.
- **Expect:** render fps near display rate; detect typically single-digit ms on GPU. On a weak machine, `detect=NNms/2f` appears (adaptive stride) instead of stutter; recovery when load drops.
- **Do:** DevTools → Performance, 10 s record while tracking.
- **Expect:** no per-frame long tasks outside inference; no runaway memory (repo capped at 200 commits).

## Full 90-second demo script (the pass/fail run)

1. Stand in frame — *"main, initial human."* (commit 1)
2. Raise hand, turn, crouch — 3 commits land live in `log`.
3. `log` — full history on screen.
4. `checkout <first hash>` — avatar swings back amber. Pause.
5. `checkout main` → `branch dance` → `checkout dance` → new pose + commit.
6. `checkout main` → `merge dance` → conflict screen → `take 1` → merged commit.
7. Close: *"Nobody needed version control for their body. That's exactly why we built it."*

Pass = every step above behaves as written, with zero console errors (DevTools → Console).
