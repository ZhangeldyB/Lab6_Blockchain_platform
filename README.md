# Lab6_Blockchain_platform — Практическая работа №5

Web3-интеграция, тестирование безопасности, обнаружение угроз и DevSecOps для контракта
`InsuranceClaimRegistry` из практической работы №3 (вариант 2 — страхование, чётный → Foundry).

| Часть | Технологии |
|---|---|
| Контракт | Solidity 0.8.30, OpenZeppelin 5.4.0 (AccessControl, ReentrancyGuard), Foundry |
| Локальная сеть | Anvil (chainId 31337) |
| Клиент | React 18 + Vite 6 + ethers.js v6, MetaMask |
| Мониторинг | Node.js 22 + ethers v6, правила R1/R2, JSONL-журналы |
| CI | GitHub Actions: сборка, тесты, Slither, npm audit, демонстрация мониторинга |

## Структура

```
contracts/                 Foundry-проект
  src/InsuranceClaimRegistry.sol
  test/Integration.t.sol   9 интеграционных + 2 fuzz-теста
  test/Invariant.t.sol     3 инварианта безопасности (handler)
  script/Deploy.s.sol      развёртывание в Anvil
  install-deps.sh          forge-std 1.17.0, OpenZeppelin 5.4.0
frontend/                  dApp
  src/App.jsx              интерфейс
  src/lib/registry.js      интеграционная логика (этапы tx, ошибки, события)
  test/integration.test.js 8 интеграционных тестов против Anvil
ops/
  monitor/monitor.js       сбор телеметрии и правила обнаружения
  monitor/rules.js         R1 (нарушение доступа), R2 (эксплуатационный сбой)
  scripts/demo-monitoring.js  штатный сценарий + срабатывание R1 и R2
  loadtest/loadtest.js     нагрузочный эксперимент
  loadtest/plot.py         графики
reports/                   протоколы проверок, журналы, результаты нагрузки, рисунки
.github/workflows/ci.yml   CI-конвейер
```

## Быстрый старт

Требуется Foundry, Node.js 22, Python 3 (для Slither и графиков).

```bash
# 1. Контракт
cd contracts && ./install-deps.sh && forge build && forge test -vv

# 2. Локальная сеть (отдельный терминал)
anvil

# 3. Развёртывание (ключ аккаунта #0 Anvil - публичный тестовый ключ, только для локальной сети)
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/Deploy.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast
# адрес контракта будет 0x5FbDB2315678afecb367f032d93F642f64180aa3 (первое развёртывание)

# 4. Мониторинг (отдельный терминал)
cd ../ops && npm ci
CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3 FROM_BLOCK=1 npm run monitor

# 5. dApp
cd ../frontend && cp .env.example .env && npm ci && npm run dev   # http://localhost:5173
```

### MetaMask для демонстрации

Добавьте сеть: RPC `http://127.0.0.1:8545`, chainId `31337`, символ ETH. Импортируйте тестовые
аккаунты Anvil (их ключи печатает `anvil` при старте):

- аккаунт #0 — страховщик (DEFAULT_ADMIN_ROLE + ADJUSTER_ROLE);
- аккаунт #1 — заявитель;
- аккаунт #2 — злоумышленник без ролей (негативный сценарий).

После перезапуска Anvil в MetaMask нужно сбросить историю аккаунта
(Настройки → Дополнительно → Очистить данные вкладки активности), иначе nonce не совпадёт.

## Проверки

```bash
cd contracts && forge test -vv                       # 14 тестов: интеграция, fuzz, инварианты
cd contracts && slither . --filter-paths "lib/|test/" # статический анализ
cd frontend && npm test                               # 8 интеграционных тестов dApp
cd frontend && npm audit                              # зависимости клиента
cd ops && npm test                                    # 5 тестов правил обнаружения
cd ops && node scripts/demo-monitoring.js             # демонстрация R1 и R2
cd ops && node loadtest/loadtest.js --reps 3          # нагрузка, automine
cd ops && node loadtest/loadtest.js --reps 3 --block-time 1
cd ops && node loadtest/loadtest.js --reps 3 --block-time 1 --profiles pipelined
python3 ops/loadtest/plot.py                          # графики в reports/figures
```

## Секреты

В репозитории нет закрытых ключей, seed-фраз и паролей. В коде используются только
общеизвестные тестовые ключи Anvil (мнемоника `test test ... junk`), они не имеют ценности вне
локальной сети. Монитор удаляет из записей поля `privateKey`, `mnemonic`, `seed`, `password`,
`secret`, `authorization`. Файлы `.env` исключены через `.gitignore`.
