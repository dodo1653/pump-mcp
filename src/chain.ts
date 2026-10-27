// Solana + pump.fun reading: RPC calls, the bonding curve, pump.fun's own events, token metadata.
import { PublicKey } from '@solana/web3.js'

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
export const WS_URL = process.env.SOLANA_WS_URL || RPC_URL.replace(/^http/, 'ws')

const INITIAL_REAL_TOKENS = 793_100_000          // tokens a fresh curve sells before it graduates
const VIRTUAL_SOL_START = 30                     // a SOL curve starts with 30 virtual SOL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const log = (...a: unknown[]) => console.error('[pump-mcp]', ...a)   // stdout belongs to the MCP protocol

// ---------------------------------------------------------------- JSON-RPC with backoff (the public endpoint rate-limits)
let rpcId = 0
export async function rpc<T = any>(method: string, params: unknown[] = [], tries = 5): Promise<T> {
  let wait = 400
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(20000) })
      if (r.status === 429 || r.status >= 500) throw new Error('rpc http ' + r.status)
      const j: any = await r.json()
      if (j.error) {
        if (/rate|429|too many/i.test(j.error.message || '') && i < tries) throw new Error(j.error.message)
        const e: any = new Error(`${method}: ${j.error.message}`); e.final = true; throw e
      }
      return j.result as T
    } catch (e: any) {
      if (e.final || i >= tries) throw e
      await sleep(wait); wait = Math.min(wait * 2, 6000)
    }
  }
}

// ---------------------------------------------------------------- byte reader for borsh-encoded accounts and events
export class Reader {
  o = 0
  constructor(public b: Buffer) {}
  u8() { return this.b[this.o++] }
  bool() { return this.u8() === 1 }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v }
  key() { const k = new PublicKey(this.b.subarray(this.o, this.o + 32)).toBase58(); this.o += 32; return k }
  str() { const n = this.b.readUInt32LE(this.o); this.o += 4; const s = this.b.subarray(this.o, this.o + n).toString('utf8'); this.o += n; return s.replace(/\0+$/, '') }
  left() { return this.b.length - this.o }
}

// ---------------------------------------------------------------- the bonding curve
export function curveAddress(mint: string) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58()
}
export interface Curve { vTok: number; vSol: number; rTok: number; rSol: number; supply: number; complete: boolean; creator: string | null; solQuoted: boolean }
export function decodeCurve(b: Buffer): Curve {
  const r = new Reader(b); r.o = 8
  const vTok = Number(r.u64()) / 1e6, vSol = Number(r.u64()) / 1e9, rTok = Number(r.u64()) / 1e6, rSol = Number(r.u64()) / 1e9, supply = Number(r.u64()) / 1e6
  const complete = r.bool()
  const creator = r.left() >= 32 ? r.key() : null
  return { vTok, vSol, rTok, rSol, supply, complete, creator, solQuoted: Math.abs(vSol - rSol - VIRTUAL_SOL_START) < 0.5 }
}
export const curvePrice = (c: { vSol: number; vTok: number }) => (c.vTok > 0 ? c.vSol / c.vTok : 0)          // SOL per token
export const curveProgress = (c: { rTok: number; complete: boolean }) => (c.complete ? 100 : Math.max(0, Math.min(100, (1 - c.rTok / INITIAL_REAL_TOKENS) * 100)))

export async function getCurve(mint: string): Promise<Curve | null> {
  const res: any = await rpc('getAccountInfo', [curveAddress(mint), { encoding: 'base64' }])
  if (!res?.value) return null
  return decodeCurve(Buffer.from(res.value.data[0], 'base64'))
}

// ---------------------------------------------------------------- pump.fun events (anchor: sha256("event:<Name>")[0..8] + borsh)
import { createHash } from 'node:crypto'
const disc = (n: string) => createHash('sha256').update('event:' + n).digest().subarray(0, 8).toString('hex')
const D_CREATE = disc('CreateEvent'), D_TRADE = disc('TradeEvent'), D_COMPLETE = disc('CompleteEvent')

export interface CreateEv { kind: 'create'; name: string; symbol: string; uri: string; mint: string; curve: string; user: string; creator: string; ts: number; vTok: number; vSol: number; rTok: number; supply: number }
export interface TradeEv { kind: 'trade'; mint: string; sol: number; tokens: number; buy: boolean; user: string; ts: number; vSol: number; vTok: number; rSol: number; rTok: number }
export interface CompleteEv { kind: 'complete'; mint: string }
export type PumpEv = CreateEv | TradeEv | CompleteEv

export function decodeEvent(b64: string): PumpEv | null {
  const b = Buffer.from(b64, 'base64'); if (b.length < 8) return null
  const d = b.subarray(0, 8).toString('hex'), r = new Reader(b); r.o = 8
  try {
    if (d === D_CREATE) {
      const name = r.str(), symbol = r.str(), uri = r.str(), mint = r.key(), curve = r.key(), user = r.key(), creator = r.key(), ts = Number(r.i64())
      return { kind: 'create', name, symbol, uri, mint, curve, user, creator, ts, vTok: Number(r.u64()) / 1e6, vSol: Number(r.u64()) / 1e9, rTok: Number(r.u64()) / 1e6, supply: Number(r.u64()) / 1e6 }
    }
    if (d === D_TRADE) {
      const mint = r.key(), sol = Number(r.u64()) / 1e9, tokens = Number(r.u64()) / 1e6, buy = r.bool(), user = r.key(), ts = Number(r.i64())
      return { kind: 'trade', mint, sol, tokens, buy, user, ts, vSol: Number(r.u64()) / 1e9, vTok: Number(r.u64()) / 1e6, rSol: Number(r.u64()) / 1e9, rTok: Number(r.u64()) / 1e6 }
    }
    if (d === D_COMPLETE) { r.key(); return { kind: 'complete', mint: r.key() } }   // user, then mint
  } catch { /* a newer layout we don't know: skip it */ }
  return null
}
export function eventsFromLogs(logs: string[]): PumpEv[] {
  const out: PumpEv[] = []
  for (const l of logs) if (l.startsWith('Program data: ')) { const e = decodeEvent(l.slice(14)); if (e) out.push(e) }
  return out
}

// ---------------------------------------------------------------- token metadata: Token-2022 extension (new coins) or Metaplex (older coins)
export interface TokenMeta { name: string; symbol: string; uri: string }
export async function tokenMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const res: any = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }])
    const ext = res?.value?.data?.parsed?.info?.extensions as any[] | undefined
    const tm = ext?.find((e) => e.extension === 'tokenMetadata')?.state
    if (tm?.uri || tm?.name) return { name: tm.name, symbol: tm.symbol, uri: tm.uri }
  } catch {}
  try {
    const pda = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), new PublicKey(mint).toBuffer()], METAPLEX)[0]
    const res: any = await rpc('getAccountInfo', [pda.toBase58(), { encoding: 'base64' }])
    if (!res?.value) return null
    const r = new Reader(Buffer.from(res.value.data[0], 'base64')); r.o = 1 + 32 + 32
    return { name: r.str(), symbol: r.str(), uri: r.str() }
  } catch { return null }
}
// the launch JSON behind the uri: description, image, socials
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://pump.mypinata.cloud/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/']
export async function launchJson(uri: string): Promise<any | null> {
  if (!uri) return null
  const cid = uri.match(/\/ipfs\/([A-Za-z0-9]{40,80})/)?.[1] || uri.match(/^ipfs:\/\/([A-Za-z0-9]{40,80})/)?.[1]
  const urls = cid ? [...(uri.startsWith('http') ? [uri] : []), ...GATEWAYS.map((g) => g + cid)] : [uri]
  // race the gateways: the first good answer wins
  return await Promise.any(urls.map(async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(7000) }); if (!r.ok) throw new Error(); return r.json() })).catch(() => null)
}

// ---------------------------------------------------------------- balances
export async function solBalance(owner: string) { const r: any = await rpc('getBalance', [owner]); return (r?.value || 0) / 1e9 }
export interface Holding { mint: string; amount: number; program: string }
export async function tokenHoldings(owner: string): Promise<Holding[]> {
  const out: Holding[] = []
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    const r: any = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }])
    for (const a of r?.value || []) { const i = a.account.data.parsed.info; const amt = +i.tokenAmount.uiAmount || 0; if (amt > 0) out.push({ mint: i.mint, amount: amt, program: programId }) }
  }
  return out
}
export async function tokenBalance(owner: string, mint: string) {
  const h = await tokenHoldings(owner); return h.filter((x) => x.mint === mint).reduce((s, x) => s + x.amount, 0)
}
