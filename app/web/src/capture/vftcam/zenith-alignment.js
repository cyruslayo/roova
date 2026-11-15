// Copied unchanged from reference/vftcam-js/js/modules/zenith-alignment.js (VFTCam application code; see THIRD_PARTY_NOTICES.md).
import { boxDown } from './seam-finder.js';

const D = Math.PI / 180;
const matrix = ({ yaw, pitch, roll = 0 }) => {
    const cy = Math.cos(yaw * D), sy = Math.sin(yaw * D);
    const cp = Math.cos(pitch * D), sp = Math.sin(pitch * D);
    const cr = Math.cos(roll * D), sr = Math.sin(roll * D);
    return [[cr*cy + sr*sp*sy, -sr*cp, cr*sy - sr*sp*cy],
        [sr*cy - cr*sp*sy, cr*cp, sr*sy + cr*sp*cy], [-cp*sy, -sp, cp*cy]];
};
const angularDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Legacy captures saved gravity tilt as roll, which loses lens-axis twist near
// vertical. Search that missing degree of freedom before the small-rotation
// feature matcher. Normalized correlation tolerates exposure differences; a
// separated second peak and several supporting neighbours are required so a
// blank sky or repetitive ceiling cannot silently dictate a large rotation.
export function recoverZenithRoll(frames, canvases, tanH, tanV) {
    const W = 90, H = 160;
    const gray = new Map();
    const pixels = k => {
        if (!gray.has(k)) {
            const rgba = boxDown(canvases[k], W, H), data = new Float32Array(W * H);
            for (let p = 0; p < data.length; p++) data[p] = .299*rgba[4*p] + .587*rgba[4*p+1] + .114*rgba[4*p+2];
            gray.set(k, data);
        }
        return gray.get(k);
    };
    const sample = (g, x, y) => {
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, p = iy*W + ix;
        return (g[p]*(1-fx) + g[p+1]*fx)*(1-fy) + (g[p+W]*(1-fx) + g[p+W+1]*fx)*fy;
    };
    const diagnostics = [];
    frames.forEach((frame, k) => {
        if (frame.pitch < 75 || frame.hasFullOrientation) return;
        const neighbors = frames.map((f, j) => ({ f, j })).filter(({ f, j }) => j !== k && f.pitch > 20 && f.pitch < 70)
            .map(({ f, j }) => ({ matrix: matrix(f), pixels: pixels(j), id: f.hotspotId }));
        if (neighbors.length < 3) return;
        const src = pixels(k), points = [];
        let textured = 0;
        for (let y = 4; y < H - 4; y += 3) for (let x = 4; x < W - 4; x += 3) {
            points.push([(2*(x+.5)/W-1)*tanH, (2*(y+.5)/H-1)*tanV, src[y*W+x]]);
            const p = y*W+x;
            if (Math.abs(src[p] - (src[p-1]+src[p+1]+src[p-W]+src[p+W])/4) > 2) textured++;
        }
        if (textured < points.length*.015) {
            diagnostics.push({ hotspotId: frame.hotspotId, originalRoll: frame.roll || 0, roll: frame.roll || 0,
                score: 0, support: 0, margin: 0, accepted: false, reason: 'insufficient texture', candidates: [] });
            return;
        }
        const evaluate = roll => {
            const m = matrix({ ...frame, roll }), correlations = [];
            for (const neighbor of neighbors) {
                // M_neighbor * transpose(M_zenith) maps image rays directly.
                const t = neighbor.matrix.map(row => m.map(col => row.reduce((s, v, c) => s + v*col[c], 0)));
                let n = 0, a = 0, b = 0, aa = 0, bb = 0, ab = 0;
                for (const [x, y, v] of points) {
                    const z = t[2][0]*x + t[2][1]*y + t[2][2];
                    if (z <= 0) continue;
                    const u = ((t[0][0]*x + t[0][1]*y + t[0][2])/z/(2*tanH)+.5)*W-.5;
                    const w = ((t[1][0]*x + t[1][1]*y + t[1][2])/z/(2*tanV)+.5)*H-.5;
                    if (u < 2 || u >= W-3 || w < 2 || w >= H-3) continue;
                    const vj = sample(neighbor.pixels, u, w);
                    n++; a += v; b += vj; aa += v*v; bb += vj*vj; ab += v*vj;
                }
                const va = aa-a*a/n, vb = bb-b*b/n;
                if (n < 35 || va/n < 16 || vb/n < 16) continue;
                correlations.push({ id: neighbor.id, score: (ab-a*b/n)/Math.sqrt(va*vb), samples: n });
            }
            correlations.sort((a, b) => b.score-a.score);
            // Score a fixed number of views. Sparse, accidental overlap cannot
            // beat a well-supported candidate by discarding difficult views.
            const chosen = correlations.slice(0, 4);
            const score = chosen.length < 3 ? -1 : chosen.reduce((s, c) => s+c.score, 0)/chosen.length;
            return { roll, score, support: chosen.filter(c => c.score > .35).length, neighbors: chosen };
        };
        const candidates = [];
        for (let r = -180; r < 180; r += 5) candidates.push(evaluate(r));
        candidates.sort((a, b) => b.score-a.score);
        const coarse = candidates[0];
        let best = coarse;
        for (let r = coarse.roll-5; r <= coarse.roll+5; r += .5) {
            const candidate = evaluate(r);
            if (candidate.score > best.score) best = candidate;
        }
        const runnerUp = candidates.find(c => angularDistance(c.roll, best.roll) >= 20);
        const margin = best.score-(runnerUp?.score ?? best.score);
        const accepted = best.score >= .5 && best.support >= 3 && margin >= .08;
        diagnostics.push({ hotspotId: frame.hotspotId, originalRoll: frame.roll || 0, ...best, margin, accepted,
            candidates: candidates.map(({ roll, score }) => ({ roll, score })).sort((a, b) => a.roll-b.roll) });
        if (accepted) frame.roll = ((best.roll+540)%360)-180;
    });
    return diagnostics;
}
