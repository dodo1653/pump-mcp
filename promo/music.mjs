// PUMPMCP launch cut (34 s): score + sound design, synthesized. usage: DUR=34 node promo/music.mjs promo/out/music.wav
// usage: node music.mjs out/music.wav      (timings match the film mode in index.html)
import fs from 'node:fs'

const SR = 44100, DUR = +(process.env.DUR || 15), N = SR * DUR, TAU = Math.PI * 2
const L = new Float32Array(N), R = new Float32Array(N), VL = new Float32Array(N), VR = new Float32Array(N)
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12)
let seed = 4242
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)))
function add(i, v, pan = 0, send = 0) {
  i |= 0; if (i < 0 || i >= N) return
  const a = ((pan + 1) * Math.PI) / 4, l = v * Math.cos(a) * 1.414, r = v * Math.sin(a) * 1.414
  L[i] += l; R[i] += r; if (send) { VL[i] += l * send; VR[i] += r * send }
}
// soft plucked keys: sine + detuned triangle, fast attack, exp decay, gentle lowpass
function pluck(t0, m, amp = 0.12, dec = 4, pan = 0, send = 0.4) {
  const f = mtof(m); let y = 0
  for (let k = 0; k < Math.min(2.5, 6 / dec) * SR; k++) {
    const tt = k / SR, ph = tt * f
    let v = Math.sin(ph * TAU) * 0.7 + (4 * Math.abs(((ph * 1.003) % 1) - 0.5) - 1) * 0.35 + Math.sin(ph * 2 * TAU) * 0.15 * Math.exp(-tt * 12)
    y += 0.35 * (v - y)
    add(t0 * SR + k, y * Math.exp(-tt * dec) * Math.min(1, tt * 600) * amp, pan, send)
  }
}
function pad(t0, t1, notes, amp, att = 0.4, rel = 0.6) {
  notes.forEach((m, ni) => {
    let p1 = 0, p2 = 0, y = 0; const f = mtof(m)
    for (let i = (t0 * SR) | 0; i < Math.min(N, (t1 + rel) * SR); i++) {
      const t = i / SR, env = Math.min(1, (t - t0) / att) * (t > t1 ? Math.max(0, 1 - (t - t1) / rel) : 1)
      p1 += f / SR; p2 += (f * 1.005) / SR
      y += 0.04 * (((p1 % 1) * 2 - 1) + ((p2 % 1) * 2 - 1) - y)
      add(i, y * env * amp, ni % 2 ? 0.45 : -0.45, 0.5)
    }
  })
}
function kick(t0, amp = 0.8) { let ph = 0; for (let k = 0; k < 0.35 * SR; k++) { const tt = k / SR; ph += (TAU * (46 + 100 * Math.exp(-tt * 32))) / SR; add(t0 * SR + k, Math.sin(ph) * Math.exp(-tt * 9) * amp) } }
function snap(t0, amp = 0.3) { let p = 0; for (let k = 0; k < 0.16 * SR; k++) { const tt = k / SR, n = noise(), hp = n - p * 0.8; p = n; add(t0 * SR + k, hp * Math.exp(-tt * 30) * amp, 0.1, 0.35) } }
function hat(t0, amp = 0.08, pan = 0.3) { let p = 0; for (let k = 0; k < 0.04 * SR; k++) { const tt = k / SR, n = noise(), hp = n - p; p = n; add(t0 * SR + k, hp * Math.exp(-tt * 90) * amp, pan) } }
function sub(t0, dur, m, amp = 0.22) { const f = mtof(m); for (let k = 0; k < dur * SR; k++) { const tt = k / SR; const env = Math.min(1, tt * 80) * Math.min(1, (dur - tt) * 30); add(t0 * SR + k, Math.sin(tt * f * TAU) * env * amp) } }
function whoosh(t0, dur, amp = 0.3) { let y = 0; for (let k = 0; k < dur * SR; k++) { const p = k / (dur * SR), e = Math.sin(p * Math.PI) ** 2; y += (0.03 + 0.45 * e) * (noise() - y); add(t0 * SR + k, y * e * amp, (p - 0.5) * 1.6, 0.3) } }
function clink(t0, amp = 0.08, f = 3200, pan = 0) { for (let k = 0; k < 0.35 * SR; k++) { const tt = k / SR; add(t0 * SR + k, (Math.sin(tt * TAU * f) * 0.6 + Math.sin(tt * TAU * f * 2.71) * 0.3 + Math.sin(tt * TAU * f * 4.1) * 0.15) * Math.exp(-tt * 14) * amp, pan, 0.5) } }
function boom(t0, amp = 0.7) { let ph = 0; for (let k = 0; k < 1.5 * SR; k++) { const tt = k / SR; ph += (TAU * (40 + 50 * Math.exp(-tt * 8))) / SR; add(t0 * SR + k, Math.sin(ph) * Math.exp(-tt * 3) * amp, 0, 0.2) } }
function sparkle(t0, amp = 0.06) { ;[84, 88, 91, 96, 100, 103].forEach((m, i) => pluck(t0 + i * 0.045, m, amp, 5, i % 2 ? 0.5 : -0.5, 0.7)) }
function click(t0, amp = 0.3) { for (let k = 0; k < 0.03 * SR; k++) { const tt = k / SR; add(t0 * SR + k, (Math.sin(tt * TAU * 1800) * 0.7 + noise() * 0.3) * Math.exp(-tt * 160) * amp) } }
// extra sound design
function tick(t0, amp = 0.05) { const f = 2600 + noise() * 500; for (let k = 0; k < 0.012 * SR; k++) { const tt = k / SR; add(t0 * SR + k, (Math.sin(tt * TAU * f) * 0.5 + noise() * 0.5) * Math.exp(-tt * 380) * amp, 0.1) } }
function pop(t0, amp = 0.22, f0 = 950, f1 = 420) { let ph = 0; for (let k = 0; k < 0.12 * SR; k++) { const tt = k / SR; ph += TAU * (f1 + (f0 - f1) * Math.exp(-tt * 40)) / SR; add(t0 * SR + k, Math.sin(ph) * Math.exp(-tt * 28) * amp, 0, 0.25) } }
function boing(t0, amp = 0.2) { let ph = 0; for (let k = 0; k < 0.6 * SR; k++) { const tt = k / SR; const f = 220 * Math.pow(2, 1.6 * Math.min(1, tt * 3)) * (1 + 0.06 * Math.sin(tt * 38)); ph += TAU * f / SR; add(t0 * SR + k, Math.sin(ph) * Math.exp(-tt * 4.5) * amp, 0, 0.4) } }
function riser(t0, dur, amp = 0.18) { let y = 0; for (let k = 0; k < dur * SR; k++) { const p = k / (dur * SR); y += (0.02 + 0.5 * p * p) * (noise() - y); add(t0 * SR + k, y * p * p * amp, 0, 0.3) } }
function chime(t0) { pluck(t0, 88, 0.07, 6, 0.3, 0.6); pluck(t0 + 0.08, 95, 0.06, 6, -0.3, 0.6) }
function thud(t0, amp = 0.5) { let ph = 0; for (let k = 0; k < 0.5 * SR; k++) { const tt = k / SR; ph += (TAU * (70 + 60 * Math.exp(-tt * 18))) / SR; add(t0 * SR + k, Math.sin(ph) * Math.exp(-tt * 7) * amp, 0, 0.15) } }
function drop(t0, amp = 0.16) { let ph = 0; for (let k = 0; k < 0.45 * SR; k++) { const tt = k / SR; ph += (TAU * (900 * Math.exp(-tt * 5) + 120)) / SR; add(t0 * SR + k, Math.sin(ph) * Math.exp(-tt * 6) * amp, 0, 0.3) } }


const BEAT = 60 / 124
const CH = [[45, [57, 60, 64, 69]], [41, [57, 60, 65, 69]], [48, [60, 64, 67, 72]], [43, [55, 59, 62, 67]]]
function groove(a, b, opts = {}) {
  const at = (t) => CH[Math.floor(Math.max(0, t - a) / (BEAT * 8)) & 3]
  for (let t = a; t < b - .01; t += BEAT) {
    const k = Math.round((t - a) / BEAT)
    kick(t, .55); if (k % 2) snap(t, .14)
    hat(t + BEAT / 2, .05, .25); if (opts.busy) hat(t + BEAT * .25, .025, -.25)
    sub(t, BEAT * .5, at(t)[0], .15)
  }
  for (let t = a; t < b - .01; t += BEAT * 8) pad(t, Math.min(b, t + BEAT * 8), at(t + .01)[1], .022, .06, .3)
  for (let t = a + BEAT * 2; t < b - .01; t += BEAT / 2) { const n = at(t)[1], k = Math.round((t - a) / (BEAT / 2)); if (k % 4 !== 3) pluck(t, n[k % n.length] + 12, .032, 5, (k % 2 ? .4 : -.4), .5) }
}
// 0-2.6: the question, typed
for (let i = 0; i < 41; i++) click(.15 + i * (1.3 / 41), .11)
riser(1.5, 1.1, .22)
// 2.65: the logo
boom(2.65, .6); pop(2.7, .24, 950, 420); sparkle(2.75, .05); thud(3.0, .4); pad(2.65, 5.3, [57, 64, 69, 72, 76], .03, .1, .4)
whoosh(5.0, .5, .26)
// 5.35-17.3: the real session
groove(5.35, 17.3)
for (let i = 0; i < 24; i++) click(5.6 + i * (1.3 / 24), .07)                         // the prompt being typed
;[7.15, 9.2, 10.6].forEach((c) => { pop(c, .2, 1000, 460); chime(c + .55) })           // tool calls, then their results
;[7.2, 9.3].forEach((c) => thud(c, .3))
riser(11.4, .7, .18); boom(12.1, .45); sparkle(12.15, .05)                           // the verdict
whoosh(12.0, .6, .2); thud(12.4, .5); pop(12.45, .2, 900, 430)
whoosh(16.8, .6, .26)
// 17.3-21.8: ten tools
groove(17.3, 22.1, { busy: true })
for (let i = 0; i < 10; i++) pop(17.45 + i * .1, .14, 800 + i * 70, 420 + i * 20)
whoosh(21.5, .5, .22)
// 22.2-25.3: three beats
;[22.2, 23.3, 24.35].forEach((c, i) => { boom(c, .45); thud(c, .4); pop(c + .02, .16, 900 + i * 150, 450) })
// 25.4-29.4: one line to install
pad(25.4, 29.5, [57, 60, 64, 69], .03, .2, .3)
for (let i = 0; i < 54; i++) click(25.8 + i * (1.6 / 54), .1)
chime(27.7); riser(28.7, .9, .22)
// 29.6-34: the end card
boom(29.6, .65); sparkle(29.7, .06); pad(29.6, 33.4, [45, 57, 64, 69, 72], .04, .2, .5); pluck(29.8, 81, .06, 3, 0, .7)
/* reverb */
const taps = [[0.037, 0.5], [0.061, 0.42], [0.097, 0.36], [0.141, 0.3], [0.199, 0.24], [0.271, 0.19], [0.37, 0.14], [0.5, 0.1], [0.66, 0.07]]
let dl = 0, dr = 0
for (let i = 0; i < N; i++) {
  let l = 0, r = 0
  for (const [d, g] of taps) { const j = i - Math.floor(d * SR); if (j >= 0) { l += VR[j] * g; r += VL[j] * g } }
  dl += 0.4 * (l - dl); dr += 0.4 * (r - dr); L[i] += dl * 0.7; R[i] += dr * 0.7
}
/* master */
let peak = 0
for (let i = 0; i < N; i++) { const t = i / SR, f = seg(t, 0, 0.05) * (1 - seg(t, DUR - 1, DUR)); L[i] = Math.tanh(L[i] * 1.1) * f; R[i] = Math.tanh(R[i] * 1.1) * f; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])) }
const g = 0.9 / peak, buf = Buffer.alloc(44 + N * 4)
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40)
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4) }
fs.writeFileSync(process.argv[2] || 'music.wav', buf)
console.log('wrote', process.argv[2], 'peak', peak.toFixed(2))
