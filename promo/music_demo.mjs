// PUMPMCP demo cut: a quiet bed + real key clicks timed to the typing (same timeline as demo.html).
// usage: node promo/music_demo.mjs promo/out/music_demo.wav
import fs from 'node:fs'
const S = JSON.parse(fs.readFileSync(new URL('./session2.json', import.meta.url)))
const T0 = 3.2, blocks = []; let t = T0
S.turns.forEach((turn, ti) => { for (const b of turn) {
  if (b.type === 'user') { const d = b.text.length / 30; blocks.push({ ...b, a: t, d }); t += d + .45 + 1.1 }
  else if (b.type === 'tool') { blocks.push({ ...b, a: t }); t += 1.7 }
  else { const d = Math.max(1.6, b.text.split(/(\s+)/).length / 2 / 34); blocks.push({ ...b, a: t, d }); t += d + (ti === 2 ? 3.4 : 3.6) }
} })
const T_END = t, DUR = Math.ceil(T_END + 5.5)
const SR = 44100, N = SR * DUR, TAU = Math.PI * 2, L = new Float32Array(N), R = new Float32Array(N)
let seed = 7; const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12)
const add = (i, v, pan = 0) => { i |= 0; if (i < 0 || i >= N) return; L[i] += v * (1 - pan) ; R[i] += v * (1 + pan) }
// a warm, slow pad: detuned saws through a soft lowpass
function pad(t0, t1, notes, amp) { notes.forEach((m, ni) => { let p1 = 0, p2 = 0, y = 0; const f = mtof(m)
  for (let i = (t0 * SR) | 0; i < Math.min(N, (t1 + 2) * SR); i++) { const tt = i / SR, env = Math.min(1, (tt - t0) / 2) * (tt > t1 ? Math.max(0, 1 - (tt - t1) / 2) : 1)
    p1 += f / SR; p2 += f * 1.004 / SR; y += .018 * (((p1 % 1) * 2 - 1) + ((p2 % 1) * 2 - 1) - y); add(i, y * env * amp, ni % 2 ? .3 : -.3) } }) }
// a soft felt-piano note
function note(t0, m, amp) { const f = mtof(m); let y = 0; for (let k = 0; k < 3 * SR; k++) { const tt = k / SR; let v = Math.sin(tt * f * TAU) + .25 * Math.sin(tt * f * 2 * TAU) * Math.exp(-tt * 6); y += .3 * (v - y); add(t0 * SR + k, y * Math.exp(-tt * 1.6) * Math.min(1, tt * 200) * amp, (m % 7) / 10 - .3) } }
// a keyboard click: a short filtered tick, slightly different every time
function key(t0, amp) { const f = 1800 + noise() * 500; let p = 0; for (let k = 0; k < .025 * SR; k++) { const tt = k / SR, n = noise(), hp = n - p * .7; p = n; add(t0 * SR + k, (hp * .6 + Math.sin(tt * TAU * f) * .4) * Math.exp(-tt * 240) * amp, .1) } }
const CH = [[45, 52, 57, 60, 64], [41, 48, 53, 57, 64], [43, 50, 55, 59, 62], [40, 47, 52, 55, 59]]
for (let k = 0, s = 0; s < DUR; k++, s += 8) pad(s, s + 8, CH[k % 4], .018)
for (let k = 0, s = 2; s < DUR - 4; k++, s += 2) { const c = CH[Math.floor(s / 8) % 4]; note(s, c[2 + (k % 3)] + 12, .05); if (k % 2) note(s + 1, c[4] + 12, .03) }
for (const b of blocks) if (b.type === 'user') { for (let i = 0; i < b.text.length; i++) key(b.a + i / 30 + (noise() * .012), .16 + noise() * .03); key(b.a + b.d + .32, .24) }   // ...and Enter
note(.4, 69, .07); note(T_END + .3, 69, .06); note(T_END + .45, 76, .05)
let peak = 0
for (let i = 0; i < N; i++) { const tt = i / SR, f = Math.min(1, tt / .8) * Math.min(1, (DUR - tt) / 1.5); L[i] = Math.tanh(L[i]) * f; R[i] = Math.tanh(R[i]) * f; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])) }
const g = .7 / peak, buf = Buffer.alloc(44 + N * 4)
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40)
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4) }
fs.writeFileSync(process.argv[2], buf); console.log('wrote', process.argv[2], DUR + ' s')
