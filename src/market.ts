// Prices from public APIs: SOL/USD (Coinbase, then DexScreener) and DexScreener pairs for coins that left the curve.
let solUsd = 0, solAt = 0
export async function solPrice(): Promise<number> {
  if (Date.now() - solAt < 60_000 && solUsd) return solUsd
  try {
    const j: any = await (await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(6000) })).json()
    const p = +j?.data?.amount; if (p > 0) { solUsd = p; solAt = Date.now(); return p }
  } catch {}
  try {
    const p = await dexPairs(['So11111111111111111111111111111111111111112'])
    const best = p.find((x) => x.quoteToken?.symbol === 'USDC'); if (best) { solUsd = +(best.priceUsd || 0); solAt = Date.now() }
  } catch {}
  return solUsd
}

export interface DexPair { pairAddress: string; dexId: string; baseToken: { address: string; name: string; symbol: string }; quoteToken: { address: string; symbol: string }; priceUsd?: string; priceNative?: string; marketCap?: number; fdv?: number; liquidity?: { usd: number }; volume?: Record<string, number>; txns?: Record<string, { buys: number; sells: number }>; priceChange?: Record<string, number>; pairCreatedAt?: number; info?: { websites?: { url: string }[]; socials?: { type: string; url: string }[] }; url?: string }
export async function dexPairs(mints: string[]): Promise<DexPair[]> {
  const out: DexPair[] = []
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mints.slice(i, i + 30).join(','), { signal: AbortSignal.timeout(8000) })
      if (r.ok) out.push(...((await r.json()) as DexPair[]))
    } catch {}
  }
  return out
}
// the most liquid pair where the coin is the base
export function bestPair(pairs: DexPair[], mint: string) {
  return pairs.filter((p) => p.baseToken?.address === mint).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
}
export async function dexSearch(q: string): Promise<DexPair[]> {
  const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) })
  if (!r.ok) return []
  const j: any = await r.json()
  return ((j.pairs || []) as DexPair[]).filter((p: any) => p.chainId === 'solana')
}

export const usd = (v: number) => {
  if (!isFinite(v)) return '-'
  const a = Math.abs(v), s = v < 0 ? '-$' : '$'
  return a >= 1e9 ? s + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? s + (a / 1e3).toFixed(1) + 'K' : a >= 1 ? s + a.toFixed(2) : s + a.toPrecision(3)
}
export const sol = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4)) + ' SOL'
export const short = (k: string) => (k && k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : k)
export const ago = (ms: number) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? (s / 3600).toFixed(1) + 'h' : (s / 86400).toFixed(1) + 'd' }
