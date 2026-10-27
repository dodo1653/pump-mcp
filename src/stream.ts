// The live feed: every pump.fun launch and trade, read from the program's own logs over the RPC websocket.
// Keeps the newest launches in memory with what happened to them since: buys, sells, buyers, the dev's moves, bundles.
import { WS_URL, PUMP_PROGRAM, eventsFromLogs, curvePrice, curveProgress, log } from './chain.js'

export interface Launch {
  mint: string; name: string; symbol: string; uri: string; creator: string; createdAt: number; slot: number
  vSol: number; vTok: number; rSol: number; rTok: number; complete: boolean
  buys: number; sells: number; volSol: number; buyers: Set<string>
  devTokens: number; devPeak: number; devSoldSol: number; devBoughtSol: number
  bundle: Set<string>; bundleTokens: number                     // other wallets that bought in the launch's own slot
  recent: { t: number; buy: boolean; sol: number; user: string }[]
  lastTrade: number
}
const KEEP = 600
export const launches = new Map<string, Launch>()
export const feed = { connected: false, since: 0, events: 0, launchesSeen: 0, lastError: '' }

let ws: WebSocket | null = null, backoff = 1000
export function startFeed() {
  if (ws) return
  try { ws = new WebSocket(WS_URL) } catch (e: any) { feed.lastError = String(e?.message || e); return retry() }
  ws.onopen = () => {
    backoff = 1000; feed.connected = true; if (!feed.since) feed.since = Date.now()
    ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM.toBase58()] }, { commitment: 'confirmed' }] }))
  }
  ws.onmessage = (m) => {
    let j: any; try { j = JSON.parse(String(m.data)) } catch { return }
    const v = j?.params?.result?.value; if (!v || v.err) return
    feed.events++
    const slot = j.params.result.context?.slot || 0
    for (const e of eventsFromLogs(v.logs || [])) {
      if (e.kind === 'create') {
        launches.set(e.mint, { mint: e.mint, name: e.name, symbol: e.symbol, uri: e.uri, creator: e.creator || e.user, createdAt: Date.now(), slot,
          vSol: e.vSol, vTok: e.vTok, rSol: 0, rTok: e.rTok, complete: false, buys: 0, sells: 0, volSol: 0, buyers: new Set(),
          devTokens: 0, devPeak: 0, devSoldSol: 0, devBoughtSol: 0, bundle: new Set(), bundleTokens: 0, recent: [], lastTrade: 0 })
        feed.launchesSeen++
        if (launches.size > KEEP) launches.delete(launches.keys().next().value!)
      } else if (e.kind === 'trade') {
        const c = launches.get(e.mint); if (!c) continue
        c.vSol = e.vSol; c.vTok = e.vTok; c.rSol = e.rSol; c.rTok = e.rTok; c.lastTrade = Date.now(); c.volSol += e.sol
        const dev = e.user === c.creator
        if (e.buy) { c.buys++; c.buyers.add(e.user) } else c.sells++
        if (dev) {
          if (e.buy) { c.devTokens += e.tokens; c.devBoughtSol += e.sol } else { c.devTokens = Math.max(0, c.devTokens - e.tokens); c.devSoldSol += e.sol }
          c.devPeak = Math.max(c.devPeak, c.devTokens)
        } else if (e.buy && slot === c.slot) { c.bundle.add(e.user); c.bundleTokens += e.tokens }
        c.recent.push({ t: Date.now(), buy: e.buy, sol: e.sol, user: e.user }); if (c.recent.length > 200) c.recent.shift()
      } else if (e.kind === 'complete') {
        const c = launches.get(e.mint); if (c) c.complete = true
      }
    }
  }
  ws.onerror = (e: any) => { feed.lastError = String(e?.message || 'websocket error') }
  ws.onclose = () => { feed.connected = false; ws = null; retry() }
}
function retry() { setTimeout(startFeed, backoff); backoff = Math.min(backoff * 2, 30000) }

// derived numbers for one launch
export function stats(c: Launch, solUsd: number) {
  const price = curvePrice(c), mcSol = price * 1e9
  const since = Date.now() - 5 * 60_000, r5 = c.recent.filter((x) => x.t >= since)
  return {
    priceSol: price, mcSol, mcUsd: mcSol * solUsd, progress: curveProgress(c),
    buys5m: r5.filter((x) => x.buy).length, sells5m: r5.filter((x) => !x.buy).length,
    netSol5m: r5.reduce((s, x) => s + (x.buy ? x.sol : -x.sol), 0),
    devPct: (c.devTokens / 1e9) * 100, devSold: c.devPeak > 0 && c.devTokens < c.devPeak * 0.5,
    bundlePct: (c.bundleTokens / 1e9) * 100,
  }
}
