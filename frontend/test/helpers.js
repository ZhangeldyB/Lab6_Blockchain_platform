import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, parseEther } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(here, "../../contracts/out/InsuranceClaimRegistry.sol/InsuranceClaimRegistry.json");

// Публичные тестовые ключи Anvil (детерминированная мнемоника "test test ... junk").
// Это не секреты: они общеизвестны и годятся только для локальной сети.
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];

export async function startAnvil(port = 8600 + Math.floor(Math.random() * 300)) {
  const proc = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  for (let i = 0; i < 100; i++) {
    try {
      await provider.getBlockNumber();
      return { proc, url, provider, stop: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill();
  throw new Error("anvil не запустился");
}

export async function deploy(provider) {
  const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const insurer = new Wallet(ANVIL_KEYS[0], provider);
  const factory = new ContractFactory(art.abi, art.bytecode.object, insurer);
  const reg = await factory.deploy(insurer.address);
  await reg.waitForDeployment();
  await (await reg.fundPool({ value: parseEther("10") })).wait();
  return {
    address: await reg.getAddress(),
    insurer,
    alice: new Wallet(ANVIL_KEYS[1], provider),
    mallory: new Wallet(ANVIL_KEYS[2], provider),
  };
}
