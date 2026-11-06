// Прототип мониторинга безопасности dApp.
// Источники телеметрии:
//   1) contract_event - события контракта (eth_getLogs);
//   2) tx_receipt     - квитанции всех транзакций к контракту, включая откатившиеся;
//   3) rpc_error      - ошибки RPC-узла;
//   4) app_log        - журнал dApp, принимается по HTTP POST /telemetry.
// Каждая запись: ISO-метка времени, категория, correlationId. Секреты не записываются.
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, JsonRpcProvider } from "ethers";
import { RuleEngine } from "./rules.js";
import abi from "../../frontend/src/lib/abi.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CONTRACT = (process.env.CONTRACT_ADDRESS ?? "").toLowerCase();
const PORT = Number(process.env.MONITOR_PORT ?? 8787);
const POLL_MS = Number(process.env.POLL_MS ?? 500);
const LOG_DIR = process.env.LOG_DIR ?? join(here, "logs");
const WEBHOOK = process.env.ALERT_WEBHOOK_URL; // опционально

if (!CONTRACT) {
  console.error("CONTRACT_ADDRESS не задан");
  process.exit(1);
}

mkdirSync(LOG_DIR, { recursive: true });
const TELEMETRY_FILE = join(LOG_DIR, "telemetry.jsonl");
const ALERTS_FILE = join(LOG_DIR, "alerts.jsonl");

const iface = new Interface(abi);
const provider = new JsonRpcProvider(RPC_URL, 31337, { staticNetwork: true, cacheTimeout: -1 });
const SENSITIVE = ["privateKey", "private_key", "mnemonic", "seed", "password", "secret", "authorization"];

function sanitize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.includes(k)) continue;
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

const engine = new RuleEngine((alert) => {
  appendFileSync(ALERTS_FILE, JSON.stringify(alert) + "\n");
  console.log(`\x1b[31m[ALERT ${alert.severity}] ${alert.rule}\x1b[0m key=${alert.key} count=${alert.count ?? alert.failed ?? ""}`);
  if (WEBHOOK) fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(alert) }).catch(() => {});
});

function record(category, fields) {
  const rec = sanitize({ ts: new Date().toISOString(), category, correlationId: fields.correlationId ?? randomUUID(), ...fields });
  appendFileSync(TELEMETRY_FILE, JSON.stringify(rec) + "\n");
  const before = engine.suppressed;
  engine.ingest(rec);
  if (engine.suppressed > before) {
    appendFileSync(
      join(LOG_DIR, "suppressed.jsonl"),
      JSON.stringify({ ts: rec.ts, category, correlationId: rec.correlationId, totalSuppressed: engine.suppressed }) + "\n"
    );
  }
  return rec;
}

/** Обёртка RPC: любая ошибка узла превращается в телеметрию rpc_error. */
async function rpc(method, fn) {
  try {
    return await fn();
  } catch (e) {
    record("rpc_error", { method, endpoint: RPC_URL, code: e.code ?? e.error?.code ?? null, message: e.shortMessage ?? e.message });
    throw e;
  }
}

/** Причина отката: повторяем вызов через eth_call на состоянии предыдущего блока. */
async function revertReason(tx, blockNumber) {
  try {
    await provider.call({ from: tx.from, to: tx.to, data: tx.data, value: tx.value, blockTag: blockNumber - 1 });
    return { name: "Unknown", args: [] };
  } catch (e) {
    const data = e.data ?? e.info?.error?.data;
    try {
      const p = iface.parseError(data);
      return { name: p.name, args: p.args.map(String) };
    } catch {
      return { name: e.reason ?? "Unknown", args: [] };
    }
  }
}

let nextBlock = null;

async function poll() {
  const latest = await rpc("eth_blockNumber", () => provider.getBlockNumber());
  if (nextBlock === null) nextBlock = Number(process.env.FROM_BLOCK ?? latest + 1);
  for (let b = nextBlock; b <= latest; b++) {
    const block = await rpc("eth_getBlockByNumber", () => provider.getBlock(b, true));
    for (const tx of block.prefetchedTransactions) {
      if (!tx.to || tx.to.toLowerCase() !== CONTRACT) continue;
      const receipt = await rpc("eth_getTransactionReceipt", () => provider.getTransactionReceipt(tx.hash));
      let method = "unknown";
      try {
        method = iface.parseTransaction({ data: tx.data, value: tx.value })?.name ?? "unknown";
      } catch {}
      const base = {
        correlationId: tx.hash,
        signalId: tx.hash,
        txHash: tx.hash,
        blockNumber: b,
        from: tx.from,
        method,
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
      };
      if (receipt.status === 0) {
        // События откатившейся транзакции не сохраняются - причину берём из повторного eth_call
        const r = await revertReason(tx, b);
        record("tx_receipt", { ...base, revertName: r.name, revertArgs: r.args });
      } else {
        record("tx_receipt", base);
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== CONTRACT) continue;
          try {
            const p = iface.parseLog(log);
            const args = {};
            p.fragment.inputs.forEach((inp, i) => (args[inp.name] = p.args[i].toString()));
            record("contract_event", { correlationId: tx.hash, txHash: tx.hash, blockNumber: b, logIndex: log.index, event: p.name, args });
          } catch {}
        }
      }
    }
    nextBlock = b + 1;
  }
}

// Приём журнала dApp
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.end();
  if (req.method === "GET" && req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, nextBlock, suppressedAlerts: engine.suppressed }));
  }
  if (req.method === "POST" && req.url === "/telemetry") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 64_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const msg = JSON.parse(body);
        // Если у записи есть хеш транзакции, это тот же сигнал, что и квитанция
        record("app_log", { ...msg, signalId: msg.hash ?? msg.correlationId });
        res.statusCode = 204;
      } catch {
        res.statusCode = 400;
      }
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(PORT, () => console.log(`monitor: RPC ${RPC_URL}, контракт ${CONTRACT}, приём журналов :${PORT}`));

let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await poll();
  } catch {
    /* уже записано как rpc_error */
  } finally {
    running = false;
  }
}, POLL_MS);

process.on("SIGTERM", () => {
  console.log(`monitor: остановлен, подавлено повторных уведомлений: ${engine.suppressed}`);
  process.exit(0);
});
