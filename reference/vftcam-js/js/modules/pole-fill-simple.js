/**
 * Pole Filling for Equirectangular Panoramas
 * ===========================================
 *
 * Fills the "pole holes" at the top and bottom of a 360° panorama, where no
 * frame reaches (usually straight down; straight up too if there is no zenith
 * frame).
 *
 * ALGORITHM:
 * ----------
 * 1. Hole pixels are exact (0,0,0): that is what the stitch shader writes
 *    where no frame reaches, so dark photographed content is never repainted.
 *    A pole with no hole pixels is left exactly as stitched.
 * 2. The cap around the pole is resampled into a small top-down (azimuthal)
 *    view. In the panorama a pole is a whole row, so filling column by column
 *    gave radial spokes and a pinch at the pole; in the top-down view the cap
 *    is a disc and the pole is a point.
 * 3. The hole is filled by push-pull (a pyramid of the photographed pixels,
 *    then each level's gaps take the coarser level's value), then relaxed
 *    toward the average of its neighbours, which removes the pyramid's square
 *    blocks. Edge colors spread smoothly to the pole with no streaks.
 * 4. The fill covers a disc out to the deepest hole pixel, and the photo
 *    fades into it over a feather band beyond. A cap shaped like the hole
 *    traced every frame corner as a spiky outline; a round one does not.
 * 5. With nadirDeg set (the tripod setting), the nadir disc reaches at least
 *    that far from straight down even where the tripod was photographed, so
 *    the tripod is replaced by the blurred ground just outside it.
 *
 * @param {WebGL2RenderingContext} gl - WebGL context from the panorama canvas
 * @param {HTMLCanvasElement} canvas - The panorama canvas to process
 * @param {{nadirDeg?: number}} [options] - nadirDeg: minimum nadir fill radius in degrees
 */
export function fillPolesSimple(gl, canvas, { nadirDeg = 0 } = {}) {
    const w = canvas.width;
    const h = canvas.height;
    console.log(`Simple pole fill for ${w}x${h} panorama`);

    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // GL rows are bottom-up: row 0 holds the nadir, row h-1 the zenith.
    const nadir = fillCap(pixels, w, h, 0, 1, Math.round(h * nadirDeg / 180));
    const zenith = fillCap(pixels, w, h, h - 1, -1);
    console.log(`Pole fill: nadir ${nadir.holes} hole pixels (cap ${nadir.cap} rows), zenith ${zenith.holes} (cap ${zenith.cap} rows)`);
    if (!nadir.cap && !zenith.cap) return;

    drawPixels(gl, pixels, w, h);
    console.log('Simple pole filling complete');
}

const G = 128;          // top-down grid size (cells); the fill is blurred, so coarse is enough
const FEATHER = 32;     // panorama rows over which the photo fades into the fill
const BLUR_ROWS = 16;   // blur of the fill, in panorama rows: less hides the ring's texture spreading inward as streaks

// Fills the cap at `pole` (GL row) whose rows run inward by `step`, at least
// `minDepth` rows deep. Returns { holes, cap }: hole pixels filled and the cap depth in rows.
export function fillCap(px, w, h, pole, step, minDepth = 0) {
    const isHole = (i) => px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 0;
    const rowIndex = (r) => pole + step * r;
    // Hole depth: the deepest run of hole pixels from the pole in any column.
    const limit = Math.floor(h / 3);
    let depth = 0;
    for (let x = 0; x < w; x++) {
        let r = 0;
        while (r < limit && isHole((rowIndex(r) * w + x) * 4)) r++;
        depth = Math.max(depth, r);
    }
    if (depth < limit) depth = Math.min(limit - 1, Math.max(depth, minDepth));
    if (depth === 0 || depth >= limit) return { holes: 0, cap: 0 };  // nothing to fill, or nothing photographed nearby
    const cap = Math.min(limit, depth + FEATHER + 2 * BLUR_ROWS);
    const R = G / 2, cellsPerRow = R / cap;

    // Average the photo around the disc into the grid; m = 1 where a cell
    // got pixels. Inside the disc, frame edges near the hole are smeared, so
    // the fill comes only from the photo outside it.
    const N = G * G, col = new Float32Array(N * 3), m = new Float32Array(N), count = new Float32Array(N);
    const cellOf = (r, x) => {
        const rho = (r + 0.5) / cap, phi = 2 * Math.PI * (x + 0.5) / w;
        const i = Math.min(G - 1, Math.floor(Math.cos(phi) * rho * R + R)), j = Math.min(G - 1, Math.floor(Math.sin(phi) * rho * R + R));
        return j * G + i;
    };
    for (let r = depth; r < cap; r++) for (let x = 0; x < w; x++) {
        const p = (rowIndex(r) * w + x) * 4;
        if (isHole(p)) continue;
        const c = cellOf(r, x);
        col[c * 3] += px[p]; col[c * 3 + 1] += px[p + 1]; col[c * 3 + 2] += px[p + 2]; count[c]++;
    }
    for (let c = 0; c < N; c++) if (count[c]) { col[c * 3] /= count[c]; col[c * 3 + 1] /= count[c]; col[c * 3 + 2] /= count[c]; m[c] = 1; }

    const filled = relax(pushPull(col, m, G), m, G);
    const blurred = blur(filled, G, Math.max(1, BLUR_ROWS * cellsPerRow));

    // Write back every cap pixel: fill inside the disc, photo faded in beyond it.
    const sample = (arr, ch, gi, gj, out) => {
        const i0 = Math.max(0, Math.min(G - 2, Math.floor(gi))), j0 = Math.max(0, Math.min(G - 2, Math.floor(gj)));
        const fx = Math.max(0, Math.min(1, gi - i0)), fy = Math.max(0, Math.min(1, gj - j0));
        for (let q = 0; q < ch; q++) {
            const a = arr[(j0 * G + i0) * ch + q], b = arr[(j0 * G + i0 + 1) * ch + q];
            const c = arr[((j0 + 1) * G + i0) * ch + q], d = arr[((j0 + 1) * G + i0 + 1) * ch + q];
            out[q] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        }
    };
    const rgb = [0, 0, 0];
    let holes = 0;
    for (let r = 0; r < cap; r++) {
        const rho = (r + 0.5) / cap, s = Math.min(1, Math.max(0, (r - depth) / FEATHER)), t = s * s * (3 - 2 * s);
        for (let x = 0; x < w; x++) {
            const phi = 2 * Math.PI * (x + 0.5) / w;
            const gi = Math.cos(phi) * rho * R + R - 0.5, gj = Math.sin(phi) * rho * R + R - 0.5;
            const p = (rowIndex(r) * w + x) * 4;
            if (isHole(p)) holes++;
            sample(blurred, 3, gi, gj, rgb);
            for (let q = 0; q < 3; q++) px[p + q] = Math.round(rgb[q] * (1 - t) + px[p + q] * t);
            px[p + 3] = 255;
        }
    }
    return { holes, cap };
}

// Push-pull fill of an n x n RGB grid where weight m < 1. Returns a new array.
function pushPull(col, m, n) {
    const levels = [{ n, c: col, w: m }];
    while (levels[levels.length - 1].n > 1) {  // push: 2x2 weighted averages
        const f = levels[levels.length - 1], cn = f.n >> 1;
        const c = new Float32Array(cn * cn * 3), wt = new Float32Array(cn * cn);
        for (let j = 0; j < cn; j++) for (let i = 0; i < cn; i++) {
            let s = 0, r = 0, g = 0, b = 0;
            for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
                const k = (2 * j + dj) * f.n + 2 * i + di, kw = f.w[k];
                s += kw; r += f.c[k * 3] * kw; g += f.c[k * 3 + 1] * kw; b += f.c[k * 3 + 2] * kw;
            }
            const k = j * cn + i;
            if (s > 0) { c[k * 3] = r / s; c[k * 3 + 1] = g / s; c[k * 3 + 2] = b / s; }
            wt[k] = Math.min(1, s);
        }
        levels.push({ n: cn, c, w: wt });
    }
    for (let l = levels.length - 2; l >= 0; l--) {  // pull: gaps take the coarser level (bilinear)
        const f = levels[l], co = levels[l + 1], out = new Float32Array(f.n * f.n * 3);
        for (let j = 0; j < f.n; j++) for (let i = 0; i < f.n; i++) {
            const gi = Math.max(0, Math.min(co.n - 1, (i + 0.5) / 2 - 0.5)), gj = Math.max(0, Math.min(co.n - 1, (j + 0.5) / 2 - 0.5));
            const i0 = Math.floor(gi), j0 = Math.floor(gj), i1 = Math.min(co.n - 1, i0 + 1), j1 = Math.min(co.n - 1, j0 + 1);
            const fx = gi - i0, fy = gj - j0, k = j * f.n + i, a = Math.min(1, f.w[k]);
            for (let q = 0; q < 3; q++) {
                const up = (co.c[(j0 * co.n + i0) * 3 + q] * (1 - fx) + co.c[(j0 * co.n + i1) * 3 + q] * fx) * (1 - fy)
                         + (co.c[(j1 * co.n + i0) * 3 + q] * (1 - fx) + co.c[(j1 * co.n + i1) * 3 + q] * fx) * fy;
                out[k * 3 + q] = f.c[k * 3 + q] * a + up * (1 - a);
            }
        }
        f.c = out;
        f.w = new Float32Array(f.n * f.n).fill(1);
    }
    return levels[0].c;
}

// Over-relaxed Gauss-Seidel on the unknown cells (m = 0): each moves toward
// the average of its 4 neighbours, giving a smooth (harmonic) fill.
function relax(c, m, n, iterations = 300, omega = 1.95) {
    const cells = [];
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) if (!m[j * n + i]) cells.push(j * n + i);
    for (let it = 0; it < iterations; it++) {
        for (const k of cells) for (let q = 0; q < 3; q++) {
            const avg = (c[(k - 1) * 3 + q] + c[(k + 1) * 3 + q] + c[(k - n) * 3 + q] + c[(k + n) * 3 + q]) / 4;
            c[k * 3 + q] += omega * (avg - c[k * 3 + q]);
        }
    }
    return c;
}

// Separable Gaussian blur of an n x n RGB grid (edges clamped).
function blur(src, n, sigma) {
    const r = Math.ceil(2.5 * sigma), k = [];
    let sum = 0;
    for (let t = -r; t <= r; t++) { const v = Math.exp(-t * t / (2 * sigma * sigma)); k.push(v); sum += v; }
    for (let t = 0; t < k.length; t++) k[t] /= sum;
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) {
        let acc = 0;
        for (let t = -r; t <= r; t++) acc += k[t + r] * src[(j * n + Math.min(n - 1, Math.max(0, i + t))) * 3 + q];
        tmp[(j * n + i) * 3 + q] = acc;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) {
        let acc = 0;
        for (let t = -r; t <= r; t++) acc += k[t + r] * tmp[(Math.min(n - 1, Math.max(0, j + t)) * n + i) * 3 + q];
        out[(j * n + i) * 3 + q] = acc;
    }
    return out;
}

// Draws GL-ordered RGBA pixels back onto the canvas's default framebuffer.
function drawPixels(gl, pixels, w, h) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const vs = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_position * 0.5 + 0.5;
    }`;
    const fs = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_texture;
    void main() {
        gl_FragColor = texture2D(u_texture, v_texCoord);
    }`;
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    };
    const vertShader = compile(gl.VERTEX_SHADER, vs), fragShader = compile(gl.FRAGMENT_SHADER, fs);
    const program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.useProgram(program);
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    gl.deleteShader(vertShader);
    gl.deleteShader(fragShader);
    gl.deleteBuffer(buffer);
}
