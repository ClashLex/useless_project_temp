// 1€ filter (Casiez, Roussel, Vogel — CHI'12): speed-adaptive low-pass.
// Slow motion → low cutoff (kills hold-still jitter that caused phantom
// commits); fast motion → high cutoff (tracks raises with minimal lag, so the
// direction recorded at commit time matches the real movement).
// Worst case with bad params it degrades to a plain low-pass — it can't diverge.

const TAU = Math.PI * 2;

function alpha(cutoff, freq) {
  const te = 1 / Math.max(freq, 1e-3);
  const tau = 1 / (TAU * Math.max(cutoff, 1e-3));
  return 1 / (1 + tau / te);
}

class LowPass {
  constructor() { this.hat = null; }
  filter(x, a) {
    if (this.hat === null) { this.hat = x; return x; }
    const y = a * x + (1 - a) * this.hat;
    this.hat = y;
    return y;
  }
  reset() { this.hat = null; }
}

export class OneEuroFilter {
  constructor(freq = 30, mincutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
    this.freq = freq;
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
    this.xF = new LowPass();
    this.dxF = new LowPass();
    this.lastX = null;
    this.lastT = null;
  }
  // t in seconds. Returns { value, derivative } — derivative is units/sec
  // of the *raw* signal, i.e. the freshest direction estimate we have.
  filter(x, t = null) {
    let freq = this.freq;
    if (t !== null && this.lastT !== null && t > this.lastT) {
      freq = 1 / (t - this.lastT);
      freq = Math.min(Math.max(freq, 1), 120);
    }
    const dx = this.lastX === null ? 0 : (x - this.lastX) * freq;
    const edx = this.dxF.filter(dx, alpha(this.dcutoff, freq));
    const cutoff = this.mincutoff + this.beta * Math.abs(edx);
    const y = this.xF.filter(x, alpha(cutoff, freq));
    this.lastX = x;
    if (t !== null) this.lastT = t;
    return { value: y, derivative: edx };
  }
  reset() {
    this.xF.reset();
    this.dxF.reset();
    this.lastX = null;
    this.lastT = null;
  }
}

// One Euro per joint axis over a COMMIT_JOINTS-style pose object.
// filterPose returns { pose, vel }: smoothed pose + per-joint velocity vectors.
export class EuroPose {
  constructor({ joints = [], freq = 30, mincutoff = 1.1, beta = 0.4, dcutoff = 1.0 } = {}) {
    this.joints = joints;
    this.params = { freq, mincutoff, beta, dcutoff };
    this.reset();
  }
  reset() {
    const { freq, mincutoff, beta, dcutoff } = this.params;
    this.f = {};
    for (const j of this.joints) {
      this.f[j] = {
        x: new OneEuroFilter(freq, mincutoff, beta, dcutoff),
        y: new OneEuroFilter(freq, mincutoff, beta, dcutoff),
        z: new OneEuroFilter(freq, mincutoff, beta, dcutoff),
      };
    }
  }
  filterPose(pose, t) {
    const out = {};
    const vel = {};
    for (const j of this.joints) {
      if (!pose[j] || !this.f[j]) continue;
      const rx = this.f[j].x.filter(pose[j].x, t);
      const ry = this.f[j].y.filter(pose[j].y, t);
      const rz = this.f[j].z.filter(pose[j].z, t);
      out[j] = { x: rx.value, y: ry.value, z: rz.value };
      vel[j] = { x: rx.derivative, y: ry.derivative, z: rz.derivative };
    }
    return { pose: out, vel };
  }
}
