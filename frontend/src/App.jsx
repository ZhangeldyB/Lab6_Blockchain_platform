import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, JsonRpcProvider, formatEther, parseEther } from "ethers";
import {
  Stage,
  appLog,
  evidenceHash,
  fetchEvents,
  getContract,
  mergeEvents,
  readClaim,
  readState,
  runTx,
  toEventRecord,
  EVENT_NAMES,
} from "./lib/registry.js";

const CONTRACT = import.meta.env.VITE_CONTRACT_ADDRESS;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
const TELEMETRY_URL = import.meta.env.VITE_TELEMETRY_URL; // опционально: коллектор мониторинга

const STAGE_LABEL = {
  [Stage.IDLE]: "—",
  [Stage.AWAITING_SIGNATURE]: "Ожидание подписи в кошельке…",
  [Stage.SENT]: "Транзакция отправлена",
  [Stage.CONFIRMING]: "Ожидание подтверждения…",
  [Stage.SUCCESS]: "Успех",
  [Stage.REJECTED]: "Отказ в подписи",
  [Stage.WRONG_NETWORK]: "Неверная сеть",
  [Stage.REVERTED]: "Откат транзакции",
  [Stage.ERROR]: "Ошибка",
};

function short(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

function sendTelemetry(rec) {
  console.info("[telemetry]", JSON.stringify(rec));
  if (!TELEMETRY_URL) return;
  fetch(TELEMETRY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) }).catch(
    () => {}
  );
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [state, setState] = useState(null);
  const [claim, setClaim] = useState(null);
  const [events, setEvents] = useState([]);
  const [tx, setTx] = useState({ stage: Stage.IDLE });
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({ amount: "1", evidence: "фото повреждений, акт осмотра", claimId: "1" });
  const [preflight, setPreflight] = useState(true);
  const signerRef = useRef(null);

  // Чтения идут через публичный RPC, чтобы работать и без кошелька
  const readProvider = useMemo(() => new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true }), []);
  const readContract = useMemo(() => (CONTRACT ? getContract(CONTRACT, readProvider) : null), [readProvider]);

  const wrongNetwork = account && chainId !== null && chainId !== CHAIN_ID;

  const refresh = useCallback(async () => {
    if (!readContract) return;
    setState(await readState(readContract, account));
  }, [readContract, account]);

  // --- Кошелёк ---
  const connect = async () => {
    if (!window.ethereum) {
      alert("Кошелёк не найден. Установите MetaMask.");
      return;
    }
    const provider = new BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_requestAccounts", []);
    const net = await provider.getNetwork();
    signerRef.current = await provider.getSigner();
    setAccount(accounts[0]);
    setChainId(Number(net.chainId));
    sendTelemetry(appLog("wallet_connected", { account: accounts[0], chainId: Number(net.chainId) }));
  };

  // Завершение сеанса в приложении: сбрасываем signer и состояние.
  // Разрешение сайта в кошельке отзывается отдельно (wallet_revokePermissions, если поддерживается).
  const disconnect = async () => {
    try {
      await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      /* не все кошельки поддерживают метод */
    }
    sendTelemetry(appLog("wallet_disconnected", { account }));
    signerRef.current = null;
    setAccount(null);
    setChainId(null);
    setTx({ stage: Stage.IDLE });
  };

  const switchNetwork = async () => {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CHAIN_ID.toString(16) }] });
  };

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccounts = async (accs) => {
      if (!accs.length) return disconnect();
      const provider = new BrowserProvider(window.ethereum);
      signerRef.current = await provider.getSigner();
      setAccount(accs[0]);
    };
    const onChain = async (hex) => {
      setChainId(parseInt(hex, 16));
      if (window.ethereum) signerRef.current = await new BrowserProvider(window.ethereum).getSigner().catch(() => null);
    };
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- События: история + подписка, без дублей (ключ txHash:logIndex) ---
  useEffect(() => {
    if (!readContract) return;
    let alive = true;
    fetchEvents(readContract).then((list) => alive && setEvents((prev) => mergeEvents(prev, list)));
    const handlers = EVENT_NAMES.map((name) => {
      const h = (...args) => {
        const ev = args[args.length - 1];
        setEvents((prev) => mergeEvents(prev, [toEventRecord(ev.log)]));
        refresh();
      };
      readContract.on(name, h);
      return [name, h];
    });
    return () => {
      alive = false;
      handlers.forEach(([n, h]) => readContract.off(n, h));
    };
  }, [readContract, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // --- Изменение состояния ---
  const exec = async (label, method, args, overrides = {}) => {
    if (!signerRef.current) return alert("Сначала подключите кошелёк");
    const correlationId = crypto.randomUUID();
    const contract = getContract(CONTRACT, signerRef.current);
    sendTelemetry(appLog("tx_requested", { correlationId, method, account, chainId }));
    // Без preflight задаём лимит газа вручную, иначе оценка газа сама отклонит вызов,
    // и откат произойдёт уже в блоке (status=0) - это нужно для демонстрации.
    const ov = preflight ? overrides : { gasLimit: 300000n, ...overrides };
    const result = await runTx({
      contract,
      method,
      args,
      overrides: ov,
      expectedChainId: CHAIN_ID,
      preflight,
      onStage: (s) => setTx({ label, ...s }),
    });
    sendTelemetry(appLog("tx_result", { correlationId, method, account, ...result }));
    setHistory((h) => [{ label, correlationId, ...result, ts: new Date().toLocaleTimeString() }, ...h].slice(0, 20));
    refresh();
  };

  const loadClaim = async () => {
    try {
      setClaim(await readClaim(readContract, BigInt(form.claimId)));
    } catch (e) {
      setClaim({ error: e.shortMessage ?? e.message });
    }
  };

  if (!CONTRACT) return <div className="card">Укажите VITE_CONTRACT_ADDRESS в frontend/.env</div>;

  return (
    <div className="wrap">
      <header>
        <h1>Реестр страховых случаев</h1>
        <div className="wallet">
          {account ? (
            <>
              <span className="mono">{short(account)}</span>
              <span className={wrongNetwork ? "badge bad" : "badge ok"}>chainId {chainId}</span>
              {state?.isAdjuster && <span className="badge">ADJUSTER</span>}
              <button onClick={disconnect}>Выйти</button>
            </>
          ) : (
            <button onClick={connect}>Подключить кошелёк</button>
          )}
        </div>
      </header>

      {wrongNetwork && (
        <div className="card warn">
          Кошелёк подключён к сети {chainId}, приложение работает с {CHAIN_ID}. Отправка транзакций заблокирована.{" "}
          <button onClick={switchNetwork}>Переключить сеть</button>
        </div>
      )}

      <section className="grid">
        <div className="card">
          <h2>Состояние контракта</h2>
          <p className="mono small">{CONTRACT}</p>
          <dl>
            <dt>Баланс пула</dt>
            <dd>{state ? formatEther(state.pool) : "…"} ETH</dd>
            <dt>Зарезервировано</dt>
            <dd>{state ? formatEther(state.reserved) : "…"} ETH</dd>
            <dt>Следующий claimId</dt>
            <dd>{state ? state.nextId.toString() : "…"}</dd>
          </dl>
          <div className="row">
            <input value={form.claimId} onChange={(e) => setForm({ ...form, claimId: e.target.value })} placeholder="claimId" />
            <button onClick={loadClaim}>getClaim</button>
          </div>
          {claim &&
            (claim.error ? (
              <p className="err">{claim.error}</p>
            ) : (
              <p className="small">
                #{claim.id}: {claim.status}, {formatEther(claim.amount)} ETH, заявитель {short(claim.claimant)}
              </p>
            ))}
        </div>

        <div className="card">
          <h2>Операции</h2>
          <label>Сумма (ETH)</label>
          <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <label>Документы (в сеть уходит только keccak256)</label>
          <input value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} />
          <button
            disabled={!account || wrongNetwork}
            onClick={() => exec("submitClaim", "submitClaim", [parseEther(form.amount || "0"), evidenceHash(form.evidence)])}
          >
            Подать случай
          </button>
          <hr />
          <p className="small">Для claimId из поля слева:</p>
          <div className="row wrap-row">
            <button disabled={!account || wrongNetwork} onClick={() => exec("startReview", "startReview", [BigInt(form.claimId)])}>
              startReview
            </button>
            <button disabled={!account || wrongNetwork} onClick={() => exec("approveClaim", "approveClaim", [BigInt(form.claimId)])}>
              approveClaim
            </button>
            <button disabled={!account || wrongNetwork} onClick={() => exec("rejectClaim", "rejectClaim", [BigInt(form.claimId)])}>
              rejectClaim
            </button>
            <button disabled={!account || wrongNetwork} onClick={() => exec("withdrawPayout", "withdrawPayout", [BigInt(form.claimId)])}>
              withdrawPayout
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={preflight} onChange={(e) => setPreflight(e.target.checked)} /> Предварительная симуляция
            (eth_call)
          </label>
          <p className="small muted">
            Кнопки привилегированных операций не скрыты специально: полномочия проверяет контракт, а не интерфейс.
          </p>
        </div>

        <div className="card">
          <h2>Транзакция</h2>
          <p className={`stage ${tx.stage}`}>
            {tx.label ? `${tx.label}: ` : ""}
            {STAGE_LABEL[tx.stage]}
          </p>
          {tx.hash && <p className="mono small">tx {tx.hash}</p>}
          {tx.blockNumber !== undefined && (
            <p className="small">
              блок {tx.blockNumber}, gasUsed {tx.gasUsed}
            </p>
          )}
          {tx.message && <p className="err">{tx.message}</p>}
          <h3>История</h3>
          <ul className="list">
            {history.map((h) => (
              <li key={h.correlationId}>
                <span className={`dot ${h.stage}`} /> {h.ts} {h.label} — {STAGE_LABEL[h.stage]}
                {h.hash ? ` · ${short(h.hash)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card">
        <h2>События контракта ({events.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Блок</th>
              <th>Событие</th>
              <th>Детали</th>
              <th>Транзакция</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.key}>
                <td>{e.blockNumber}</td>
                <td>{e.name}</td>
                <td>{e.details}</td>
                <td className="mono">{short(e.txHash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
