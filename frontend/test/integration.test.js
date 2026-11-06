// Интеграционные тесты клиентской логики dApp против локальной сети Anvil.
// Проверяется путь dApp -> ethers -> RPC -> смарт-контракт, тот же код, что использует UI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeError, parseEther } from "ethers";
import { startAnvil, deploy } from "./helpers.js";
import {
  Stage,
  classifyError,
  evidenceHash,
  fetchEvents,
  getContract,
  mergeEvents,
  readClaim,
  readState,
  runTx,
} from "../src/lib/registry.js";

const CHAIN = 31337;
let node, env;

before(async () => {
  node = await startAnvil();
  env = await deploy(node.provider);
});
after(() => node?.stop());

const asUser = (w) => getContract(env.address, w);

test("T1 чтение: poolBalance/reserved/nextClaimId и роль страховщика", async () => {
  const s = await readState(getContract(env.address, node.provider), env.insurer.address);
  assert.equal(s.pool, parseEther("10"));
  assert.equal(s.reserved, 0n);
  assert.equal(s.nextId, 1n);
  assert.equal(s.isAdjuster, true);
  const m = await readState(getContract(env.address, node.provider), env.mallory.address);
  assert.equal(m.isAdjuster, false);
});

test("T2 положительный: submitClaim проходит все этапы и меняет состояние", async () => {
  const stages = [];
  const r = await runTx({
    contract: asUser(env.alice),
    method: "submitClaim",
    args: [parseEther("1"), evidenceHash("docs-1")],
    expectedChainId: CHAIN,
    onStage: (s) => stages.push(s.stage),
  });
  assert.equal(r.stage, Stage.SUCCESS);
  assert.deepEqual(stages, [Stage.AWAITING_SIGNATURE, Stage.SENT, Stage.CONFIRMING, Stage.SUCCESS]);
  assert.deepEqual(r.events, ["ClaimSubmitted", "ClaimStatusChanged"]);
  const c = await readClaim(getContract(env.address, node.provider), 1n);
  assert.equal(c.status, "Submitted");
  assert.equal(c.claimant, env.alice.address);
});

test("T3 негативный: approveClaim без ADJUSTER_ROLE отклоняется контрактом (preflight)", async () => {
  await (await asUser(env.insurer).startReview(1n)).wait();
  const r = await runTx({ contract: asUser(env.mallory), method: "approveClaim", args: [1n], expectedChainId: CHAIN });
  assert.equal(r.stage, Stage.REVERTED);
  assert.equal(r.revert.name, "AccessControlUnauthorizedAccount");
  assert.equal(r.revert.args[0], env.mallory.address);
  const c = await readClaim(getContract(env.address, node.provider), 1n);
  assert.equal(c.status, "UnderReview", "статус не изменился");
});

test("T4 негативный: откат в блоке (status=0) распознаётся по квитанции, событий нет", async () => {
  const r = await runTx({
    contract: asUser(env.mallory),
    method: "approveClaim",
    args: [1n],
    overrides: { gasLimit: 200000n },
    expectedChainId: CHAIN,
    preflight: false,
  });
  assert.equal(r.stage, Stage.REVERTED);
  assert.ok(r.hash, "хеш получен, но это не означает успех");
  const receipt = await node.provider.getTransactionReceipt(r.hash);
  assert.equal(receipt.status, 0);
  assert.equal(receipt.logs.length, 0, "события откатившейся транзакции не сохраняются");
});

test("T5 неверная сеть: отправка блокируется до подписи", async () => {
  const stages = [];
  const r = await runTx({
    contract: asUser(env.alice),
    method: "submitClaim",
    args: [1n, evidenceHash("x")],
    expectedChainId: 11155111,
    onStage: (s) => stages.push(s.stage),
  });
  assert.equal(r.stage, Stage.WRONG_NETWORK);
  assert.ok(!stages.includes(Stage.AWAITING_SIGNATURE));
});

test("T6 отказ в подписи: ACTION_REJECTED классифицируется как rejected", () => {
  const err = makeError("user rejected action", "ACTION_REJECTED", { action: "sendTransaction", reason: "rejected" });
  assert.equal(classifyError(err).stage, Stage.REJECTED);
  assert.equal(classifyError({ code: 4001, message: "User denied" }).stage, Stage.REJECTED);
});

test("T7 полный цикл: approve + withdrawPayout, баланс и резерв", async () => {
  const reader = getContract(env.address, node.provider);
  const r1 = await runTx({ contract: asUser(env.insurer), method: "approveClaim", args: [1n], expectedChainId: CHAIN });
  assert.equal(r1.stage, Stage.SUCCESS);
  assert.equal(await reader.reserved(), parseEther("1"));
  const before = await node.provider.getBalance(env.alice.address);
  const r2 = await runTx({ contract: asUser(env.alice), method: "withdrawPayout", args: [1n], expectedChainId: CHAIN });
  assert.equal(r2.stage, Stage.SUCCESS);
  assert.ok(r2.events.includes("PayoutWithdrawn"));
  const after = await node.provider.getBalance(env.alice.address);
  assert.ok(after > before + parseEther("0.99"));
  assert.equal(await reader.reserved(), 0n);
});

test("T8 события: два типа событий с номером блока, без дублирования при повторной загрузке", async () => {
  const reader = getContract(env.address, node.provider);
  const first = await fetchEvents(reader);
  const second = await fetchEvents(reader);
  const merged = mergeEvents(first, second);
  assert.equal(merged.length, first.length, "повторная загрузка не создаёт дублей");
  const names = new Set(merged.map((e) => e.name));
  for (const n of ["ClaimSubmitted", "ClaimStatusChanged", "PayoutWithdrawn", "PoolFunded"]) assert.ok(names.has(n), n);
  assert.ok(merged.every((e) => e.blockNumber > 0 && e.txHash.startsWith("0x")));
});
