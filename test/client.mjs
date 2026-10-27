import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const t = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env, ...(JSON.parse(process.env.EXTRA_ENV || '{}')) }, stderr: 'inherit' })
const c = new Client({ name: 'test', version: '1' }); await c.connect(t)
const tools = await c.listTools(); console.log('TOOLS:', tools.tools.map((x) => x.name).join(', '))
const call = async (name, args = {}) => { const t0 = Date.now(); const r = await c.callTool({ name, arguments: args }); console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}\n` + r.content.map((x) => x.text).join('\n')) }
for (const [n, a, wait] of JSON.parse(process.argv[2])) { if (wait) await new Promise((r) => setTimeout(r, wait)); await call(n, a) }
await c.close(); process.exit(0)
