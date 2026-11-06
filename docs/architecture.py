"""Архитектурная схема: python3 docs/architecture.py -> reports/figures/architecture.png"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

INK, MUTED, LINE = "#0b0b0b", "#52514e", "#77766d"
BLUE, ORANGE, GREEN, VIOLET, RED = "#2a78d6", "#eb6834", "#1baf7a", "#6250d6", "#c23b3b"
plt.rcParams["font.family"] = "DejaVu Sans"
fig, ax = plt.subplots(figsize=(14, 7.6)); ax.set_xlim(0, 140); ax.set_ylim(0, 76); ax.axis("off")

def zone(x, y, w, h, label, color):
    ax.add_patch(Rectangle((x, y), w, h, fill=False, ls=(0, (5, 3)), lw=1.4, ec=color))
    ax.text(x + 1, y + h - 1.2, label, fontsize=9, color=color, va="top")

def box(x, y, w, h, title, lines, color):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.3,rounding_size=1.2", fc="white", ec=color, lw=2))
    ax.text(x + w / 2, y + h - 2.2, title, ha="center", va="top", fontsize=10.5, weight="bold", color=INK)
    for i, l in enumerate(lines):
        ax.text(x + w / 2, y + h - 6.2 - i * 2.8, l, ha="center", va="top", fontsize=8.2, color=MUTED)

def path(pts, color, label=None, lx=None, ly=None, ha="center"):
    xs, ys = zip(*pts)
    ax.plot(xs[:-1], ys[:-1], color=color, lw=1.6)
    ax.annotate("", xy=pts[-1], xytext=pts[-2], arrowprops=dict(arrowstyle="-|>", color=color, lw=1.6))
    if label:
        ax.text(lx, ly, label, ha=ha, fontsize=8, color=color, zorder=4, bbox=dict(fc="white", ec="none", pad=0.6))

def check(x, y, n):
    ax.add_patch(plt.Circle((x, y), 1.5, color=RED, zorder=5))
    ax.text(x, y, n, ha="center", va="center", fontsize=8, color="white", weight="bold", zorder=6)

zone(1, 20, 57, 48, "Зона пользователя (браузер, устройство)", BLUE)
zone(61, 20, 26, 48, "Зона инфраструктуры (RPC)", ORANGE)
zone(90, 20, 28, 48, "Зона блокчейна (EVM, консенсус)", GREEN)
zone(121, 20, 18, 48, "Эксплуатация", VIOLET)

box(3, 44, 16, 16, "Пользователь", ["владелец", "аккаунта"], INK)
box(24, 44, 30, 16, "dApp (React)", ["ethers.js v6", "проверка chainId, preflight", "этапы tx, журнал событий"], BLUE)
box(24, 24, 30, 13, "Кошелёк", ["MetaMask, закрытый ключ", "подпись транзакции"], BLUE)
box(64, 30, 20, 26, "RPC-узел", ["Anvil :8545", "eth_call", "eth_sendRawTx", "eth_getLogs", "receipts"], ORANGE)
box(93, 34, 22, 22, "Смарт-контракт", ["InsuranceClaim-", "Registry", "AccessControl", "ReentrancyGuard"], GREEN)
box(123, 34, 14, 22, "Монитор", ["события", "квитанции", "ошибки RPC", "правила R1, R2"], VIOLET)

path([(19, 52), (24, 52)], LINE, "UI", 21.5, 53)
path([(39, 44), (39, 37)], BLUE, "запрос подписи", 40, 40.2, ha="left")
path([(54, 30), (64, 36)], BLUE, "подписанная tx", 56, 33.6)
path([(54, 52), (64, 50)], MUTED, "чтения", 59, 52.3)
path([(84, 48), (93, 48)], ORANGE, "вызов", 88.5, 49)
path([(93, 40), (84, 40)], GREEN, "логи", 88.5, 37.8)
path([(130, 34), (130, 26), (74, 26), (74, 30)], VIOLET, "опрос блоков, квитанций; ошибки RPC", 102, 23.6)
path([(39, 60), (39, 63), (130, 63), (130, 56)], LINE, "журнал dApp: HTTP /telemetry, correlationId", 84, 63.8)

check(25, 59.5, "1"); check(25, 36.5, "2"); check(94, 55.5, "3")
ax.text(2, 15, "Точки проверки:  1 - dApp: chainId и предварительная симуляция eth_call (удобство, не защита);  "
        "2 - кошелёк: пользователь подтверждает подпись;", fontsize=8.8, color=INK)
ax.text(2, 11.8, "3 - контракт: onlyRole(ADJUSTER_ROLE / DEFAULT_ADMIN_ROLE), claimant == msg.sender, проверка статуса - "
        "единственная обязательная проверка полномочий.", fontsize=8.8, color=INK)
ax.text(2, 7.6, "Пунктир - доверительные границы. Состояние и события берутся только из контракта через RPC; ввод пользователя "
        "и ответы RPC недоверенные; в сеть уходит только keccak256 документов.", fontsize=8.8, color=MUTED)
fig.tight_layout()
out = os.path.join(os.path.dirname(__file__), "../reports/figures/architecture.png")
fig.savefig(out, dpi=200)
