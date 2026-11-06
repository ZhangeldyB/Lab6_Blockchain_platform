// Нагрузочный эксперимент в локальной сети Anvil.
// Профили: A - 30 последовательных транзакций (1 клиент), B - 30 транзакций, 5 параллельных клиентов по 6.
// Для каждого профиля поднимается новый узел Anvil с одинаковыми параметрами и заново
// развёртывается контракт - условия сопоставимы. Операция одна и та же: submitClaim.
//
// Запуск: node loadtest/loadtest.js [--block-time 1] [--reps 3] [--profiles sequential,parallel5,pipelined]
// pipelined - профиль проверки предложенной оптимизации (не входит в обязательные).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, keccak256, parseEther, toUtf8Bytes, parseUnits } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
);
const BLOCK_TIME = args["block-time"] ? Number(args["block-time"]) : 0; // 0 = automine
const REPS = Number(args.reps ?? 3);
const OUT = args.out ?? join(here, "../../reports/load");
const TOTAL = 30;
const CLIENTS = 5;
const POLL_MS = 5;

const ART = JSON.parse(readFileSync(join(here, "../../contracts/out/InsuranceClaimRegistry.sol/InsuranceClaimRegistry.json"), "utf8"));
// Общеизвестные тестовые ключи Anvil (аккаунты 0..5)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startNode(port) {
  const a = ["--port", String(port), "--silent", "--accounts", "10"];
  if (BLOCK_TIME) a.push("--block-time", String(BLOCK_TIME));
  const proc = spawn("anvil", a, { stdio: "ignore" });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 20 });
  for (let i = 0; i < 100; i++) {
    try {
      await provider.getBlockNumber();
      return { proc, provider };
    } catch {
      await sleep(100);
    }
  }
  throw new Error("anvil не запустился");
}

async function waitReceipt(provider, hash) {
  for (;;) {
    const r = await provider.send("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(POLL_MS);
  }
}

/** Клиент с собственным счётчиком nonce: nonce берётся один раз ('pending') и увеличивается локально. */
class Client {
  constructor(key, provider, contract) {
    this.wallet = new Wallet(key, provider);
    this.provider = provider;
    this.contract = contract.connect(this.wallet);
    this.nonce = null;
  }
  async init() {
    this.nonce = await this.provider.getTransactionCount(this.wallet.address, "pending");
  }
  async send(i) {
    const data = this.contract.interface.encodeFunctionData("submitClaim", [parseEther("0.01"), keccak256(toUtf8Bytes(`load-${this.wallet.address}-${i}`))]);
    const nonce = this.nonce++;
    const t0 = performance.now();
    try {
      // Все поля задаются явно: подпись локальная, к RPC уходит только eth_sendRawTransaction
      const signed = await this.wallet.signTransaction({
        to: await this.contract.getAddress(),
        data,
        nonce,
        chainId: 31337,
        type: 2,
        gasLimit: 200000n,
        maxFeePerGas: parseUnits("5", "gwei"),
        maxPriorityFeePerGas: parseUnits("1", "gwei"),
      });
      const hash = await this.provider.send("eth_sendRawTransaction", [signed]);
      const r = await waitReceipt(this.provider, hash);
      const t1 = performance.now();
      return { ok: r.status === "0x1", latencyMs: t1 - t0, t0, t1, gasUsed: Number(BigInt(r.gasUsed)), block: Number(BigInt(r.blockNumber)), nonce, hash };
    } catch (e) {
      const t1 = performance.now();
      return { ok: false, latencyMs: t1 - t0, t0, t1, gasUsed: 0, error: e.shortMessage ?? e.message, nonce };
    }
  }
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.ceil((p / 100) * sorted.length) - 1; // метод ближайшего ранга
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

function summarize(name, results) {
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const start = Math.min(...results.map((r) => r.t0));
  const end = Math.max(...results.map((r) => r.t1));
  const okRes = results.filter((r) => r.ok);
  const gas = okRes.map((r) => r.gasUsed);
  const blocks = new Set(okRes.map((r) => r.block));
  return {
    profile: name,
    n: results.length,
    p50: +pct(lat, 50).toFixed(1),
    p95: +pct(lat, 95).toFixed(1),
    mean: +(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(1),
    throughput: +(results.length / ((end - start) / 1000)).toFixed(2),
    durationMs: +(end - start).toFixed(0),
    failRate: +((results.length - okRes.length) / results.length).toFixed(3),
    gasUsedMean: gas.length ? Math.round(gas.reduce((s, x) => s + x, 0) / gas.length) : 0,
    gasUsedMin: gas.length ? Math.min(...gas) : 0,
    gasUsedMax: gas.length ? Math.max(...gas) : 0,
    blocksUsed: blocks.size,
  };
}

async function runProfile(name, port) {
  const { proc, provider } = await startNode(port);
  try {
    const deployer = new Wallet(KEYS[0], provider);
    const reg = await new ContractFactory(ART.abi, ART.bytecode.object, deployer).deploy(deployer.address);
    await reg.waitForDeployment();

    const nClients = name === "parallel5" ? CLIENTS : 1;
    const clients = KEYS.slice(1, 1 + nClients).map((k) => new Client(k, provider, reg));
    await Promise.all(clients.map((c) => c.init()));
    // Прогрев: по одной транзакции на клиента, в статистику не входит
    await Promise.all(clients.map((c) => c.send(-1)));

    let results = [];
    if (name === "sequential") {
      for (let i = 0; i < TOTAL; i++) results.push(await clients[0].send(i));
    } else if (name === "pipelined") {
      // Оптимизация: nonce назначаются локально, транзакции отправляются без ожидания
      // квитанции предыдущей - несколько транзакций попадают в один блок
      results = await Promise.all(Array.from({ length: TOTAL }, (_, i) => clients[0].send(i)));
    } else {
      const per = TOTAL / CLIENTS;
      const runs = await Promise.all(
        clients.map(async (c, ci) => {
          const out = [];
          for (let i = 0; i < per; i++) out.push({ client: ci, ...(await c.send(i)) });
          return out;
        })
      );
      results = runs.flat();
    }
    // Проверка корректности nonce: у каждого клиента последовательность без пропусков и повторов
    for (const c of clients) {
      const onChain = await provider.getTransactionCount(c.wallet.address, "latest");
      if (onChain !== c.nonce) throw new Error(`nonce mismatch ${c.wallet.address}: chain=${onChain} local=${c.nonce}`);
    }
    return results;
  } finally {
    proc.kill();
    await sleep(300);
  }
}

mkdirSync(OUT, { recursive: true });
const mode = BLOCK_TIME ? `blocktime${BLOCK_TIME}s` : "automine";
const all = {};
const summaries = [];
const PROFILES = (args.profiles ?? "sequential,parallel5").split(",");
for (const name of PROFILES) {
  for (let rep = 1; rep <= REPS; rep++) {
    const res = await runProfile(name, 8700 + rep + PROFILES.indexOf(name) * 20);
    const s = { mode, rep, ...summarize(name, res) };
    summaries.push(s);
    all[`${name}-${rep}`] = res.map(({ latencyMs, ok, gasUsed, block, nonce, client, t0 }) => ({ latencyMs: +latencyMs.toFixed(2), ok, gasUsed, block, nonce, client, t0: +t0.toFixed(2) }));
    console.log(JSON.stringify(s));
  }
}
const tag = PROFILES.join("+") === "sequential+parallel5" ? mode : `${mode}-${PROFILES.join("+")}`;
writeFileSync(join(OUT, `${tag}-summary.json`), JSON.stringify(summaries, null, 2));
writeFileSync(join(OUT, `${tag}-raw.json`), JSON.stringify(all));
console.log(`сохранено в ${OUT}`);
