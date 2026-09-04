# human.git
## Version Control for Humans

### Comprehensive Project Report

---

## 1. Executive Summary

**human.git** is a deliberately useless computer-vision project that applies Git version control to a human body.

A webcam tracks a person's body pose in real time, entirely in the browser. Significant changes in posture or movement are converted into **commits**. Each commit is a snapshot of the person's physical state at that moment. The user then interacts with their own body as though it were a software repository — viewing history, comparing poses, branching into alternate movement sequences, and traveling backward in time to earlier physical states.

The project solves no real-world problem. Its entire purpose is to take a workflow every developer already understands — Git — and apply it faithfully, and pointlessly, to something that was never meant to be versioned: a human body.

The implementation, however, is genuine. It combines real-time pose estimation, state normalization, a custom version-control data model, 3D skeletal rendering, and interactive animation — all running client-side with no backend.

The central question the project answers:

> **What if your body had Git?**

---

## 2. The Core Idea

Git tracks changes to source code. human.git tracks changes to a person.

Normal software versioning:

```text
source code → modified source code → commit
```

human.git's pipeline:

```text
human pose → movement → new human state → commit
```

A person's physical configuration is treated as a versioned state. Each state is a set of key body landmarks — head, shoulders, elbows, wrists, hips, knees, and ankles — captured as 3D coordinates. When the body's configuration changes enough from the last recorded state, a new commit is created automatically.

---

## 3. Why It Is Useless

The uselessness is not a side effect — it's the design requirement.

A normal project starts with: *"There is a problem — how can technology solve it?"*
human.git starts with: *"There is no problem. Let's apply Git to a person anyway."*

There is no practical reason to:
- version-control someone's posture
- create branches of human movement
- diff two body positions
- revert a person's pose
- resolve a merge conflict between "standing" and "crouching"
- stash a posture for later

The project builds real, working infrastructure around something that never needed infrastructure. That mismatch — genuine engineering effort spent on a problem that doesn't exist — is the entire joke.

**Formula:** real technology + absurd application + zero practical benefit.

---

## 4. What Makes the Idea Work

A generic "useless project" does something random for a cheap laugh. human.git instead takes one complete, internally consistent system — Git — and maps every one of its core concepts onto a human body with total fidelity:

| Git concept | Human equivalent |
|---|---|
| Commit | A captured pose snapshot |
| Commit message | Auto-generated description of what moved |
| Log | Chronological history of your movements |
| Checkout | Physically reconstructing an old pose on a digital avatar |
| Diff | A joint-by-joint comparison between two poses |
| Branch | A forked sequence of alternate movements |
| Merge | Reconciling two different movement histories |
| Merge conflict | Two branches disagreeing about where a limb should be |
| Stash | Temporarily saving your current pose to restore later |

Because every mapping is faithful rather than arbitrary, the project reads as a coherent premise — *"human movement is now source code"* — rather than a pile of unrelated gags.

---

## 5. Technical Architecture

Everything runs client-side, in a single browser tab, with no server and no installed dependencies beyond libraries loaded from a CDN. This removes the biggest live-demo risk categories: server crashes, network dependency, and environment setup failures.

**Pose tracking:** MediaPipe Tasks Vision (`PoseLandmarker`), running in-browser, producing 33 3D body landmarks per frame from webcam input.

**Rendering:** Three.js, building a stylized low-poly/skeletal avatar — spheres for joints, connecting lines or cylinders for limbs. A stylized avatar is used deliberately instead of a photorealistic one: it's faster to build, makes pose changes instantly legible, and visually signals "this is a technical visualization," not a filter.

**Version control:** No real Git is invoked. Git's *semantics* are reimplemented directly in JavaScript as an in-memory data structure — commits, branches, and HEAD pointers exist as plain objects during the session. This is faster to build, has zero filesystem risk, and is just as convincing on stage as shelling out to real git would be.

**Interface:** A terminal-style command panel overlaid on the 3D canvas, styled in monospace green-on-black, accepting Git-like commands and printing Git-like output.

---

## 6. Core Data Model

```js
Commit {
  hash: string,          // short random hex, e.g. "31fa82"
  parent: hash | null,   // previous commit on this branch
  branch: string,        // "main", "dance", etc.
  message: string,       // auto-generated, e.g. "feat: raise right hand"
  timestamp: number,
  pose: {
    leftWrist: {x,y,z},  rightWrist: {x,y,z},
    leftElbow: {x,y,z},  rightElbow: {x,y,z},
    leftShoulder: {x,y,z}, rightShoulder: {x,y,z},
    hip: {x,y,z}, head: {x,y,z},
    leftKnee: {x,y,z}, rightKnee: {x,y,z},
    leftAnkle: {x,y,z}, rightAnkle: {x,y,z}
  }
}

Repo {
  commits: Map<hash, Commit>,
  branches: Map<branchName, headHash>,
  HEAD: { branch: string, detached: boolean, hash: hash | null },
  stash: Commit | null
}
```

Only around twelve landmarks are tracked (rather than the full 33 MediaPipe provides) — enough for clearly legible pose differences, without adding rendering noise or wasted precision that a live demo audience will never notice.

---

## 7. Commit Detection

The system continuously samples pose landmarks, normalizes them (scale-invariant, centered on the hips so distance from the camera doesn't matter), and smooths them frame-to-frame to remove jitter. A new commit is generated automatically whenever the smoothed pose diverges from the last committed pose by more than a tuned threshold, with a short cooldown afterward to prevent commit-spam from natural body sway.

```text
every frame:
  landmarks = poseLandmarker.detect(video)
  normalizedPose = normalize(landmarks)
  smoothedPose = lerp(previousSmoothed, normalizedPose, 0.3)
  delta = distance(smoothedPose, lastCommittedPose)

  if delta > THRESHOLD and cooldownExpired:
      generateCommit(smoothedPose)
      cooldown = 800ms
```

Commit messages are generated automatically by identifying which tracked joint moved the most since the last commit, and mapping that to a short phrase — `"feat: raise right hand"`, `"feat: rotate torso"`, `"feat: crouch"`.

A manual "force commit" trigger (button or keypress) exists alongside auto-detection, so a live demo is never solely dependent on the sensitivity of automatic motion detection.

---

## 8. Git Commands as Human Operations

### `git log`

Displays the full history of the human, most recent first:

```text
HUMAN REPOSITORY

91ca72  feat: crouch
72ac91  feat: rotate left
31fa82  feat: raise right hand
a81c2e  initial human
```

### `git checkout <hash>`

The centerpiece feature. The avatar animates from its current pose to the stored pose of the named commit, effectively traveling backward through its own physical history. Checking out a specific commit (rather than a branch) puts the system into a "detached HEAD" state, surfaced in the UI as a small status message.

### `git diff`

Compares two commits joint-by-joint and reports what changed:

```text
HUMAN DIFFERENCE

+ RIGHT_HAND moved upward
+ HEAD rotated 12°
+ TORSO shifted left
- LEFT_HAND lowered
```

Optionally, the two poses can be rendered as overlaid ghost skeletons for a visual diff alongside the text.

### `git branch <name>`

Forks a new branch from the current HEAD. Subsequent commits are recorded onto the new branch while the original branch's history remains untouched — allowing the user to build an alternate sequence of movements (e.g. a `dance` branch) independently of `main`.

### `git merge <branch>`

Compares the HEAD poses of two branches joint-by-joint. Joints within a small tolerance of each other merge automatically. Joints that diverge beyond tolerance produce a **merge conflict**:

```text
HUMAN MERGE CONFLICT

right_hand:
    main  → DOWN
    dance → UP

Automatic human merge failed.
Please resolve manually.
```

The conflict is resolved visually rather than only in text — both conflicting skeletons are shown side by side with `[KEEP CURRENT]` and `[TAKE INCOMING]` options, resolving the joint's final position on selection.

### `git stash` / `git stash pop`

Temporarily saves the current pose without committing it, then restores it later on request. Included only once the core commands above are fully stable — it adds charm but isn't load-bearing for the demo.

---

## 9. User Experience Flow

1. The user stands in front of the webcam. The system displays an initial commit: `a81c2e — "initial human"` on branch `main`.
2. As the user moves — raising a hand, turning, crouching — each significant change is automatically committed and appears live in the on-screen log.
3. `git log` shows the full history of the user's physical existence during the session.
4. `git checkout <hash>` sends the avatar backward to an earlier pose, visibly and immediately.
5. `git branch dance` lets the user build a separate movement sequence without disturbing `main`.
6. `git merge dance` attempts to reconcile the two histories, surfacing a merge conflict when the branches physically disagree, resolved interactively.

---

## 10. Demo Script

The full demo is designed to run in under 90 seconds:

1. Stand in frame — *"This is `main`, commit `a81c2e`, initial human."*
2. Raise a hand — a new commit appears live in the log.
3. Turn, then crouch — two more commits appear.
4. `git log` — show the complete history on screen.
5. `git checkout <first hash>` — the avatar animates back to the initial pose. Pause here; this is the strongest single moment in the demo.
6. `git branch dance`, strike a different pose, commit.
7. `git checkout main`, then `git merge dance` — a conflict screen appears.
8. Select `TAKE INCOMING` — the conflict resolves and the avatar snaps into the merged pose.
9. Close with: *"Nobody needed version control for their body. That's exactly why we built it."*

---

## 11. Development Plan (18 Hours)

**Hours 0–2 — Core pipeline**
Webcam input → MediaPipe pose detection → raw landmarks rendered as a live Three.js stick-figure skeleton, with no Git logic yet.

**Hours 2–5 — Commits**
Implement pose normalization, smoothing, delta detection, and automatic commit generation. Build the `git log` command.

**Hours 5–8 — Checkout**
Implement `git checkout <hash>`, animating the avatar from its current pose to a stored historical pose. Add a detached-HEAD indicator. At this point the project is already fully demoable end-to-end.

**Hours 8–11 — Diff and branching**
Implement `git diff` (text and optional skeleton-overlay comparison) and `git branch <name>` with independent commit histories per branch.

**Hours 11–14 — Merge and conflicts**
Implement `git merge <branch>` with per-joint tolerance checking, and a visual conflict-resolution UI for joints that disagree between branches.

**Hours 14–16 — Polish**
Terminal styling, a Git-graph-style visualization of branch history, and `git stash` / `stash pop` if time allows.

**Hours 16–18 — Demo lockdown**
No new features. Fix any bug that could break the live demo, rehearse the exact command sequence multiple times, and prepare lighting and camera framing that gives MediaPipe clean, consistent tracking.

---

## 12. Risk Management

The single greatest risk to this project is the pose-detection threshold — the number that decides what counts as a "significant enough" movement to warrant a commit. This should be tuned by hand well before the event, using the actual demo lighting and camera setup wherever possible.

A layered fallback plan protects the demo regardless of what goes wrong on the night:

- If live pose tracking becomes unreliable under stage lighting, a pre-recorded clean webcam clip can be substituted as input.
- If `merge` is incomplete by hour 15, it is cut entirely and the demo ends on `checkout` — still a complete and impressive story on its own.
- If the visual diff overlay breaks, the system falls back to text-only diff output.
- `commit → log → checkout` is treated as non-negotiable. Every other feature can be sacrificed before this loop is touched.

---

## 13. Final Assessment

| Category | Rating |
|---|---|
| Uselessness | 10/10 — no legitimate real-world use case exists or is intended |
| Technical depth | 9/10 — computer vision, state modeling, custom versioning logic, 3D rendering, and interaction design |
| Demo potential | 10/10 — checkout and merge conflicts are inherently visual, immediate, and require no narration |
| Feasibility in 18 hours | 9/10 — a complete, demoable version exists after hour 8, with clear optional layers beyond that |
| Developer appeal | 10/10 — the entire premise is built from concepts developers already understand deeply |

---

## 14. One-Sentence Pitch

> **human.git is a computer-vision system that puts your body under Git version control, letting you commit, branch, diff, merge, and check out previous versions of yourself.**

---

## 15. Short Pitch

> We thought Git wasn't being used enough, so we gave it a human. human.git tracks your body through a webcam and turns your movements into commits. Raise your hand, make a commit. Turn around, make another. Then check out an earlier commit and your digital self goes back in time. Create branches, merge them, and eventually run into the most important software problem nobody needed: a human merge conflict.

---

## 16. Definition of Success

The project succeeds if a judge watches the demo and thinks, in immediate succession:

> *"That is completely unnecessary."*
> *"But how did they actually build that?"*

That combination — instant absurdity followed by real technical curiosity — is the project's intended outcome.
