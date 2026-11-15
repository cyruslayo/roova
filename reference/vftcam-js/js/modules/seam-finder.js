/**
 * Seam routing for the WebGL stitcher.
 *
 * Nearest-center (Voronoi) seams cut straight through curbs and roof edges
 * where overlapping frames disagree (parallax, residual misalignment). This
 * builds a low-resolution owner map instead: frames are added one at a time,
 * and in each overlap a minimum graph cut places the boundary where the
 * current mosaic and the new frame agree best (the same idea as OpenCV's
 * graph-cut seam finder used by the iOS app).
 */

/** Dinic max-flow on a small graph. Returns a Uint8Array: 1 = source side. */
export function minCut(nodeCount, edges, sourceCap, sinkCap) {
    // Nodes 0..n-1, source = n, sink = n+1. edges: flat [a, b, cap, ...] (undirected).
    const n = nodeCount + 2, S = nodeCount, T = nodeCount + 1;
    const m = (edges.length / 3) * 2 + nodeCount * 4;
    const to = new Int32Array(m), cap = new Float64Array(m), next = new Int32Array(m), head = new Int32Array(n).fill(-1);
    let e = 0;
    const add = (a, b, c1, c2) => {
        to[e] = b; cap[e] = c1; next[e] = head[a]; head[a] = e++;
        to[e] = a; cap[e] = c2; next[e] = head[b]; head[b] = e++;
    };
    for (let i = 0; i < edges.length; i += 3) add(edges[i], edges[i + 1], edges[i + 2], edges[i + 2]);
    for (let v = 0; v < nodeCount; v++) {
        if (sourceCap[v] > 0) add(S, v, sourceCap[v], 0);
        if (sinkCap[v] > 0) add(v, T, sinkCap[v], 0);
    }
    const level = new Int32Array(n), it = new Int32Array(n), queue = new Int32Array(n);
    const bfs = () => {
        level.fill(-1); level[S] = 0;
        let qh = 0, qt = 0; queue[qt++] = S;
        while (qh < qt) {
            const v = queue[qh++];
            for (let k = head[v]; k !== -1; k = next[k]) if (cap[k] > 1e-12 && level[to[k]] < 0) {
                level[to[k]] = level[v] + 1; queue[qt++] = to[k];
            }
        }
        return level[T] >= 0;
    };
    // Iterative DFS for blocking flow.
    const stackV = new Int32Array(n), stackE = new Int32Array(n);
    const dfs = () => {
        let pushed = 0;
        for (;;) {
            let top = 0; stackV[0] = S;
            let found = false;
            while (top >= 0) {
                const v = stackV[top];
                if (v === T) { found = true; break; }
                let advanced = false;
                for (; it[v] !== -1; it[v] = next[it[v]]) {
                    const k = it[v], w = to[k];
                    if (cap[k] > 1e-12 && level[w] === level[v] + 1) {
                        stackE[top] = k; stackV[++top] = w; advanced = true; break;
                    }
                }
                if (!advanced) { level[v] = -1; top--; if (top >= 0) it[stackV[top]] = next[it[stackV[top]]]; }
            }
            if (!found) return pushed;
            let f = Infinity;
            for (let i = 0; i < top; i++) f = Math.min(f, cap[stackE[i]]);
            for (let i = 0; i < top; i++) { cap[stackE[i]] -= f; cap[stackE[i] ^ 1] += f; }
            pushed += f;
        }
    };
    while (bfs()) { for (let v = 0; v < n; v++) it[v] = head[v]; dfs(); }
    // Source side = reachable from S in the residual graph.
    const side = new Uint8Array(nodeCount), seen = new Uint8Array(n);
    let qh = 0, qt = 0; queue[qt++] = S; seen[S] = 1;
    while (qh < qt) {
        const v = queue[qh++];
        for (let k = head[v]; k !== -1; k = next[k]) if (cap[k] > 1e-12 && !seen[to[k]]) { seen[to[k]] = 1; queue[qt++] = to[k]; }
    }
    for (let v = 0; v < nodeCount; v++) side[v] = seen[v];
    return side;
}

/**
 * Owner map on a W x H equirectangular grid (GL row order: row 0 = v_uv.y 0),
 * using the stitch shader's projection. frames: [{ yaw, pitch, roll } in
 * degrees], canvases: frame images, gains: per-frame linear gains.
 * Returns { width, height, owner, masks }: owner is the frame index per grid
 * pixel (-1 = none) and masks holds one 0..255 blend share per frame and grid
 * pixel (frame-major), 255 inside the region a frame owns and falling off over
 * `radius` pixels where there is detail, up to `wide` pixels in smooth regions.
 */
// Exact box-average downsample of a frame canvas to w x h (integer factors),
// cached on the canvas. drawImage scaling differs between browsers (Safari
// and Chrome filter differently), and the alignment, gains and seams must
// see the same pixels on every device so a phone stitch matches the desktop
// repro. Falls back to drawImage when the factors are not integers.
const BOX_SIZES = [[180, 320], [90, 160], [72, 128]];  // alignment, seams, gains: one full-res read serves all three
export function boxDown(canvas, w, h) {
    const key = `${w}x${h}`;
    canvas._boxDown = canvas._boxDown || new Map();
    if (canvas._boxDown.has(key)) return canvas._boxDown.get(key);
    const cw = canvas.width, ch = canvas.height, hw = cw >> 1, hh = ch >> 1;
    const wanted = BOX_SIZES.some(([bw, bh]) => bw === w && bh === h) ? BOX_SIZES : [[w, h]];
    let half = null;  // 2x2 sums of the full read; every size divides it
    for (const [bw, bh] of wanted) {
        if (canvas._boxDown.has(`${bw}x${bh}`)) continue;
        const fx = hw / bw, fy = hh / bh, out = new Uint8ClampedArray(bw * bh * 4);
        if (cw % 2 === 0 && ch % 2 === 0 && Number.isInteger(fx) && Number.isInteger(fy)) {
            if (!half) {
                const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
                half = new Uint32Array(hw * hh * 3);
                for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
                    const p = (2 * y * cw + 2 * x) * 4, q = p + cw * 4, o = (y * hw + x) * 3;
                    half[o] = src[p] + src[p + 4] + src[q] + src[q + 4];
                    half[o + 1] = src[p + 1] + src[p + 5] + src[q + 1] + src[q + 5];
                    half[o + 2] = src[p + 2] + src[p + 6] + src[q + 2] + src[q + 6];
                }
            }
            const area = 4 * fx * fy;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                let r = 0, g = 0, b = 0;
                for (let yy = y * fy; yy < (y + 1) * fy; yy++) {
                    let p = (yy * hw + x * fx) * 3;
                    for (let xx = 0; xx < fx; xx++, p += 3) { r += half[p]; g += half[p + 1]; b += half[p + 2]; }
                }
                const o = (y * bw + x) * 4;
                out[o] = r / area + 0.5; out[o + 1] = g / area + 0.5; out[o + 2] = b / area + 0.5; out[o + 3] = 255;
            }
        } else {
            const c = document.createElement('canvas');
            c.width = bw; c.height = bh;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(canvas, 0, 0, bw, bh);
            out.set(ctx.getImageData(0, 0, bw, bh).data);
        }
        canvas._boxDown.set(`${bw}x${bh}`, out);
    }
    return canvas._boxDown.get(key);
}

// Bilinear sample of a frame's warp grid (GX x GY nodes over u,v in [0,1]).
export function warpAt(grid, [GX, GY], u, v) {
    const gx = Math.min(GX - 1.001, Math.max(0, u * (GX - 1))), gy = Math.min(GY - 1.001, Math.max(0, v * (GY - 1)));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, g = (y0 * GX + x0) * 2;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, s = GX * 2;
    return [w00 * grid[g] + w10 * grid[g + 2] + w01 * grid[g + s] + w11 * grid[g + s + 2],
            w00 * grid[g + 1] + w10 * grid[g + 3] + w01 * grid[g + s + 1] + w11 * grid[g + s + 3]];
}

// Brightest linear value any gained frame can produce (a white pixel at the
// frame corner the gain field raises most); the stitch shader's shoulder maps
// it to 1.
export function whitePoint(gains, slopes, n) {
    let wp = 1;
    for (let k = 0; k < Math.min(n, gains.length); k++) {
        const sv = slopes ? slopes[2 * k] || 0 : 0, su = slopes ? slopes[2 * k + 1] || 0 : 0;
        wp = Math.max(wp, gains[k] * Math.exp((Math.abs(sv) + Math.abs(su)) / 2));
    }
    return wp;
}

// Width of a frame's outer band, as a fraction of its half-size (0.3 = the
// outer 15% on each side). The stitch shader fades blend shares over the same band.
export const RIM = 0.3;
const smoothstep01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// 0..1: how close the camera came to clipping (brightest channel, sRGB
// bytes). The stitch shader uses the same ramp.
export function clipAmount(r, g, b) {
    const t = Math.min(1, Math.max(0, (Math.max(r, g, b) - 230) / 20));
    return t * t * (3 - 2 * t);
}

// Extended Reinhard compression, applied to the peak channel to keep RGB ratios
// and avoid out-of-gamut colors. The same capture-wide curve is used in the
// stitch shader: matching gained colors must still match across frame borders.
// Unlike a high-knee shoulder, this leaves room for detail above linear white.
// At wp=1 it is the identity; at m=wp it reaches display white.
// Reinhard et al., eq. 4 (adapted from luminance to peak channel):
// https://www-old.cs.utah.edu/docs/techreports/2002/pdf/UUCS-02-001.pdf
export function shoulder(c, wp) {
    const m = Math.max(c[0], c[1], c[2]);
    if (wp <= 1) return c;
    const f = (1 + m / (wp * wp)) / (1 + m);
    c[0] *= f; c[1] *= f; c[2] *= f;
    return c;
}

export function computeSeamLabels(frames, canvases, gains, tanHalfHF, tanHalfVF, { width = 512, height = 256, radius = 3, wide = 20, warps = null, warpGrid = null, misfit = null } = {}) {
    const W = width, H = height, N = W * H, n = frames.length;
    const SW = 90, SH = 160;
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    // Per-frame footprint on the grid: pixel indices, gained linear colors, center quality.
    const foot = [];
    const peakQuality = new Float32Array(N);
    const tex = new Float32Array(N), tmpLocal = new Int32Array(N).fill(-1);  // any frame's own gradient
    const dirs = new Float32Array(N * 3), cosLat = new Float32Array(H);
    const wp = gains.whitePoint ?? 1, rgb = [0, 0, 0];
    for (let r = 0; r < H; r++) {
        const lat = Math.PI * (0.5 - (r + 0.5) / H);
        cosLat[r] = Math.cos(lat);
        for (let c = 0; c < W; c++) {
            const lon = 2 * Math.PI * ((c + 0.5) / W) - Math.PI, p = (r * W + c) * 3;
            dirs[p] = Math.cos(lat) * Math.sin(lon); dirs[p + 1] = Math.sin(lat); dirs[p + 2] = Math.cos(lat) * Math.cos(lon);
        }
    }
    for (let k = 0; k < n; k++) {
        const img = boxDown(canvases[k], SW, SH), g0 = gains[k] || 1;
        const sv = gains.slopes ? gains.slopes[2 * k] || 0 : 0, su = gains.slopes ? gains.slopes[2 * k + 1] || 0 : 0;
        const y = frames[k].yaw * Math.PI / 180, pt = frames[k].pitch * Math.PI / 180, rl = (frames[k].roll || 0) * Math.PI / 180;
        const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(pt), sp = Math.sin(pt), cr = Math.cos(rl), sr = Math.sin(rl);
        const idx = [], col = [], q = [], clip = [], rim = [];
        for (let p = 0; p < N; p++) {
            const wx = dirs[p * 3], wy = dirs[p * 3 + 1], wz = dirs[p * 3 + 2];
            const tx = cy * wx + sy * wz, tz = -sy * wx + cy * wz;
            const t2y = cp * wy + sp * tz, t2z = -sp * wy + cp * tz;
            if (t2z <= 0) continue;
            const xn = (cr * tx - sr * t2y) / t2z, yn = (sr * tx + cr * t2y) / t2z;
            if (Math.abs(xn) > tanHalfHF || Math.abs(yn) > tanHalfVF) continue;
            let u = xn / (2 * tanHalfHF) + 0.5, v = yn / (2 * tanHalfVF) + 0.5;
            if (warps && warps[k]) {  // same local warp the render applies
                const [du, dv] = warpAt(warps[k], warpGrid, u, v);
                u -= du; v -= dv;
                if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
            }
            // Match the render's linear texture sampling. Nearest samples made
            // smooth sky gradients into a staircase; the texture detector then
            // mistook those steps for detail and kept small, blocky owner cuts.
            const sampleX = Math.max(0, Math.min(SW - 1, u * SW - 0.5));
            const sampleY = Math.max(0, Math.min(SH - 1, v * SH - 0.5));
            const x0 = Math.floor(sampleX), y0 = Math.floor(sampleY), fx = sampleX - x0, fy = sampleY - y0;
            const s00 = (y0 * SW + x0) * 4, s10 = (y0 * SW + Math.min(SW - 1, x0 + 1)) * 4;
            const s01 = (Math.min(SH - 1, y0 + 1) * SW + x0) * 4;
            const s11 = (Math.min(SH - 1, y0 + 1) * SW + Math.min(SW - 1, x0 + 1)) * 4;
            for (let ch = 0; ch < 3; ch++) {
                rgb[ch] = (1 - fy) * ((1 - fx) * img[s00 + ch] + fx * img[s10 + ch])
                    + fy * ((1 - fx) * img[s01 + ch] + fx * img[s11 + ch]);
            }
            const cl = clipAmount(rgb[0], rgb[1], rgb[2]);
            let g = g0 * Math.exp(sv * (v - 0.5) + su * (u - 0.5));  // same gain field, clip rule and shoulder as the render
            if (g < 1) g = Math.pow(g, 1 - cl);
            for (let ch = 0; ch < 3; ch++) {
                const lo = Math.floor(rgb[ch]), f = rgb[ch] - lo;
                rgb[ch] = (lin[lo] * (1 - f) + lin[Math.min(255, lo + 1)] * f) * g;
            }
            shoulder(rgb, wp);
            idx.push(p); col.push(rgb[0], rgb[1], rgb[2]);
            const quality = 1 - Math.hypot(xn / tanHalfHF, yn / tanHalfVF);
            q.push(quality);
            peakQuality[p] = Math.max(peakQuality[p], quality);
            clip.push(cl);
            rim.push(1 - smoothstep01(Math.max(0, 1 - 2 * Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5))) / RIM));
        }
        const cover = new Uint8Array(N);
        for (const p of idx) cover[p] = 1;
        foot.push({ idx: Int32Array.from(idx), col: Float32Array.from(col), q: Float32Array.from(q), clip: Float32Array.from(clip), rim: Float32Array.from(rim), cover });
        // Texture = high-frequency energy: how far a pixel sits from the mean
        // of its 3x3 neighbours. A smooth gradient (sky, flare) scores ~0 and an
        // edge scores about half its step, so noise and sky gradients do not
        // count as detail the way a plain gradient would.
        for (let i = 0; i < idx.length; i++) tmpLocal[idx[i]] = i;
        for (let i = 0; i < idx.length; i++) {
            const p = idx[i], r = (p / W) | 0, c = p - r * W;
            let mr = 0, mg = 0, mb = 0, m = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const rr = r + dy;
                if (rr < 0 || rr >= H) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const q = rr * W + (c + dx + W) % W;
                    if (!cover[q]) continue;
                    const j = tmpLocal[q] * 3;
                    mr += col[j]; mg += col[j + 1]; mb += col[j + 2]; m++;
                }
            }
            const g = Math.abs(col[i * 3] - mr / m) + Math.abs(col[i * 3 + 1] - mg / m) + Math.abs(col[i * 3 + 2] - mb / m);
            if (g > tex[p]) tex[p] = g;
        }
        for (let i = 0; i < idx.length; i++) tmpLocal[idx[i]] = -1;
    }
    // Add frames from the horizon outward: widest overlap with what is already placed.
    const order = [...Array(n).keys()].sort((a, b) => Math.abs(frames[a].pitch) - Math.abs(frames[b].pitch) || frames[a].yaw - frames[b].yaw);
    const owner = new Int16Array(N).fill(-1), mcol = new Float32Array(N * 3), mq = new Float32Array(N), mclip = new Float32Array(N), mrim = new Float32Array(N);
    const local = new Int32Array(N).fill(-1), node = new Int32Array(N).fill(-1);
    // CLIP: cost of a grid pixel the camera clipped. Gains cannot restore
    // clipped sky (a frame exposed for a dark arcade shows it near white),
    // so a frame that saw it unclipped should own it; on the scale of a seam
    // edge where frames differ by a full sky's color.
    // RIM_COST: cost of a grid pixel in a frame's outer band (RIM), where
    // lens distortion and warps fitted from the interior are least accurate:
    // a frame that showed a roof only along its bottom edge put it ~1 degree
    // too high, and owning that strip drew a ghost roof in the sky. Above
    // CLIP, so a bright (near-clipped) sky in the frame's center still wins.
    const BIG = 1e9, LAMBDA = 2, EPS = 0.5, SCALE = 100, CLIP = 60, RIM_COST = 100;
    const nb = (p, out) => {  // 4-neighbours, wrapping in longitude
        const r = (p / W) | 0, c = p - r * W;
        out[0] = r * W + (c + 1) % W; out[1] = r * W + (c + W - 1) % W;
        out[2] = r > 0 ? p - W : -1; out[3] = r < H - 1 ? p + W : -1;
    };
    const nbs = new Int32Array(4);
    for (const k of order) {
        const f = foot[k];
        for (let i = 0; i < f.idx.length; i++) local[f.idx[i]] = i;
        const overlap = [];
        for (let i = 0; i < f.idx.length; i++) if (owner[f.idx[i]] >= 0) { node[f.idx[i]] = overlap.length; overlap.push(f.idx[i]); }
        // Pixels only this frame sees are its own.
        for (let i = 0; i < f.idx.length; i++) {
            const p = f.idx[i];
            if (owner[p] < 0) { owner[p] = k; mcol[p * 3] = f.col[i * 3]; mcol[p * 3 + 1] = f.col[i * 3 + 1]; mcol[p * 3 + 2] = f.col[i * 3 + 2]; mq[p] = f.q[i]; mclip[p] = f.clip[i]; mrim[p] = f.rim[i]; node[p] = -2; }
        }
        if (overlap.length) {
            const m = overlap.length, sc = new Float64Array(m), tc = new Float64Array(m), edges = [];
            for (let v = 0; v < m; v++) {
                const p = overlap[v], i = local[p];
                sc[v] = LAMBDA * (1 - f.q[i]) + CLIP * f.clip[i] + RIM_COST * f.rim[i];  // cost of giving p to the new frame
                tc[v] = LAMBDA * (1 - mq[p]) + CLIP * mclip[p] + RIM_COST * mrim[p];    // cost of keeping the current owner
                nb(p, nbs);
                const dv = Math.abs(mcol[p * 3] - f.col[i * 3]) + Math.abs(mcol[p * 3 + 1] - f.col[i * 3 + 1]) + Math.abs(mcol[p * 3 + 2] - f.col[i * 3 + 2]);
                for (let t = 0; t < 4; t++) {
                    const q = nbs[t];
                    if (q < 0) continue;
                    if (node[q] === -2) tc[v] = BIG;                        // touches pixels only the new frame sees
                    else if (node[q] === -1 && owner[q] >= 0) sc[v] = BIG;  // touches pixels the new frame can't see
                    else if (node[q] >= 0 && (t === 0 || t === 3)) {  // right and down: each edge once
                        const j = local[q];
                        const dq = Math.abs(mcol[q * 3] - f.col[j * 3]) + Math.abs(mcol[q * 3 + 1] - f.col[j * 3 + 1]) + Math.abs(mcol[q * 3 + 2] - f.col[j * 3 + 2]);
                        const len = t < 2 ? cosLat[(p / W) | 0] : 1;  // horizontal steps shrink toward the poles
                        edges.push(v, node[q], ((dv + dq) * SCALE + EPS) * len);
                    }
                }
            }
            const side = minCut(m, edges, sc, tc);
            for (let v = 0; v < m; v++) if (!side[v]) {
                const p = overlap[v], i = local[p];
                owner[p] = k; mcol[p * 3] = f.col[i * 3]; mcol[p * 3 + 1] = f.col[i * 3 + 1]; mcol[p * 3 + 2] = f.col[i * 3 + 2]; mq[p] = f.q[i]; mclip[p] = f.clip[i]; mrim[p] = f.rim[i];
            }
        }
        for (let i = 0; i < f.idx.length; i++) { local[f.idx[i]] = -1; node[f.idx[i]] = -1; }
    }
    // Blend width along seams: a few pixels where there is detail (a wide
    // blend ghosts any residual misalignment) and wide in smooth regions like
    // sky, where frames differ by exposure and flare and a narrow cut shows as
    // a stepped outline. Texture (above) is grown 3 px so the band narrows
    // before it reaches detail, then averaged so the width changes gradually.
    const NOISE = 0.02, TAU = 0.06;  // below NOISE is smooth; NOISE + TAU and above is detail
    const filt = (src, r, max) => {  // separable max or mean, wrapping in longitude
        const tmp = new Float32Array(N), out = new Float32Array(N);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let acc = 0;
            for (let t = -r; t <= r; t++) { const v = src[y * W + (x + t + W) % W]; acc = max ? Math.max(acc, v) : acc + v; }
            tmp[y * W + x] = max ? acc : acc / (2 * r + 1);
        }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let acc = 0;
            for (let t = -r; t <= r; t++) { const v = tmp[Math.min(H - 1, Math.max(0, y + t)) * W + x]; acc = max ? Math.max(acc, v) : acc + v; }
            out[y * W + x] = max ? acc : acc / (2 * r + 1);
        }
        return out;
    };
    const grown = filt(tex, 3, true);
    for (let p = 0; p < N; p++) grown[p] = Math.min(1, Math.max(0, 1 - (grown[p] - NOISE) / TAU));
    const smoothBlend = filt(grown, 4, false);
    const blendRadius = smoothBlend.slice();
    // The minimum band follows the measured misalignment left after the
    // warps: where the frames agree to ~0.15 deg even detail (clouds,
    // treetops, a far wall) gets 8 px, since a narrow cut there only shows
    // the label grid as a stepped outline; where they still disagree by 0.4
    // deg or more (close, moving) it stays at `radius`. No measurement: 5 px.
    const useMisfit = misfit && misfit.width === W && misfit.height === H;
    for (let p = 0; p < N; p++) {
        let rmin = 5;
        if (useMisfit) {
            const m = misfit.data[p];
            if (m === m) rmin = m < 0.15 ? 8 : m > 0.4 ? radius : 8 - (8 - radius) * (m - 0.15) / 0.25;
        }
        blendRadius[p] = rmin + (wide - rmin) * blendRadius[p];
    }
    // Routed blend masks for detail. A frame's share is 1 over the region it owns and
    // falls off with the distance from that region (8-neighbour Dijkstra, kept
    // inside the frame's own coverage, so the ramps are round and every frame
    // at a junction ramps on its own) over the local blend width, and fades to
    // 0 over the last EDGE px before the coverage ends so no step shows there.
    // The render divides by the sum of the shares of the frames covering a pixel.
    const EDGE = 4, masks = new Uint8Array(n * N), d = new Float32Array(N), edgeFade = new Float32Array(N), buckets = [];
    const nb8 = new Int32Array(8), step8 = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    const neighbours8 = (p) => {
        const r = (p / W) | 0, c = p - r * W, l = (c + W - 1) % W, rt = (c + 1) % W;
        nb8[0] = r * W + rt; nb8[1] = r * W + l; nb8[2] = r > 0 ? p - W : -1; nb8[3] = r < H - 1 ? p + W : -1;
        nb8[4] = r > 0 ? (r - 1) * W + l : -1; nb8[5] = r > 0 ? (r - 1) * W + rt : -1;
        nb8[6] = r < H - 1 ? (r + 1) * W + l : -1; nb8[7] = r < H - 1 ? (r + 1) * W + rt : -1;
    };
    // Dijkstra from the seeds (d = 0) through covered pixels, up to `limit`; a bucket queue since steps are 1 or sqrt 2.
    const sweep = (seeds, cover, limit) => {
        buckets.length = 0;
        const push = (p, dd) => { const k = Math.round(dd * 10); (buckets[k] = buckets[k] || []).push(p); };
        for (const p of seeds) push(p, 0);
        for (let k = 0; k < buckets.length; k++) {
            const bucket = buckets[k];
            if (!bucket) continue;
            for (const p of bucket) {
                if (Math.round(d[p] * 10) !== k || d[p] >= limit) continue;
                neighbours8(p);
                for (let t = 0; t < 8; t++) {
                    const q = nb8[t];
                    if (q < 0 || !cover[q]) continue;
                    const dd = d[p] + step8[t];
                    if (dd >= d[q] || dd > limit) continue;
                    d[q] = dd; push(q, dd);
                }
            }
        }
    };
    for (let k = 0; k < n; k++) {
        const cover = foot[k].cover, rim = [], seeds = [];
        d.fill(Infinity);
        for (let p = 0; p < N; p++) {
            if (!cover[p]) continue;
            nb(p, nbs);
            for (let t = 0; t < 4; t++) { const q = nbs[t]; if (q >= 0 && !cover[q]) { d[p] = 0; rim.push(p); break; } }
        }
        sweep(rim, cover, EDGE);
        for (let p = 0; p < N; p++) edgeFade[p] = cover[p] ? Math.min(1, d[p] / EDGE) : 0;
        d.fill(Infinity);
        for (let p = 0; p < N; p++) {
            if (owner[p] !== k) continue;
            d[p] = 0;
            nb(p, nbs);
            for (let t = 0; t < 4; t++) { const q = nbs[t]; if (q >= 0 && owner[q] !== k) { seeds.push(p); break; } }
        }
        sweep(seeds, cover, wide);
        for (let p = 0; p < N; p++) {
            if (!cover[p] || d[p] === Infinity) continue;
            masks[k * N + p] = Math.round(Math.max(0, 1 - d[p] / blendRadius[p]) * edgeFade[p] * 255);
        }
        // In detailed regions, reject disagreement beyond the owned region:
        // a frame that put a roof ~1 degree too high (its rim) ghosted it into
        // the owner's sky. Smooth regions use the continuous weights below.
        const fk = foot[k];
        for (let i = 0; i < fk.idx.length; i++) {
            const p = fk.idx[i], m = k * N + p;
            let routed = masks[m] / 255;
            if (owner[p] !== k && routed > 0) {
                const r = fk.col[i * 3], g = fk.col[i * 3 + 1], b = fk.col[i * 3 + 2];
                const or = mcol[p * 3], og = mcol[p * 3 + 1], ob = mcol[p * 3 + 2];
                const rel = Math.hypot(r - or, g - og, b - ob) / Math.max(Math.hypot(r, g, b), Math.hypot(or, og, ob), 0.05);
                routed *= 1 - smoothstep01((rel - 0.35) / 0.35);
            }
            // Flat overlap needs no owner boundary. Rejecting a differently
            // exposed sky only outside its owned region introduced a step at
            // every label change, regardless of the feather width. Use all
            // covering frames with continuous center weights here; the shared
            // texture mask fades back to routed seams before reaching detail.
            // Put both modes on the same scale (strongest share = 1). Without
            // this, a tiny remnant of an owner mask can dominate weak center
            // weights and leave a block even in an almost completely flat area.
            const q = Math.max(0, fk.q[i]) / Math.max(peakQuality[p], 1e-5);
            const smooth = q * q * edgeFade[p];
            const t = smoothstep01(smoothBlend[p]);
            masks[m] = Math.round(255 * (routed * (1 - t) + smooth * t));
        }
    }
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('seamDebug') === '1') window.__seamDebug = { W, H, owner, blendRadius, tex, tanHalfHF, tanHalfVF, frames: frames.map(({ hotspotId, yaw, pitch, roll }) => ({ hotspotId, yaw, pitch, roll })), gains: Array.from(gains.slice(0, n)), slopes: gains.slopes ? Array.from(gains.slopes.slice(0, 2 * n)) : null, warps: warps ? warps.map((g) => g && Array.from(g)) : null, warpGrid };  // harness inspection
    return { width: W, height: H, owner, masks };
}
