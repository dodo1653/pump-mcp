#!/usr/bin/env node
// pump.fun for AI assistants: an MCP server that lets Claude, Cursor or any MCP client read and trade pump.fun.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { rpc, getCurve, decodeCurve, curvePrice, curveProgress, curveAddress, tokenMeta, launchJson, solBalance, tokenHoldings, eventsFromLogs, PUMP_PROGRAM, RPC_URL, log } from './chain.js'
import { solPrice, dexPairs, bestPair, dexSearch, usd, sol, short, ago } from './market.js'
import { launches, feed, startFeed, stats } from './stream.js'
import { cfg, loadWallet, walletStatus, tradeGate, buy, sell, claimCreatorFees, launch } from './trade.js'

const VERSION = '0.1.0'
const server = new McpServer({ name: 'pump-mcp', version: VERSION })
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })
const isKey = (s: string) => { try { new PublicKey(s); return true } catch { return false } }
const pct = (v: number) => (isFinite(v) ? (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%' : '-')
const guard = (fn: (a: any) => Promise<any>) => async (a: any) => { try { return await fn(a) } catch (e: any) { log(e); return fail(String(e?.message || e)) } }

// ---------------------------------------------------------------- read tools
server.registerTool('pump_new_launches', {
  title: 'New pump.fun launches',
  description: 'Coins launched on pump.fun since this server started watching (live from the chain), with market cap, bonding-curve progress, buys/sells, unique buyers, the dev\'s holding and whether the dev sold, and bundle buys in the launch block. Sort by newest, hot (net SOL in from buyers other than the dev over the last 5 minutes) or mcap.',
  inputSchema: { limit: z.number().int().min(1).max(50).default(10), sort: z.enum(['newest', 'hot', 'mcap']).default('newest'), min_mcap_usd: z.number().min(0).default(0), hide_dev_sold: z.boolean().default(false) },
  annotations: { readOnlyHint: true },
}, guard(async ({ limit, sort, min_mcap_usd, hide_dev_sold }) => {
  // the feed only knows what it has seen: right after start, give it up to 25 s to gather launches
  for (let i = 0; i < 50 && (!feed.since || Date.now() - feed.since < 25_000) && launches.size < limit * 3; i++) await new Promise((r) => setTimeout(r, 500))
  const su = await solPrice()
  let list = [...launches.values()].map((c) => ({ c, s: stats(c, su) })).filter(({ s }) => s.mcUsd >= min_mcap_usd).filter(({ s }) => !hide_dev_sold || !s.devSold)
  if (sort === 'newest') list.sort((a, b) => b.c.createdAt - a.c.createdAt)
  if (sort === 'hot') list.sort((a, b) => b.s.netSol5m - a.s.netSol5m)
  if (sort === 'mcap') list.sort((a, b) => b.s.mcUsd - a.s.mcUsd)
  list = list.slice(0, limit)
  if (!list.length) return text(feed.connected ? `No launches match yet. Watching for ${ago(feed.since)} (${feed.launchesSeen} launches seen).` : 'The live feed is not connected yet' + (feed.lastError ? ': ' + feed.lastError : '') + '. Try again in a few seconds.')
  const rows = list.map(({ c, s }) => `$${c.symbol} (${c.name}) ${c.mint}\n  ${ago(c.createdAt)} old · MC ${usd(s.mcUsd)} · curve ${pct(s.progress)}${c.complete ? ' GRADUATED' : ''} · ${c.buys} buys / ${c.sells} sells · ${c.buyers.size} buyers · 5m net ${s.netSol5m >= 0 ? '+' : ''}${s.netSol5m.toFixed(2)} SOL\n  dev ${short(c.creator)} holds ${pct(s.devPct)}${s.devSold ? ' (DEV SOLD ' + sol(c.devSoldSol) + ')' : ''}${c.bundle.size ? ` · ${c.bundle.size} wallets bought in the launch block (${pct(s.bundlePct)})` : ''}`)
  return text(`${list.length} launches (watching for ${ago(feed.since)}, SOL ${usd(su)}):\n\n` + rows.join('\n\n'))
}))

server.registerTool('pump_coin', {
  title: 'Coin details',
  description: 'Everything about one pump.fun coin by its mint address (CA): name, description and socials from its launch metadata, price and market cap, bonding-curve progress or its DEX pair after graduation, volume, top-holder concentration, the dev\'s wallet and holding, and live activity if it launched while this server was watching.',
  inputSchema: { mint: z.string().describe('the coin\'s mint address (CA)') },
  annotations: { readOnlyHint: true },
}, guard(async ({ mint }) => {
  if (!isKey(mint)) return fail('That is not a valid Solana address.')
  const metaP = tokenMeta(mint), jsP = metaP.then((m) => (m?.uri ? launchJson(m.uri) : null))
  const [su, curve, meta, js, supplyRes, largest] = await Promise.all([solPrice(), getCurve(mint), metaP, jsP, rpc('getTokenSupply', [mint]).catch(() => null), rpc('getTokenLargestAccounts', [mint], 1).catch(() => null)])
  if (!supplyRes) return fail('No token found at that address.')
  const supply = +supplyRes.value.uiAmount || 1e9
  const out: string[] = [`$${meta?.symbol || '?'} · ${meta?.name || 'unknown'} · ${mint}`]
  if (js?.description) out.push(`About: ${String(js.description).slice(0, 400)}`)
  const links = [js?.website && 'website ' + js.website, js?.twitter && 'X ' + js.twitter, js?.telegram && 'telegram ' + js.telegram].filter(Boolean)
  out.push(links.length ? 'Links: ' + links.join(' · ') : 'Links: none in its launch metadata')
  let creator = curve?.creator || null
  if (curve && !curve.complete && curve.solQuoted) {
    const p = curvePrice(curve)
    out.push(`On the bonding curve: price ${p.toPrecision(4)} SOL · MC ${usd(p * supply * su)} (${sol(p * supply)}) · curve ${pct(curveProgress(curve))} · ${sol(curve.rSol)} in the curve`)
  } else {
    const pair = bestPair(await dexPairs([mint]), mint)
    const mcap = pair ? pair.marketCap || pair.fdv || 0 : 0
    if (pair && mcap > 0 && (pair.liquidity?.usd || 0) < mcap * 0.02) out.push(`WARNING: liquidity is only ${usd(pair.liquidity?.usd || 0)} against a ${usd(mcap)} market cap. The price is not real: almost nothing can be sold into this pool. Often a fake copy of another coin.`)
    if (pair) out.push(`${curve?.complete ? 'Graduated, trading' : 'Trading'} on ${pair.dexId}: price ${usd(+(pair.priceUsd || 0))} · MC ${usd(pair.marketCap || pair.fdv || 0)} · liquidity ${usd(pair.liquidity?.usd || 0)} · 24h vol ${usd(pair.volume?.h24 || 0)} · 24h ${pair.priceChange?.h24 ?? 0}% · 1h ${pair.priceChange?.h1 ?? 0}% · 24h txns ${pair.txns?.h24?.buys ?? 0} buys / ${pair.txns?.h24?.sells ?? 0} sells`)
    else if (curve && !curve.solQuoted) out.push('This coin\'s curve is not priced in SOL; no SOL price shown.')
    else out.push('No market found for it.')
  }
  // holders: the 20 largest token accounts, with their owners (the curve's own account is the unsold supply, not a holder)
  if (largest?.value?.length) {
    const accs = largest.value.slice(0, 20)
    const owners: any = await rpc('getMultipleAccounts', [accs.map((a: any) => a.address), { encoding: 'jsonParsed' }]).catch(() => null)
    const curveAcc = curveAddress(mint)
    const rows = accs.map((a: any, i: number) => ({ owner: owners?.value?.[i]?.data?.parsed?.info?.owner || '?', amt: +a.uiAmount || 0 }))
    const holders = rows.filter((r: any) => r.owner !== curveAcc)
    const top10 = holders.slice(0, 10).reduce((s: number, r: any) => s + r.amt, 0) / supply * 100
    out.push(`Top 10 holders own ${pct(top10)} of supply (curve excluded). Largest: ${holders.slice(0, 5).map((r: any) => `${short(r.owner)} ${pct(r.amt / supply * 100)}`).join(', ')}`)
    if (creator) { const d = holders.find((r: any) => r.owner === creator); out.push(`Dev ${creator} ${d ? 'holds ' + pct(d.amt / supply * 100) : 'is not among the top 20 holders'}`) }
  } else if (creator) out.push(`Dev ${creator}`)
  const live = launches.get(mint)
  if (live) {
    const s = stats(live, su)
    out.push(`Live since launch (${ago(live.createdAt)} ago): ${live.buys} buys / ${live.sells} sells, ${live.buyers.size} buyers, ${sol(live.volSol)} volume, 5m net from non-dev wallets ${s.netSol5m.toFixed(2)} SOL. Dev bought ${sol(live.devBoughtSol)}${live.devSoldSol ? ', sold ' + sol(live.devSoldSol) : ', has not sold'}.${live.bundle.size ? ` ${live.bundle.size} wallets bought in the launch block (${pct(s.bundlePct)} of supply).` : ''}`)
  }
  out.push(`pump.fun: https://pump.fun/coin/${mint}`)
  return text(out.join('\n'))
}))

server.registerTool('pump_dev_history', {
  title: 'Dev history',
  description: 'The coins a wallet has launched on pump.fun (from its recent on-chain history) and how each one is doing now: graduated, still on the curve, or dead. Pass a wallet, or a coin\'s mint to check that coin\'s dev.',
  inputSchema: { wallet: z.string().optional(), mint: z.string().optional(), scan: z.number().int().min(20).max(1000).default(150).describe('how many of the wallet\'s latest transactions to scan') },
  annotations: { readOnlyHint: true },
}, guard(async ({ wallet, mint, scan }) => {
  if (!wallet && mint) { const c = await getCurve(mint); wallet = c?.creator || launches.get(mint)?.creator || undefined; if (!wallet) return fail('Could not find that coin\'s dev from its curve.') }
  if (!wallet || !isKey(wallet)) return fail('Pass a wallet address or a coin mint.')
  const sigs: any[] = await rpc('getSignaturesForAddress', [wallet, { limit: Math.min(1000, scan) }])
  const ok = sigs.filter((s) => !s.err)
  const created: { mint: string; symbol: string; name: string; t: number }[] = []
  let i = 0
  const until = Date.now() + 25_000                       // answer within ~25 s even on a slow RPC; say how far it got
  const worker = async () => {
    while (i < ok.length && Date.now() < until) {
      const s = ok[i++]
      try {
        const t: any = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }])
        for (const e of eventsFromLogs(t?.meta?.logMessages || [])) if (e.kind === 'create' && (e.creator === wallet || e.user === wallet)) created.push({ mint: e.mint, symbol: e.symbol, name: e.name, t: (s.blockTime || 0) * 1000 })
      } catch {}
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  const scanned = Math.min(i, ok.length)
  if (!created.length) return text(`${wallet} launched no pump.fun coins in its last ${scanned} transactions${scanned < ok.length ? ` (stopped at ${scanned} of ${ok.length} on time; a faster RPC scans more)` : ''}.`)
  const su = await solPrice()
  const curves: any = await rpc('getMultipleAccounts', [created.map((c) => curveAddress(c.mint)), { encoding: 'base64' }])
  const cv = new Map(created.map((c, k) => [c.mint, curves?.value?.[k] ? decodeCurve(Buffer.from(curves.value[k].data[0], 'base64')) : null]))
  const grads = created.filter((c) => cv.get(c.mint)?.complete).map((c) => c.mint)
  const pairs = grads.length ? await dexPairs(grads) : []
  const rows = created.sort((a, b) => b.t - a.t).map((c) => {
    const k = cv.get(c.mint)
    if (!k) return `$${c.symbol} ${c.mint} · ${ago(c.t)} ago · no curve found`
    if (k.complete) { const p = bestPair(pairs, c.mint); return `$${c.symbol} ${c.mint} · ${ago(c.t)} ago · GRADUATED · MC now ${p ? usd(p.marketCap || p.fdv || 0) : '?'}` }
    const mc = curvePrice(k) * 1e9 * su
    return `$${c.symbol} ${c.mint} · ${ago(c.t)} ago · on the curve ${pct(curveProgress(k))} · MC ${usd(mc)}${mc < 6000 && Date.now() - c.t > 3_600_000 ? ' (dead)' : ''}`
  })
  return text(`${wallet} launched ${created.length} coin(s) in its last ${ok.length} transactions, ${grads.length} graduated:\n` + rows.join('\n'))
}))

server.registerTool('pump_wallet', {
  title: 'Wallet',
  description: 'SOL balance and token holdings of a wallet with their value (curve price or DEX price). With no address, the wallet this server trades with.',
  inputSchema: { address: z.string().optional() },
  annotations: { readOnlyHint: true },
}, guard(async ({ address }) => {
  const addr = address || loadWallet()?.publicKey.toBase58()
  if (!addr || !isKey(addr)) return fail('Pass an address, or set PUMP_WALLET_KEY to see your own wallet.')
  const [su, bal, hold] = await Promise.all([solPrice(), solBalance(addr), tokenHoldings(addr)])
  const merged = new Map<string, number>(); for (const h of hold) merged.set(h.mint, (merged.get(h.mint) || 0) + h.amount)
  for (const [m, v] of merged) if (v < 1) merged.delete(m)   // dust left after selling
  const mints = [...merged.keys()].slice(0, 60)
  const curves: any = mints.length ? await rpc('getMultipleAccounts', [mints.map(curveAddress), { encoding: 'base64' }]) : { value: [] }
  const need: string[] = [], price = new Map<string, number>()
  mints.forEach((m, k) => { const raw = curves.value?.[k]; const cv = raw && decodeCurve(Buffer.from(raw.data[0], 'base64')); if (cv && !cv.complete && cv.solQuoted) price.set(m, curvePrice(cv) * su); else need.push(m) })
  const pairs = need.length ? await dexPairs(need) : []
  const names = new Map<string, string>()
  for (const m of need) { const p = bestPair(pairs, m); if (p) { price.set(m, +(p.priceUsd || 0)); names.set(m, p.baseToken.symbol) } }
  for (const m of mints) if (!names.has(m)) names.set(m, launches.get(m)?.symbol || '')
  const rows = mints.map((m) => ({ m, amt: merged.get(m)!, v: (price.get(m) || 0) * merged.get(m)! })).sort((a, b) => b.v - a.v)
  const total = rows.reduce((s, r) => s + r.v, 0)
  return text(`${addr}\nSOL ${bal.toFixed(4)} (${usd(bal * su)}) · tokens ${usd(total)} · total ${usd(total + bal * su)}\n` + rows.slice(0, 25).map((r) => `${names.get(r.m) ? '$' + names.get(r.m) : short(r.m)} ${r.m} · ${r.amt.toLocaleString('en-US', { maximumFractionDigits: 0 })} · ${r.v ? usd(r.v) : 'no price'}`).join('\n'))
}))

server.registerTool('pump_search', {
  title: 'Search coins',
  description: 'Search Solana coins by name, ticker or address (DexScreener). Returns the most liquid matches with market cap, volume and age.',
  inputSchema: { query: z.string().min(1) },
  annotations: { readOnlyHint: true },
}, guard(async ({ query }) => {
  const pairs = (await dexSearch(query)).sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0)).slice(0, 10)
  if (!pairs.length) return text('Nothing found.')
  return text(pairs.map((p) => `$${p.baseToken.symbol} (${p.baseToken.name}) ${p.baseToken.address}\n  ${p.dexId} · MC ${usd(p.marketCap || p.fdv || 0)} · 24h vol ${usd(p.volume?.h24 || 0)} · 24h ${p.priceChange?.h24 ?? 0}% · ${p.pairCreatedAt ? ago(p.pairCreatedAt) + ' old' : ''}`).join('\n'))
}))

server.registerTool('pump_status', {
  title: 'Server status',
  description: 'This server\'s setup: the live feed, the RPC, the wallet, whether trading is on and its limits.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, guard(async () => {
  const w = loadWallet()
  return text([`pump-mcp ${VERSION}`, `RPC ${RPC_URL.replace(/api-key=[^&]+/, 'api-key=…')}`,
    `Live feed: ${feed.connected ? 'connected' : 'not connected'}${feed.since ? `, watching for ${ago(feed.since)}, ${feed.launchesSeen} launches seen` : ''}${feed.lastError ? ' (last error: ' + feed.lastError + ')' : ''}`,
    `Wallet: ${walletStatus()}${w ? ' · ' + (await solBalance(w.publicKey.toBase58())).toFixed(4) + ' SOL' : ''}`,
    `Trading: ${cfg.trading ? 'ON' : 'off'} · max ${cfg.maxSol} SOL per trade · slippage ${cfg.slippage}% · priority fee ${cfg.priorityFee} SOL`].join('\n'))
}))

// ---------------------------------------------------------------- write tools (real money: off unless the user switches them on)
const W = { destructiveHint: true, openWorldHint: true }
server.registerTool('pump_buy', {
  title: 'Buy a coin',
  description: 'Buy a pump.fun coin with SOL from this server\'s wallet (bonding curve or its DEX pool after graduation). REAL MONEY: confirm the coin and the amount with the user before calling. The trade is simulated first and only sent if it would succeed. Capped by PUMP_MAX_SOL_PER_TRADE.',
  inputSchema: { mint: z.string(), sol: z.number().positive(), slippage_pct: z.number().min(0.5).max(50).optional() },
  annotations: W,
}, guard(async ({ mint, sol: amt, slippage_pct }) => {
  const g = tradeGate(); if (g) return fail(g)
  if (!isKey(mint)) return fail('That is not a valid mint address.')
  const r = await buy(mint, amt, slippage_pct)
  return text(`Bought. ${isFinite(r.tokenChange) ? `+${r.tokenChange.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens for ${sol(-r.solChange)} (fees included). ` : ''}${r.url}`)
}))
server.registerTool('pump_sell', {
  title: 'Sell a coin',
  description: 'Sell a coin from this server\'s wallet. amount is a percentage like "100%" or "50%", or a token count like "250000". REAL MONEY: confirm with the user first. Simulated before sending.',
  inputSchema: { mint: z.string(), amount: z.string().default('100%'), slippage_pct: z.number().min(0.5).max(50).optional() },
  annotations: W,
}, guard(async ({ mint, amount, slippage_pct }) => {
  const g = tradeGate(); if (g) return fail(g)
  if (!isKey(mint)) return fail('That is not a valid mint address.')
  if (!/^(\d+(\.\d+)?%|\d+(\.\d+)?)$/.test(amount)) return fail('amount must be like "100%" or a token count like "250000".')
  const r = await sell(mint, amount, slippage_pct)
  return text(`Sold. ${isFinite(r.tokenChange) ? `${r.tokenChange.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens for +${sol(r.solChange)} (fees included). ` : ''}${r.url}`)
}))
server.registerTool('pump_claim_creator_fees', {
  title: 'Claim creator fees',
  description: 'Claim all pump.fun creator fees owed to this server\'s wallet (for coins it launched).',
  inputSchema: {},
  annotations: W,
}, guard(async () => {
  const g = tradeGate(); if (g) return fail(g)
  const r = await claimCreatorFees()
  return text(`Claimed${isFinite(r.solChange) ? ' ' + sol(r.solChange + r.feeSol) : ''}. ${r.url}`)
}))
server.registerTool('pump_launch', {
  title: 'Launch a coin',
  description: 'Launch a new coin on pump.fun from this server\'s wallet: uploads the image and metadata to IPFS (needs PINATA_JWT), creates the coin and makes the dev buy. REAL MONEY and public: confirm every field with the user first.',
  inputSchema: { name: z.string().min(1).max(32), symbol: z.string().min(1).max(10), description: z.string().max(1000), image: z.string().describe('a local file path or an https URL of the coin image'), twitter: z.string().optional(), telegram: z.string().optional(), website: z.string().optional(), dev_buy_sol: z.number().min(0).default(0) },
  annotations: W,
}, guard(async (a) => {
  const g = tradeGate(); if (g) return fail(g)
  const r = await launch({ ...a, devBuySol: a.dev_buy_sol })
  return text(`Launched $${a.symbol}: ${r.mint}\nhttps://pump.fun/coin/${r.mint}\n${r.url}`)
}))

// ---------------------------------------------------------------- start
startFeed()
loadWallet()
await server.connect(new StdioServerTransport())
log(`ready · rpc ${RPC_URL.replace(/api-key=[^&]+/, 'api-key=…')} · wallet ${walletStatus()} · trading ${cfg.trading ? 'ON' : 'off'}`)
