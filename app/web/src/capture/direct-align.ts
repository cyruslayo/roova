// Direct (intensity-based) pre-alignment for low-texture rooms.
//
// VFTCam's computeImageAlignment matches Shi-Tomasi corners. Indoor rooms with
// smooth white walls and ceilings give it too few corners, so it returns no
// correction and the stitch blends frames on raw sensor poses (1-3 degrees off),
// which doubles edges and smears dark objects across walls. This module is a
// product addition, not VFTCam code: before the VFTCam render runs, it measures
// each overlapping pair's small relative rotation from the images themselves by
// correlating high-passed copies over the whole overlap (every edge, line and
// gradient counts, not only corners), then solves all frames together with a
// pull toward the sensor poses. It only adjusts layers' yaw/pitch/roll; VFTCam's
// own alignment, warps, exposure and seams then run unchanged from these poses.
//
// Rotation conventions (cam = Rroll*Rpitch*Ryaw*world, image x right, y down,
// world y down) and the pose decomposition are the ones in VFTCam's
// computeImageAlignment (vftcam/stitcher.js), so corrected poses mean what the
// stitch shader expects. Everything is deterministic.

export type DirectAlignLayer = { hotspotId: number; yaw: number; pitch: number; roll: number; canvas: HTMLCanvasElement };
export type DirectAlignReport = {
  applied: boolean; reason?: string; pairsTried: number; pairsMeasured: number; pairsKept: number;
  nccBefore: number; nccAfter: number; meanCorrection: number; maxCorrection: number; ms: number;
  // Per measured pair, for diagnostics: hotspot IDs, score at the sensor poses and at the fit, fit in frame i's axes (degrees).
  pairs?: { a: number; b: number; ncc0: number; ncc: number; fit: number[]; samples: number }[];
};
type Mat = number[][];
type Vec = [number, number, number];

const D = Math.PI / 180;
const mul = (A: Mat, B: Mat): Mat => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const transpose = (A: Mat): Mat => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
export const camMatrix = (y: number, p: number, r: number): Mat => {
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  return mul([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]], mul([[1, 0, 0], [0, cp, sp], [0, -sp, cp]], [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]));
};
export const expRot = (w: number[]): Mat => {
  const t = Math.hypot(w[0], w[1], w[2]);
  if (t < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const k = w.map(v => v / t), c = Math.cos(t), s = Math.sin(t), v = 1 - c;
  return [[c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
    [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
    [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v]];
};
export const decompose = (M: Mat): Vec => {
  const r2 = M[2], pitch = Math.asin(Math.max(-1, Math.min(1, -r2[1]))), yaw = Math.atan2(-r2[0], r2[2]);
  const PY = mul(camMatrix(0, pitch, 0), camMatrix(yaw, 0, 0));
  const Rr = mul(M, transpose(PY));
  return [yaw, pitch, Math.atan2(Rr[1][0], Rr[0][0])];
};
const applyT = (M: Mat, d: number[]): Vec => [M[0][0] * d[0] + M[1][0] * d[1] + M[2][0] * d[2], M[0][1] * d[0] + M[1][1] * d[1] + M[2][1] * d[2], M[0][2] * d[0] + M[1][2] * d[1] + M[2][2] * d[2]];

// One pyramid level of one frame: high-passed grey (grey minus a box blur), which
// removes exposure differences, vignetting and broad glare, and its gradient size.
type Level = { W: number; H: number; hp: Float32Array; grad: Float32Array };

function grayAt(canvas: HTMLCanvasElement, W: number, H: number): Float32Array {
  // Two-step downscale so the small copy is not aliased.
  const mid = document.createElement('canvas'); mid.width = W * 2; mid.height = H * 2;
  const mctx = mid.getContext('2d')!; mctx.imageSmoothingQuality = 'high'; mctx.drawImage(canvas, 0, 0, W * 2, H * 2);
  const small = document.createElement('canvas'); small.width = W; small.height = H;
  const sctx = small.getContext('2d', { willReadFrequently: true })!; sctx.imageSmoothingQuality = 'high'; sctx.drawImage(mid, 0, 0, W, H);
  const data = sctx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) g[p] = 0.299 * data[4 * p] + 0.587 * data[4 * p + 1] + 0.114 * data[4 * p + 2];
  mid.width = mid.height = small.width = small.height = 1;
  return g;
}

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += src[y * W + xx]; n++; } }
    tmp[y * W + x] = s / n;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
    out[y * W + x] = s / n;
  }
  return out;
}

function makeLevel(g: Float32Array, W: number, H: number, r: number): Level {
  const blur = boxBlur(g, W, H, r), hp = new Float32Array(W * H), grad = new Float32Array(W * H);
  // Mild pre-smoothing of the high-pass keeps JPEG and sensor noise out of the score.
  const smooth = boxBlur(g, W, H, 1);
  for (let p = 0; p < W * H; p++) hp[p] = smooth[p] - blur[p];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    grad[p] = Math.hypot(smooth[p + 1] - smooth[p - 1], smooth[p + W] - smooth[p - W]);
  }
  return { W, H, hp, grad };
}

const bilinear = (img: Float32Array, W: number, x: number, y: number) => {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, p = y0 * W + x0;
  return (img[p] * (1 - fx) + img[p + 1] * fx) * (1 - fy) + (img[p + W] * (1 - fx) + img[p + W + 1] * fx) * fy;
};

type Samples = { dirs: Float64Array; vals: Float32Array; weight: Float32Array; count: number };

export function directAlign(layers: DirectAlignLayer[], fov: { horizontal: number; vertical: number }): DirectAlignReport {
  const t0 = performance.now();
  const n = layers.length, tanH = Math.tan(fov.horizontal * D / 2), tanV = Math.tan(fov.vertical * D / 2);
  const aspect = layers[0].canvas.height / layers[0].canvas.width;
  const W0 = 180, H0 = Math.round(W0 * aspect), W1 = 90, H1 = Math.round(W1 * aspect);
  const report: DirectAlignReport = { applied: false, pairsTried: 0, pairsMeasured: 0, pairsKept: 0, nccBefore: 0, nccAfter: 0, meanCorrection: 0, maxCorrection: 0, ms: 0, pairs: [] };
  const finish = (reason?: string) => { report.reason = reason; report.ms = Math.round(performance.now() - t0); return report; };
  if (n < 3) return finish('too few frames');

  const mats = layers.map(l => camMatrix(l.yaw * D, l.pitch * D, (l.roll || 0) * D));
  const level0: Level[] = [], level1: Level[] = [];
  for (const layer of layers) {
    const g0 = grayAt(layer.canvas, W0, H0), g1 = grayAt(layer.canvas, W1, H1);
    level0.push(makeLevel(g0, W0, H0, 4)); level1.push(makeLevel(g1, W1, H1, 2));
  }
  const pixelDir = (M: Mat, x: number, y: number, W: number, H: number): Vec => {
    const d = applyT(M, [((x + 0.5) / W - 0.5) * 2 * tanH, ((y + 0.5) / H - 0.5) * 2 * tanV, 1]);
    const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l];
  };

  // Strong-gradient sample points of frame i (spread over a grid so one bright
  // lamp or a single edge cannot take all of them).
  const sampleCache = new Map<string, Samples>();
  const samplesFor = (i: number, L: Level, budget: number): Samples => {
    const key = `${i}:${L.W}:${budget}`, hit = sampleCache.get(key);
    if (hit) return hit;
    const made = buildSamples(i, L, budget); sampleCache.set(key, made); return made;
  };
  const buildSamples = (i: number, L: Level, budget: number): Samples => {
    const { W, H, grad, hp } = L, cells = 8, cellsY = Math.round(cells * aspect), perCell = Math.ceil(budget / (cells * cellsY));
    const picked: number[] = [];
    for (let cy = 0; cy < cellsY; cy++) for (let cx = 0; cx < cells; cx++) {
      const x0 = Math.max(2, Math.floor(cx * W / cells)), x1 = Math.min(W - 2, Math.floor((cx + 1) * W / cells));
      const y0 = Math.max(2, Math.floor(cy * H / cellsY)), y1 = Math.min(H - 2, Math.floor((cy + 1) * H / cellsY));
      const cand: [number, number][] = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cand.push([grad[y * W + x], y * W + x]);
      cand.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      for (const [gv, p] of cand.slice(0, perCell)) if (gv > 1.5) picked.push(p);
    }
    const dirs = new Float64Array(picked.length * 3), vals = new Float32Array(picked.length), weight = new Float32Array(picked.length);
    picked.forEach((p, k) => {
      const d = pixelDir(mats[i], p % W, Math.floor(p / W), W, H);
      dirs[3 * k] = d[0]; dirs[3 * k + 1] = d[1]; dirs[3 * k + 2] = d[2];
      vals[k] = hp[p];
      // Ground below the horizon (world y down) is close and shows parallax: it counts less.
      weight[k] = d[1] > Math.sin(3 * D) ? 0.35 : 1;
    });
    return { dirs, vals, weight, count: picked.length };
  };

  // Weighted NCC between frame i's samples and frame j's high-pass, with frame j
  // seen through the candidate relative rotation w (world frame): d_i = exp(w) d_j.
  const score = (S: Samples, Lj: Level, Mj: Mat, w: number[], minValid: number) => {
    const A = mul(Mj, expRot([-w[0], -w[1], -w[2]])), { W, H, hp } = Lj;
    let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, valid = 0;
    for (let k = 0; k < S.count; k++) {
      const dx = S.dirs[3 * k], dy = S.dirs[3 * k + 1], dz = S.dirs[3 * k + 2];
      const cz = A[2][0] * dx + A[2][1] * dy + A[2][2] * dz;
      if (cz <= 0) continue;
      const xn = (A[0][0] * dx + A[0][1] * dy + A[0][2] * dz) / cz, yn = (A[1][0] * dx + A[1][1] * dy + A[1][2] * dz) / cz;
      const x = (xn / (2 * tanH) + 0.5) * W - 0.5, y = (yn / (2 * tanV) + 0.5) * H - 0.5;
      if (x < 2 || y < 2 || x > W - 3 || y > H - 3) continue;
      const a = S.vals[k], b = bilinear(hp, W, x, y), q = S.weight[k];
      sw += q; sa += q * a; sb += q * b; saa += q * a * a; sbb += q * b * b; sab += q * a * b; valid++;
    }
    if (valid < minValid || sw <= 0) return { ncc: -1, valid };
    const va = saa - sa * sa / sw, vb = sbb - sb * sb / sw;
    if (va <= 1e-6 || vb <= 1e-6) return { ncc: -1, valid };
    return { ncc: (sab - sa * sb / sw) / Math.sqrt(va * vb), valid };
  };

  // Camera-axis rotation in frame i -> world rotation vector.
  const toWorld = (i: number, c: number[]) => applyT(mats[i], c);
  const maxSep = 2 * Math.atan(Math.max(tanH, tanV)) * 0.9;
  const angle = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  type Edge = { i: number; j: number; w: Vec; H: Mat; ncc0: number; ncc: number };
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (angle(mats[i][2], mats[j][2]) > maxSep) continue;
    report.pairsTried++;
    const S1 = samplesFor(i, level1[i], 360), S0 = samplesFor(i, level0[i], 1400);
    // The overlap must hold enough textured samples to say anything; a sliver of
    // overlap can correlate highly by chance.
    const base0 = score(S0, level0[j], mats[j], [0, 0, 0], 1), base1 = score(S1, level1[j], mats[j], [0, 0, 0], 1);
    if (base0.valid < 150 || base1.valid < 40) continue;
    const minValid0 = Math.max(120, base0.valid * 0.6), minValid1 = Math.max(30, base1.valid * 0.6);
    // Coarse: +-6 degrees in steps of 0.75 about frame i's x/y axes, roll -3/0/+3.
    const grid: { c: number[]; ncc: number }[] = [];
    for (const rz of [-3, 0, 3]) for (let ry = -8; ry <= 8; ry++) for (let rx = -8; rx <= 8; rx++) {
      const c = [rx * 0.75 * D, ry * 0.75 * D, rz * D];
      grid.push({ c, ncc: score(S1, level1[j], mats[j], toWorld(i, c), minValid1).ncc });
    }
    // Several coarse peaks go on to the fine search; the coarse level alone can prefer a wrong one.
    const order = grid.map((_g, k) => k).sort((a, b) => grid[b].ncc - grid[a].ncc || a - b);
    const seeds: { c: number[]; ncc: number }[] = [];
    for (const k of order) {
      if (seeds.length >= 3 || grid[k].ncc < 0.15) break;
      if (seeds.every(q => Math.hypot(q.c[0] - grid[k].c[0], q.c[1] - grid[k].c[1], (q.c[2] - grid[k].c[2]) / 2) > 1.6 * D)) seeds.push(grid[k]);
    }
    // The sensor pose itself is always a candidate.
    if (seeds.length) seeds.push({ c: [0, 0, 0], ncc: 0 });
    if (!seeds.length) { report.pairs!.push({ a: layers[i].hotspotId, b: layers[j].hotspotId, ncc0: base1.ncc, ncc: grid[order[0]].ncc, fit: grid[order[0]].c.map(v => +(v / D).toFixed(2)), samples: -base0.valid }); continue; }
    // Fine: pattern search on the full-size level from each seed, halving the step.
    const f = (c: number[]) => score(S0, level0[j], mats[j], toWorld(i, c), minValid0).ncc;
    // Between peaks of similar height, the one nearer the sensor pose wins
    // (repetitive mouldings and long edges give several almost equal peaks).
    const penalty = (v: number[]) => 0.004 * (v[0] * v[0] + v[1] * v[1] + 0.25 * v[2] * v[2]) / (D * D);
    let c = seeds[0].c.slice(), cur = -2, curPenalized = -Infinity;
    for (const seed of seeds) {
      let sc = seed.c.slice(), sv = f(sc);
      for (let step = 0.4 * D; step >= 0.05 * D; step /= 2) {
        let moved = true;
        for (let guard = 0; moved && guard < 20; guard++) {
          moved = false;
          for (let a = 0; a < 3; a++) for (const sgn of [-1, 1]) {
            const t = sc.slice(); t[a] += sgn * step * (a === 2 ? 2 : 1);
            const v = f(t); if (v > sv + 1e-6) { sv = v; sc = t; moved = true; }
          }
        }
      }
      if (sv - penalty(sc) > curPenalized) { curPenalized = sv - penalty(sc); cur = sv; c = sc; }
    }
    const ncc0 = score(S0, level0[j], mats[j], [0, 0, 0], minValid0).ncc;
    report.pairs!.push({ a: layers[i].hotspotId, b: layers[j].hotspotId, ncc0, ncc: cur, fit: c.map(v => +(v / D).toFixed(2)), samples: base0.valid });
    if (cur < 0.4 || Math.hypot(c[0], c[1], c[2]) > 7 * D) continue;
    // Curvature of the score at the peak (per rad^2, in frame i's axes): how
    // strongly each direction is pinned. A lone vertical edge pins one axis only.
    const h = 0.3 * D, Hc: Mat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const e = (a: number) => [0, 1, 2].map(k => (k === a ? h : 0));
    const at = (dv: number[]) => f(c.map((v, k) => v + dv[k]));
    for (let a = 0; a < 3; a++) {
      const fp = at(e(a)), fm = at(e(a).map(v => -v));
      Hc[a][a] = Math.max(0, (2 * cur - fp - fm) / (h * h));
    }
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const pp = at(e(a).map((v, k) => v + e(b)[k])), mm = at(e(a).map((v, k) => -v - e(b)[k]));
      const pm = at(e(a).map((v, k) => v - e(b)[k])), mp = at(e(a).map((v, k) => -v + e(b)[k]));
      const hab = -(pp + mm - pm - mp) / (4 * h * h);
      const lim = 0.9 * Math.sqrt(Hc[a][a] * Hc[b][b]);
      Hc[a][b] = Hc[b][a] = Math.max(-lim, Math.min(lim, hab));
    }
    // A peak far from a sharper part of the coarse surface is not trusted.
    let second = -2;
    let coarseHere = -2;
    for (const g of grid) {
      const far = Math.hypot(g.c[0] - c[0], g.c[1] - c[1]) > 2.2 * D;
      if (far) second = Math.max(second, g.ncc); else coarseHere = Math.max(coarseHere, g.ncc);
    }
    const distinct = coarseHere - second;
    if (distinct < 0.02) {
      // Ambiguous along some direction: keep the curvature, which then mostly pins
      // the other directions; the prior holds the ambiguous one.
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) Hc[a][b] *= 0.3;
    }
    report.pairsMeasured++;
    const Mi = mats[i], Hw = mul(transpose(Mi), mul(Hc, Mi));
    // Confidence grows with the overlap's support and the peak's height.
    const conf = Math.min(1, Math.sqrt(base0.valid / 500)) * Math.max(0, cur);
    edges.push({ i, j, w: toWorld(i, c), H: Hw.map(r => r.map(v => v * conf)), ncc0, ncc: cur });
  }
  if (edges.length < 3) return finish(`only ${edges.length} pairs could be measured`);

  // Joint solve: per-frame world rotation x with (x_j - x_i - w_ij)^T H_ij (...) for
  // every pair, a weak pull toward the sensor pose, and a weaker pull between
  // neighbouring frames so a blank frame follows its neighbours.
  const trace = (M: Mat) => M[0][0] + M[1][1] + M[2][2];
  const medianTrace = edges.map(e => trace(e.H)).sort((a, b) => a - b)[edges.length >> 1] / 3;
  const neighbours: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (angle(mats[i][2], mats[j][2]) < 50 * D) neighbours.push([i, j]);
  const solve = (use: Edge[]) => {
    const N = 3 * n, A = Array.from({ length: N }, () => new Float64Array(N)), b = new Float64Array(N);
    const lambda = 0.03 * medianTrace, smooth = 0.01 * medianTrace;
    for (let k = 0; k < N; k++) A[k][k] += lambda;
    for (const [i, j] of neighbours) for (let c = 0; c < 3; c++) {
      A[3 * j + c][3 * j + c] += smooth; A[3 * i + c][3 * i + c] += smooth; A[3 * j + c][3 * i + c] -= smooth; A[3 * i + c][3 * j + c] -= smooth;
    }
    for (const e of use) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const v = e.H[r][c];
      A[3 * e.j + r][3 * e.j + c] += v; A[3 * e.i + r][3 * e.i + c] += v; A[3 * e.j + r][3 * e.i + c] -= v; A[3 * e.i + r][3 * e.j + c] -= v;
      b[3 * e.j + r] += v * e.w[c]; b[3 * e.i + r] -= v * e.w[c];
    }
    // Gaussian elimination with partial pivoting.
    for (let c = 0; c < N; c++) {
      let piv = c;
      for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = c + 1; r < N; r++) {
        const m = A[r][c] / A[c][c]; if (!m) continue;
        for (let q = c; q < N; q++) A[r][q] -= m * A[c][q];
        b[r] -= m * b[c];
      }
    }
    const x = new Float64Array(N);
    for (let r = N - 1; r >= 0; r--) { let s = b[r]; for (let q = r + 1; q < N; q++) s -= A[r][q] * x[q]; x[r] = s / A[r][r]; }
    return x;
  };
  const misfit = (x: Float64Array, e: Edge) => Math.hypot(...[0, 1, 2].map(c => x[3 * e.j + c] - x[3 * e.i + c] - e.w[c]));
  let kept = edges, x = solve(kept);
  for (let round = 0; round < 3; round++) {
    const sorted = kept.map(e => misfit(x, e)).sort((a, b) => a - b);
    const cut = Math.max(0.5 * D, 3 * sorted[sorted.length >> 1]);
    const next = kept.filter(e => misfit(x, e) < cut);
    if (next.length === kept.length || next.length < 3) break;
    kept = next; x = solve(kept);
  }

  // Score before and after on the measured pairs (full-size level), then apply.
  const corrected = mats.map((M, k) => {
    let w = [x[3 * k], x[3 * k + 1], x[3 * k + 2]];
    const mag = Math.hypot(w[0], w[1], w[2]);
    if (mag > 5 * D) w = w.map(v => v * 5 * D / mag);
    report.maxCorrection = Math.max(report.maxCorrection, Math.min(mag, 5 * D) / D);
    report.meanCorrection += Math.min(mag, 5 * D) / D / n;
    return mul(M, expRot(w.map(v => -v)));
  });
  let before = 0, after = 0, counted = 0;
  for (const e of kept) {
    const S0 = samplesFor(e.i, level0[e.i], 1400);
    const b0 = score(S0, level0[e.j], mats[e.j], [0, 0, 0], 40).ncc;
    // Relative rotation now implied between the corrected frames.
    const rel = [0, 1, 2].map(c => x[3 * e.j + c] - x[3 * e.i + c]);
    const a0 = score(S0, level0[e.j], mats[e.j], rel, 40).ncc;
    if (b0 > -1 && a0 > -1) { before += b0; after += a0; counted++; }
  }
  report.pairsKept = kept.length;
  report.nccBefore = counted ? before / counted : 0;
  report.nccAfter = counted ? after / counted : 0;
  // Apply only a clearly consistent solution. Low agreement after the solve, or many
  // frames pushed to the correction cap, means the pairs disagree (often a wrong
  // camera field of view); then the sensor poses are safer.
  const capped = mats.filter((_, k) => Math.hypot(x[3 * k], x[3 * k + 1], x[3 * k + 2]) >= 5 * D).length;
  if (report.nccAfter < 0.35 || report.nccAfter <= report.nccBefore + 0.1 || capped > n / 4)
    return finish(`not consistent enough to apply (overlap agreement ${report.nccBefore.toFixed(3)} -> ${report.nccAfter.toFixed(3)}, ${capped} frames at the 5 deg cap); sensor poses kept`);
  corrected.forEach((M, k) => { const [y, p, r] = decompose(M); layers[k].yaw = y / D; layers[k].pitch = p / D; layers[k].roll = r / D; });
  report.applied = true;
  return finish();
}
