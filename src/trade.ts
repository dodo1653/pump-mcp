// Trading: transactions are built by PumpPortal's Local Transaction API, signed HERE with the user's own key,
// simulated first, then sent through the user's RPC. The key never leaves this machine.
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import fs from 'node:fs'
import { rpc, log, tokenBalance, solBalance } from './chain.js'

export const cfg = {
  trading: /^(1|true|yes|on)$/i.test(process.env.PUMP_ALLOW_TRADING || ''),
  maxSol: +(process.env.PUMP_MAX_SOL_PER_TRADE || 0.5),
  slippage: +(process.env.PUMP_SLIPPAGE || 15),
  priorityFee: +(process.env.PUMP_PRIORITY_FEE || 0.0005),
}

let wallet: Keypair | null = null, walletError = ''
export function loadWallet(): Keypair | null {
  if (wallet || walletError) return wallet
  try {
    const raw = process.env.PUMP_WALLET_KEY?.trim() || (process.env.PUMP_WALLET_FILE ? fs.readFileSync(process.env.PUMP_WALLET_FILE, 'utf8').trim() : '')
    if (!raw) return null
    wallet = raw.startsWith('[') ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : Keypair.fromSecretKey(bs58.decode(raw))
  } catch (e: any) { walletError = 'could not read the wallet key: ' + (e?.message || e) }
  return wallet
}
export const walletStatus = () => (loadWallet() ? wallet!.publicKey.toBase58() : walletError || 'no wallet configured')

export function tradeGate(): string | null {
  if (!loadWallet()) return 'No wallet is set. Add PUMP_WALLET_KEY (base58) or PUMP_WALLET_FILE (a Solana CLI keypair file) to this MCP server\'s env.'
  if (!cfg.trading) return 'Trading is switched off. Set PUMP_ALLOW_TRADING=true in this MCP server\'s env to let the assistant trade.'
  return null
}

async function portal(body: Record<string, unknown>): Promise<VersionedTransaction> {
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  if (r.status !== 200) throw new Error('PumpPortal refused the trade: ' + r.status + ' ' + (await r.text()).slice(0, 200))
  return VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
}

export interface Sent { signature: string; url: string; solChange: number; tokenChange: number; feeSol: number }
async function signSimulateSend(tx: VersionedTransaction, signers: Keypair[], mint?: string): Promise<Sent> {
  tx.sign(signers)
  const raw = Buffer.from(tx.serialize()).toString('base64')
  const sim: any = await rpc('simulateTransaction', [raw, { encoding: 'base64', commitment: 'processed', replaceRecentBlockhash: false, sigVerify: false }])
  if (sim?.value?.err) {
    const me0 = signers[signers.length - 1].publicKey.toBase58()
    if (JSON.stringify(sim.value.err).includes('AccountNotFound') || (sim.value.logs || []).some((l: string) => /insufficient lamports|insufficient funds/i.test(l))) {
      throw new Error(`Not enough SOL in ${me0} for this (it has ${(await solBalance(me0)).toFixed(4)} SOL; trades also need about 0.003 SOL for fees and token accounts). Nothing was sent.`)
    }
    const why = (sim.value.logs || []).filter((l: string) => /error|failed|insufficient|slippage|exceed/i.test(l)).slice(-3).join(' | ')
    throw new Error('The transaction would fail, so it was not sent: ' + JSON.stringify(sim.value.err) + (why ? ' (' + why + ')' : ''))
  }
  const signature: string = await rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }])
  // wait for it to land (about 60 s at most)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const st: any = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: false }])
    const s = st?.value?.[0]
    if (s?.err) throw new Error('The transaction landed but failed: ' + JSON.stringify(s.err) + ' https://solscan.io/tx/' + signature)
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) break
    if (i === 39) return { signature, url: 'https://solscan.io/tx/' + signature, solChange: NaN, tokenChange: NaN, feeSol: NaN }
  }
  // what actually changed in the wallet
  const me = signers[signers.length - 1].publicKey.toBase58()
  let solChange = NaN, tokenChange = NaN, feeSol = NaN
  try {
    const t: any = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
    const keys = t.transaction.message.accountKeys.map((k: any) => k.pubkey || k)
    const i = keys.indexOf(me)
    if (i >= 0) solChange = (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9
    feeSol = t.meta.fee / 1e9
    if (mint) {
      const bal = (arr: any[]) => (arr || []).filter((b) => b.mint === mint && b.owner === me).reduce((s, b) => s + (+b.uiTokenAmount.uiAmount || 0), 0)
      tokenChange = bal(t.meta.postTokenBalances) - bal(t.meta.preTokenBalances)
    }
  } catch (e) { log('could not read the result', e) }
  return { signature, url: 'https://solscan.io/tx/' + signature, solChange, tokenChange, feeSol }
}

export async function buy(mint: string, solAmount: number, slippage = cfg.slippage) {
  if (!(solAmount > 0)) throw new Error('The amount must be above 0 SOL.')
  if (solAmount > cfg.maxSol) throw new Error(`That is over this server's limit of ${cfg.maxSol} SOL per trade (PUMP_MAX_SOL_PER_TRADE).`)
  const w = loadWallet()!
  const tx = await portal({ publicKey: w.publicKey.toBase58(), action: 'buy', mint, amount: solAmount, denominatedInSol: 'true', slippage, priorityFee: cfg.priorityFee, pool: 'auto' })
  return signSimulateSend(tx, [w], mint)
}
export async function sell(mint: string, amount: string, slippage = cfg.slippage) {
  const w = loadWallet()!
  const held = await tokenBalance(w.publicKey.toBase58(), mint)
  if (!(held > 0)) throw new Error(`${w.publicKey.toBase58()} does not hold this coin, so there is nothing to sell.`)
  if (!amount.endsWith('%') && +amount > held) throw new Error(`The wallet holds ${held.toLocaleString('en-US')} tokens, less than ${amount}.`)
  const tx = await portal({ publicKey: w.publicKey.toBase58(), action: 'sell', mint, amount, denominatedInSol: 'false', slippage, priorityFee: cfg.priorityFee, pool: 'auto' })
  return signSimulateSend(tx, [w], mint)
}
export async function claimCreatorFees() {
  const w = loadWallet()!
  const tx = await portal({ publicKey: w.publicKey.toBase58(), action: 'collectCreatorFee', priorityFee: cfg.priorityFee })
  return signSimulateSend(tx, [w])
}

// launching a coin: image + metadata go to IPFS through the user's own Pinata key, then pump.fun's create instruction
export async function launch(o: { name: string; symbol: string; description: string; image: string; twitter?: string; telegram?: string; website?: string; devBuySol: number }) {
  const jwt = process.env.PINATA_JWT
  if (!jwt) throw new Error('Launching needs a Pinata key for the IPFS upload: set PINATA_JWT in this MCP server\'s env (pinata.cloud, free tier is enough).')
  if (o.devBuySol > cfg.maxSol) throw new Error(`The dev buy is over this server's limit of ${cfg.maxSol} SOL (PUMP_MAX_SOL_PER_TRADE).`)
  const w = loadWallet()!
  const pin = async (blob: Blob, name: string) => {
    const fd = new FormData(); fd.append('network', 'public'); fd.append('file', blob, name)
    const r = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: fd })
    const j: any = await r.json(); if (!j?.data?.cid) throw new Error('IPFS upload failed: ' + JSON.stringify(j).slice(0, 200))
    return 'https://ipfs.io/ipfs/' + j.data.cid
  }
  const imgBlob = /^https?:\/\//.test(o.image) ? await (await fetch(o.image)).blob() : new Blob([fs.readFileSync(o.image)])
  const image = await pin(imgBlob, 'image.png')
  const uri = await pin(new Blob([JSON.stringify({ name: o.name, symbol: o.symbol, description: o.description, image, showName: true, twitter: o.twitter || '', telegram: o.telegram || '', website: o.website || '' })], { type: 'application/json' }), 'metadata.json')
  const mint = Keypair.generate()
  const tx = await portal({ publicKey: w.publicKey.toBase58(), action: 'create', tokenMetadata: { name: o.name, symbol: o.symbol, uri }, mint: mint.publicKey.toBase58(), denominatedInSol: 'true', amount: o.devBuySol, slippage: 10, priorityFee: cfg.priorityFee, pool: 'pump' })
  const res = await signSimulateSend(tx, [mint, w], mint.publicKey.toBase58())
  return { ...res, mint: mint.publicKey.toBase58(), uri }
}
