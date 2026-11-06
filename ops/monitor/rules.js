// Правила обнаружения. Чистая логика без ввода-вывода, чтобы её можно было тестировать.

export const ACCESS_ERRORS = new Set(["AccessControlUnauthorizedAccount", "NotClaimant"]);

/** Описания правил (используются в отчёте и в README). */
export const RULES = {
  R1_ACCESS_VIOLATION: {
    id: "R1_ACCESS_VIOLATION",
    title: "Повторные попытки нарушения доступа",
    source: "квитанции status=0 с ошибкой AccessControlUnauthorizedAccount/NotClaimant + журнал dApp (отказ на этапе eth_call)",
    threshold: 3,
    windowMs: 60_000,
    cooldownMs: 300_000,
    severity: "HIGH",
    response: "уведомление, адрес в watchlist, ручная проверка ролей; при повторе - блокировка адреса на уровне dApp/RPC-шлюза",
  },
  R2_OPERATIONAL_FAILURE: {
    id: "R2_OPERATIONAL_FAILURE",
    title: "Эксплуатационный сбой (RPC или массовые откаты)",
    source: "ошибки RPC монитора и dApp; квитанции status=0 без ошибок доступа",
    threshold: 3, // ошибок RPC в окне
    windowMs: 30_000,
    failRatio: 0.5, // либо доля неуспешных транзакций в последних N
    failSample: 6,
    cooldownMs: 120_000,
    severity: "MEDIUM",
    response: "уведомление дежурному, переключение на резервный RPC, приостановка отправки транзакций в dApp",
  },
};

export class RuleEngine {
  /**
   * @param {(alert:object)=>void} onAlert
   * @param {()=>number} now  источник времени (подменяется в тестах)
   */
  constructor(onAlert, now = () => Date.now()) {
    this.onAlert = onAlert;
    this.now = now;
    this.accessAttempts = new Map(); // address -> [ts]
    this.rpcErrors = []; // [ts]
    this.recentTx = []; // [{ok}]
    this.lastAlert = new Map(); // dedupKey -> ts
    this.suppressed = 0;
    this.seen = new Set(); // идемпотентность: один сигнал учитывается один раз
  }

  _prune(arr, windowMs) {
    const t = this.now() - windowMs;
    while (arr.length && arr[0] < t) arr.shift();
    return arr;
  }

  /** Защита от повторных уведомлений: одно уведомление на ключ в течение cooldown. */
  _emit(rule, key, details) {
    const dedupKey = `${rule.id}:${key}`;
    const last = this.lastAlert.get(dedupKey);
    if (last !== undefined && this.now() - last < rule.cooldownMs) {
      this.suppressed++;
      return null;
    }
    this.lastAlert.set(dedupKey, this.now());
    const alert = {
      ts: new Date(this.now()).toISOString(),
      rule: rule.id,
      title: rule.title,
      severity: rule.severity,
      key,
      response: rule.response,
      ...details,
    };
    this.onAlert(alert);
    return alert;
  }

  /** Подача записи телеметрии в правила. */
  ingest(rec) {
    // Один и тот же сигнал может прийти из квитанции и из журнала dApp - учитываем один раз
    const sigId = rec.signalId ?? null;
    if (sigId) {
      if (this.seen.has(sigId)) return null;
      this.seen.add(sigId);
    }

    if (rec.category === "tx_receipt") {
      const access = rec.status === 0 && ACCESS_ERRORS.has(rec.revertName);
      if (access) return this._access(rec.from, rec);
      this.recentTx.push({ ok: rec.status === 1 });
      if (this.recentTx.length > 10) this.recentTx.shift();
      return this._failRatio(rec);
    }
    if (rec.category === "app_log" && rec.event === "tx_result" && rec.revert && ACCESS_ERRORS.has(rec.revert.name)) {
      return this._access(rec.account, rec);
    }
    if (rec.category === "rpc_error") {
      const r = RULES.R2_OPERATIONAL_FAILURE;
      this.rpcErrors.push(this.now());
      this._prune(this.rpcErrors, r.windowMs);
      if (this.rpcErrors.length >= r.threshold) {
        return this._emit(r, `rpc:${rec.endpoint ?? "default"}`, {
          signal: "rpc_error",
          count: this.rpcErrors.length,
          windowSec: r.windowMs / 1000,
          lastError: rec.message,
          correlationId: rec.correlationId,
        });
      }
    }
    return null;
  }

  _access(address, rec) {
    const r = RULES.R1_ACCESS_VIOLATION;
    const addr = (address ?? "unknown").toLowerCase();
    const list = this.accessAttempts.get(addr) ?? [];
    list.push(this.now());
    this._prune(list, r.windowMs);
    this.accessAttempts.set(addr, list);
    if (list.length >= r.threshold) {
      return this._emit(r, addr, {
        signal: rec.category,
        address: addr,
        count: list.length,
        windowSec: r.windowMs / 1000,
        lastMethod: rec.method,
        lastError: rec.revertName ?? rec.revert?.name,
        correlationId: rec.correlationId,
      });
    }
    return null;
  }

  _failRatio(rec) {
    const r = RULES.R2_OPERATIONAL_FAILURE;
    if (this.recentTx.length < r.failSample) return null;
    const failed = this.recentTx.filter((x) => !x.ok).length;
    const ratio = failed / this.recentTx.length;
    if (ratio >= r.failRatio) {
      return this._emit(r, "tx-failure-rate", { signal: "tx_receipt", failed, sample: this.recentTx.length, ratio, correlationId: rec.correlationId });
    }
    return null;
  }
}
