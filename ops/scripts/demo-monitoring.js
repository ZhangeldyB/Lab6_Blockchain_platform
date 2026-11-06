// Демонстрация мониторинга: штатный сценарий (без тревоги), атака на права доступа (R1)
// и отказ RPC-узла (R2). Запуск: node scripts/demo-monitoring.js
import { spawn } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ContractFactory, JsonRpcProvider, Wallet, keccak256, parseEther, toUtf8Bytes } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const ART = JSON.parse(readFileSync(join(here, "../../contracts/out/InsuranceClaimRegistry.sol/InsuranceClaimRegistry.json"), "utf8"));
const LOG_DIR = join(here, "../monitor/logs");
const PORT = 8545;
const RPC = `http://127.0.0.1:${PORT}`;
const MON = "http://127.0.0.1:8787/telemetry";
// Общеизвестные тестовые ключи Anvil - только для локальной сети
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const alerts = () => readJsonl(join(LOG_DIR, "alerts.jsonl"));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function postApp(rec) {
  await fetch(MON, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ts: new Date().toISOString(), source: "dapp", ...rec }) });
}

rmSync(LOG_DIR, { recursive: true, force: true });

const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
const provider = new JsonRpcProvider(RPC, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
for (let i = 0; i < 50; i++) {
  try {
    await provider.getBlockNumber();
    break;
  } catch {
    await sleep(100);
  }
}
const [insurer, alice, mallory] = KEYS.map((k) => new Wallet(k, provider));
const reg = await new ContractFactory(ART.abi, ART.bytecode.object, insurer).deploy(insurer.address);
await reg.waitForDeployment();
const address = await reg.getAddress();
log(`контракт развёрнут: ${address}`);

const monitor = spawn("node", [join(here, "../monitor/monitor.js")], {
  env: { ...process.env, RPC_URL: RPC, CONTRACT_ADDRESS: address, FROM_BLOCK: "1", POLL_MS: "300" },
  stdio: "inherit",
});
await sleep(1200);

// ---------- Сценарий 1: штатная работа ----------
log("СЦЕНАРИЙ 1: штатная работа (ожидается 0 тревог)");
const asI = reg.connect(insurer);
const asA = reg.connect(alice);
await (await asI.fundPool({ value: parseEther("10") })).wait();
for (let i = 1; i <= 3; i++) {
  const cid = randomUUID();
  await postApp({ event: "tx_requested", correlationId: cid, method: "submitClaim", account: alice.address });
  const tx = await asA.submitClaim(parseEther("1"), keccak256(toUtf8Bytes(`docs-${i}`)));
  const rc = await tx.wait();
  await postApp({ event: "tx_result", correlationId: cid, method: "submitClaim", account: alice.address, stage: "success", hash: tx.hash, blockNumber: rc.blockNumber });
}
await (await asI.startReview(1n)).wait();
await (await asI.approveClaim(1n)).wait();
await (await asA.withdrawPayout(1n)).wait();
await sleep(1500);
log(`тревог после сценария 1: ${alerts().length}`);

// ---------- Сценарий 2: попытки нарушения доступа ----------
log("СЦЕНАРИЙ 2: mallory пытается одобрить чужой случай (ожидается R1)");
await (await asI.startReview(2n)).wait();
const asM = reg.connect(mallory);
// 2 отказа на этапе eth_call в dApp - попадают только в журнал приложения
for (let i = 0; i < 2; i++) {
  await postApp({
    event: "tx_result",
    correlationId: randomUUID(),
    method: "approveClaim",
    account: mallory.address,
    stage: "reverted",
    revert: { name: "AccessControlUnauthorizedAccount", args: [mallory.address] },
  });
}
// 3 транзакции в обход интерфейса - включаются в блок и откатываются (status=0)
for (let i = 0; i < 3; i++) {
  const tx = await asM.approveClaim(2n, { gasLimit: 200000n });
  const rc = await provider.waitForTransaction(tx.hash);
  log(`  tx ${tx.hash.slice(0, 12)}… status=${rc.status}, событий: ${rc.logs.length}`);
}
await sleep(1500);
log(`тревог после сценария 2: ${alerts().length}`);

// ---------- Сценарий 3: отказ RPC-узла ----------
log("СЦЕНАРИЙ 3: остановка узла Anvil (ожидается R2)");
anvil.kill();
await sleep(4000);
log(`тревог после сценария 3: ${alerts().length}`);

monitor.kill("SIGTERM");
await sleep(300);
console.log("\n===== alerts.jsonl =====");
for (const a of alerts()) console.log(JSON.stringify(a));
const tele = readJsonl(join(LOG_DIR, "telemetry.jsonl"));
const byCat = tele.reduce((m, r) => ((m[r.category] = (m[r.category] ?? 0) + 1), m), {});
console.log("\nзаписей телеметрии по категориям:", JSON.stringify(byCat));
console.log("подавлено повторных уведомлений:", readJsonl(join(LOG_DIR, "suppressed.jsonl")).length);
process.exit(0);
