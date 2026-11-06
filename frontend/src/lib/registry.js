// Общая логика интеграции с контрактом: используется и UI, и интеграционными тестами.
import { Contract, Interface, isError, keccak256, toUtf8Bytes } from "ethers";
import abi from "./abi.json" with { type: "json" };

export const ABI = abi;
export const iface = new Interface(abi);

export const STATUS = ["None", "Submitted", "UnderReview", "Approved", "Rejected", "Paid"];

/** Этапы транзакции, которые отображает интерфейс. */
export const Stage = Object.freeze({
  IDLE: "idle",
  AWAITING_SIGNATURE: "awaiting_signature",
  SENT: "sent",
  CONFIRMING: "confirming",
  SUCCESS: "success",
  REJECTED: "rejected", // пользователь отказался подписывать
  WRONG_NETWORK: "wrong_network",
  REVERTED: "reverted", // транзакция откатилась (на этапе симуляции или в блоке)
  ERROR: "error",
});

export class WrongNetworkError extends Error {
  constructor(actual, expected) {
    super(`Неверная сеть: chainId=${actual}, ожидается ${expected}`);
    this.name = "WrongNetworkError";
    this.actual = actual;
    this.expected = expected;
  }
}

export function getContract(address, runner) {
  return new Contract(address, abi, runner);
}

export function evidenceHash(text) {
  return keccak256(toUtf8Bytes(text));
}

/** Проверка сети до отправки транзакции. */
export async function assertChain(provider, expectedChainId) {
  const { chainId } = await provider.getNetwork();
  if (BigInt(chainId) !== BigInt(expectedChainId)) {
    throw new WrongNetworkError(Number(chainId), Number(expectedChainId));
  }
  return Number(chainId);
}

/** Извлекает revert-данные из ошибки ethers и декодирует пользовательскую ошибку контракта. */
export function decodeRevert(err) {
  const data =
    err?.data ?? err?.info?.error?.data ?? err?.error?.data ?? err?.info?.error?.data?.data ?? null;
  const hex = typeof data === "string" ? data : data?.data;
  if (err?.revert?.name) return { name: err.revert.name, args: err.revert.args?.map(String) ?? [] };
  if (typeof hex === "string" && hex.length >= 10) {
    try {
      const parsed = iface.parseError(hex);
      if (parsed) return { name: parsed.name, args: parsed.args.map(String) };
    } catch {
      /* не наша ошибка */
    }
  }
  if (err?.reason) return { name: "Error", args: [err.reason] };
  return null;
}

/** Классификация ошибки в этап интерфейса. */
export function classifyError(err) {
  if (err instanceof WrongNetworkError) return { stage: Stage.WRONG_NETWORK, message: err.message };
  if (isError(err, "ACTION_REJECTED") || err?.code === 4001 || err?.info?.error?.code === 4001) {
    return { stage: Stage.REJECTED, message: "Пользователь отклонил подпись транзакции" };
  }
  if (err?.receipt && err.receipt.status === 0) {
    return { stage: Stage.REVERTED, message: "Транзакция включена в блок, но откатилась (status=0)", revert: null };
  }
  const revert = decodeRevert(err);
  if (revert || isError(err, "CALL_EXCEPTION")) {
    const msg = revert ? `${revert.name}(${revert.args.join(", ")})` : "execution reverted";
    return { stage: Stage.REVERTED, message: `Откат: ${msg}`, revert };
  }
  return { stage: Stage.ERROR, message: err?.shortMessage ?? err?.message ?? String(err) };
}

/**
 * Выполняет изменяющую операцию с отображением этапов.
 * Успех фиксируется только по квитанции со status=1, а не по факту получения хеша.
 *
 * @param {object} p
 * @param {Contract} p.contract  контракт, подключённый к signer
 * @param {string}   p.method    имя функции
 * @param {any[]}    p.args
 * @param {object}   [p.overrides]
 * @param {bigint|number} p.expectedChainId
 * @param {boolean}  [p.preflight=true]  симуляция eth_call перед отправкой
 * @param {(s:object)=>void} [p.onStage]
 */
export async function runTx({ contract, method, args = [], overrides = {}, expectedChainId, preflight = true, onStage = () => {} }) {
  const t0 = Date.now();
  try {
    const provider = contract.runner.provider;
    await assertChain(provider, expectedChainId);
    if (preflight) {
      // Ранний отказ без расхода газа: контракт сам проверяет полномочия
      await contract[method].staticCall(...args, overrides);
    }
    onStage({ stage: Stage.AWAITING_SIGNATURE });
    const tx = await contract[method](...args, overrides);
    onStage({ stage: Stage.SENT, hash: tx.hash });
    onStage({ stage: Stage.CONFIRMING, hash: tx.hash });
    let receipt;
    try {
      receipt = await tx.wait();
    } catch (e) {
      if (e?.receipt) receipt = e.receipt;
      else throw e;
    }
    if (receipt.status !== 1) {
      const result = {
        stage: Stage.REVERTED,
        hash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        message: "Транзакция включена в блок, но откатилась (status=0); событий нет",
        latencyMs: Date.now() - t0,
      };
      onStage(result);
      return result;
    }
    const events = receipt.logs
      .map((l) => {
        try {
          return iface.parseLog(l)?.name;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const result = {
      stage: Stage.SUCCESS,
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      events,
      latencyMs: Date.now() - t0,
    };
    onStage(result);
    return result;
  } catch (err) {
    const c = classifyError(err);
    const result = { ...c, latencyMs: Date.now() - t0 };
    onStage(result);
    return result;
  }
}

/** Ключ дедупликации события: одна запись на (tx, logIndex). */
export function eventKey(log) {
  return `${log.transactionHash}:${log.index ?? log.logIndex}`;
}

/** Преобразование лога ethers в запись для журнала событий UI. */
export function toEventRecord(log) {
  const parsed = log.fragment ? { name: log.fragment.name, args: log.args } : iface.parseLog(log);
  const a = parsed.args;
  let details = "";
  switch (parsed.name) {
    case "ClaimSubmitted":
      details = `claim #${a.claimId} от ${a.claimant}, ${a.amount} wei`;
      break;
    case "ClaimStatusChanged":
      details = `claim #${a.claimId}: ${STATUS[Number(a.from)]} → ${STATUS[Number(a.to)]}`;
      break;
    case "PayoutWithdrawn":
      details = `claim #${a.claimId}: выплата ${a.amount} wei → ${a.claimant}`;
      break;
    case "PoolFunded":
      details = `пул +${a.amount} wei от ${a.from}`;
      break;
    default:
      details = parsed.name;
  }
  return {
    key: eventKey(log),
    name: parsed.name,
    details,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.index ?? log.logIndex,
  };
}

/** Слияние записей без дублирования, сортировка по блоку и logIndex. */
export function mergeEvents(existing, incoming) {
  const map = new Map(existing.map((e) => [e.key, e]));
  for (const e of incoming) if (!map.has(e.key)) map.set(e.key, e);
  return [...map.values()].sort((x, y) => y.blockNumber - x.blockNumber || y.logIndex - x.logIndex);
}

export const EVENT_NAMES = ["ClaimSubmitted", "ClaimStatusChanged", "PayoutWithdrawn", "PoolFunded"];

/** Загрузка истории событий из журнала EVM. */
export async function fetchEvents(contract, fromBlock = 0) {
  const all = [];
  for (const name of EVENT_NAMES) {
    const logs = await contract.queryFilter(contract.filters[name](), fromBlock, "latest");
    all.push(...logs.map(toEventRecord));
  }
  return mergeEvents([], all);
}

/** Чтения состояния. */
export async function readState(contract, account) {
  const [pool, reserved, nextId] = await Promise.all([
    contract.poolBalance(),
    contract.reserved(),
    contract.nextClaimId(),
  ]);
  let isAdjuster = false;
  let isAdmin = false;
  if (account) {
    const [adjRole, adminRole] = await Promise.all([contract.ADJUSTER_ROLE(), contract.DEFAULT_ADMIN_ROLE()]);
    [isAdjuster, isAdmin] = await Promise.all([contract.hasRole(adjRole, account), contract.hasRole(adminRole, account)]);
  }
  return { pool, reserved, nextId, isAdjuster, isAdmin };
}

export async function readClaim(contract, id) {
  const [claimant, amount, evidence, status] = await contract.getClaim(id);
  return { id: Number(id), claimant, amount, evidence, status: STATUS[Number(status)] };
}

/** Структурированная запись журнала приложения (без секретов). */
export function appLog(event, fields = {}) {
  const rec = { ts: new Date().toISOString(), source: "dapp", event, ...fields };
  // Запрещённые поля никогда не логируются
  for (const k of ["privateKey", "mnemonic", "password", "seed"]) delete rec[k];
  return rec;
}
