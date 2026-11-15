// THREE camera-local -> world quaternion, in [x, y, z, w] order.
// The stitcher uses image y-down and a world rotated 180 degrees about z.
// Derive all three pose angles from one rotation, never from gravity's x
// component: gravity cannot measure twist about an almost vertical lens.
export function poseFromQuaternion(q) {
    if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return null;
    const norm = Math.hypot(...q);
    if (norm < 1e-8) return null;
    const [x, y, z, w] = q.map(v => v / norm);
    const right = [1 - 2 * (y*y + z*z), 2 * (x*y + z*w), 2 * (x*z - y*w)];
    const up = [2 * (x*y - z*w), 1 - 2 * (x*x + z*z), 2 * (y*z + x*w)];
    const back = [2 * (x*z + y*w), 2 * (y*z - x*w), 1 - 2 * (x*x + y*y)];
    const M = [[-right[0], -right[1], right[2]], [up[0], up[1], -up[2]], [back[0], back[1], -back[2]]];
    const pitch = Math.asin(Math.max(-1, Math.min(1, -M[2][1])));
    const yaw = Math.hypot(M[2][0], M[2][2]) < 1e-8 ? 0 : Math.atan2(-M[2][0], M[2][2]);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const baseX = [cy, 0, sy];
    const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    const roll = Math.atan2(dot(M[1], baseX), dot(M[0], baseX));
    const deg = 180 / Math.PI;
    return { yaw: (yaw * deg + 360) % 360, pitch: pitch * deg, roll: roll * deg };
}

export function capturePose(camera, frame) {
    const orientationQuaternion = camera.quaternion.toArray();
    const pose = poseFromQuaternion(orientationQuaternion);
    if (!pose) throw new Error('Invalid camera orientation at capture');
    return { ...pose, orientationQuaternion, orientationVersion: 1,
        orientationTimestamp: frame.timestamp, videoTime: frame.videoTime };
}
