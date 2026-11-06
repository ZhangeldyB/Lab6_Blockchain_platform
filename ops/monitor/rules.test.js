import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleEngine } from "./rules.js";

function engine() {
  let t = 1_000_000;
  const alerts = [];
  const e = new RuleEngine((a) => alerts.push(a), () => t);
  return { e, alerts, tick: (ms) => (t += ms) };
}

const denied = (i, from = "0xBAD") => ({ category: "tx_receipt", status: 0, revertName: "AccessControlUnauthorizedAccount", from, signalId: `tx${i}`, method: "approveClaim" });

test("R1: 2 попытки - без тревоги, 3-я в окне 60 с - тревога HIGH", () => {
  const { e, alerts, tick } = engine();
  e.ingest(denied(1));
  tick(10_000);
  e.ingest(denied(2));
  assert.equal(alerts.length, 0);
  tick(10_000);
  e.ingest(denied(3));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].rule, "R1_ACCESS_VIOLATION");
  assert.equal(alerts[0].severity, "HIGH");
});

test("R1: попытки вне окна не накапливаются", () => {
  const { e, alerts, tick } = engine();
  for (let i = 0; i < 3; i++) {
    e.ingest(denied(i));
    tick(31_000);
  }
  assert.equal(alerts.length, 0);
});

test("R1: защита от повторных уведомлений (cooldown 300 с) и повторных сигналов", () => {
  const { e, alerts, tick } = engine();
  for (let i = 0; i < 6; i++) e.ingest(denied(i));
  e.ingest(denied(5)); // тот же signalId - игнорируется
  assert.equal(alerts.length, 1);
  assert.equal(e.suppressed, 3);
  tick(301_000);
  for (let i = 10; i < 13; i++) e.ingest(denied(i));
  assert.equal(alerts.length, 2, "после cooldown уведомление снова возможно");
});

test("R2: 3 ошибки RPC за 30 с - тревога MEDIUM, одна на cooldown", () => {
  const { e, alerts } = engine();
  for (let i = 0; i < 10; i++) e.ingest({ category: "rpc_error", message: "ECONNREFUSED", endpoint: "local" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].rule, "R2_OPERATIONAL_FAILURE");
});

test("Штатный поток успешных транзакций не вызывает тревог", () => {
  const { e, alerts, tick } = engine();
  for (let i = 0; i < 50; i++) {
    e.ingest({ category: "tx_receipt", status: 1, from: "0xA", signalId: `ok${i}` });
    e.ingest({ category: "contract_event", event: "ClaimSubmitted" });
    tick(1000);
  }
  assert.equal(alerts.length, 0);
});
