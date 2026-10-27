# pump-mcp

**pump.fun for AI assistants.** An MCP server that lets Claude, Cursor, or any MCP client watch, research and trade pump.fun from a chat.

> "Show me the hottest launch of the last five minutes whose dev hasn't sold."
> "Who made this coin, and how did their other launches end?"
> "Buy 0.05 SOL of it. Sell half at 2x."

Everything is read straight from Solana: pump.fun's own on-chain events, the bonding curve and token accounts. No pump.fun account and no scraping. Trades are built by [PumpPortal](https://pumpportal.fun)'s local transaction API and **signed on your machine. Your key never leaves it.**

## Tools

| Tool | What it does |
|---|---|
| `pump_new_launches` | Live launches since the server started: MC, curve progress, buys/sells, unique buyers, the dev's holding and whether the dev sold, and wallets that bought in the launch block (bundles). Sort by `newest`, `hot` or `mcap`. |
| `pump_coin` | Everything about one coin: description and links from its launch metadata, price, MC, curve progress or DEX pair, volume, top-holder share, the dev, live activity. It warns about fake-liquidity copies. |
| `pump_dev_history` | Every coin a wallet launched (or a coin's dev) and how each one ended: graduated, on the curve or dead. |
| `pump_wallet` | SOL and token holdings with their value. |
| `pump_search` | Find coins by name, ticker or address. |
| `pump_status` | Feed, RPC, wallet and trading settings. |
| `pump_buy` / `pump_sell` | Trade from your wallet, on the bonding curve or the pool after graduation. **Off by default.** |
| `pump_claim_creator_fees` | Claim the creator fees owed to your wallet. |
| `pump_launch` | Launch a coin: image + metadata to IPFS, create, dev buy. |

## Install

Needs Node 22 or newer.

**Claude Code**
```bash
claude mcp add pump -- npx -y github:dodo1653/pump-mcp
```

**Claude Desktop / Cursor**: add to `claude_desktop_config.json` or `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "pump": {
      "command": "npx",
      "args": ["-y", "github:dodo1653/pump-mcp"],
      "env": { "SOLANA_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" }
    }
  }
}
```

That's read-only. To let the assistant trade, add a wallet and switch trading on (below).

## Settings (env)

| Variable | Default | |
|---|---|---|
| `SOLANA_RPC_URL` | public mainnet | A free [Helius](https://helius.dev) key is strongly recommended. The public endpoint is rate-limited and refuses holder queries. |
| `PUMP_WALLET_KEY` | none | Base58 private key, or use `PUMP_WALLET_FILE` with a Solana CLI keypair file. **Use a fresh wallet with only what you're willing to trade.** |
| `PUMP_ALLOW_TRADING` | `false` | `true` turns on buy / sell / claim / launch. |
| `PUMP_MAX_SOL_PER_TRADE` | `0.5` | A hard cap per buy and per dev buy. |
| `PUMP_SLIPPAGE` | `15` | Percent. |
| `PUMP_PRIORITY_FEE` | `0.0005` | SOL. |
| `PINATA_JWT` | none | Only for `pump_launch` (IPFS upload). |

## Safety

- Trading is off until you turn it on, and every trade is capped.
- Every transaction is **simulated before it's sent**. If it would fail (no SOL, slippage, a closed pool), nothing is sent and you get the reason.
- Your MCP client asks before each tool call. Read what it's about to do.
- PumpPortal charges 0.5% per trade. Solana and pump.fun fees apply.
- Memecoins mostly go to zero. This is a tool, not advice.

## How it works

- **Live feed:** `logsSubscribe` on the pump.fun program, decoding its `CreateEvent` / `TradeEvent` / `CompleteEvent` from the logs.
- **Prices:** the bonding-curve account (virtual reserves) while on the curve, DexScreener after graduation, and SOL/USD from Coinbase.
- **Metadata:** the Token-2022 metadata extension (new coins) or Metaplex (older coins), then the launch JSON from IPFS.

MIT licensed.
