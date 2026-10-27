// node set_ca.mjs <CA>  -> writes site/project.config.js, commits and pushes (Vercel shows it within a minute)
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const CA = process.argv[2]
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(CA || '')) { console.log('usage: node set_ca.mjs <CA>'); process.exit(1) }
const dir = fileURLToPath(new URL('.', import.meta.url))
const src = fs.readFileSync(dir + 'site/project.config.js', 'utf8').replace(/mint: '[^']*'/, `mint: '${CA}'`)
fs.writeFileSync(dir + 'site/project.config.js', src)
const run = (c) => execSync(c, { cwd: dir, stdio: 'inherit' })
run('git add site/project.config.js')
run(`git -c user.name="dodo1653" -c user.email="sameh.mohsen.78@gmail.com" commit -q -m "Set the CA: ${CA}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`)
run('git push -q origin main')
console.log('pushed: the CA shows on the site within a minute')
