"""Графики нагрузочного эксперимента: python3 ops/loadtest/plot.py"""
import json, os, statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.join(os.path.dirname(__file__), "../../reports")
LOAD, FIG = os.path.join(ROOT, "load"), os.path.join(ROOT, "figures")
os.makedirs(FIG, exist_ok=True)
C = {"sequential": "#2a78d6", "parallel5": "#eb6834", "pipelined": "#1baf7a"}
LBL = {"sequential": "30 последовательных", "parallel5": "5 клиентов × 6", "pipelined": "конвейер (оптимизация)"}
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": "#c3c2b7",
                     "axes.labelcolor": "#52514e", "xtick.color": "#52514e", "ytick.color": "#52514e",
                     "axes.spines.top": False, "axes.spines.right": False})

def load(name):
    p = os.path.join(LOAD, name)
    return json.load(open(p)) if os.path.exists(p) else {}

def latency_chart(raw, profiles, title, fname, ylabel="Задержка, мс", ylim=None):
    fig, ax = plt.subplots(figsize=(8, 3.8))
    for prof in profiles:
        rows = sorted(raw[f"{prof}-1"], key=lambda r: r["t0"])
        ax.plot(range(1, len(rows) + 1), [r["latencyMs"] for r in rows], color=C[prof], lw=2,
                marker="o", ms=4, label=LBL[prof])
    ax.set_xlabel("Номер транзакции (в порядке отправки)"); ax.set_ylabel(ylabel)
    ax.set_title(title, loc="left", fontsize=11, color="#0b0b0b")
    ax.grid(axis="y", color="#ecebe7", lw=0.8)
    ax.set_ylim(*ylim) if ylim else ax.set_ylim(bottom=0)
    ax.legend(frameon=False, loc="lower right", ncol=len(profiles))
    fig.tight_layout(); fig.savefig(os.path.join(FIG, fname), dpi=200); plt.close(fig)

auto = load("automine-raw.json"); bt = load("blocktime1s-raw.json")
pipe = load("blocktime1s-pipelined-raw.json"); bt.update(pipe)
latency_chart(auto, ["sequential", "parallel5"], "Задержка транзакций, Anvil automine (прогон 1)", "latency_automine.png")
latency_chart(bt, ["sequential", "parallel5", "pipelined"], "Задержка транзакций, Anvil block-time 1 с (прогон 1)", "latency_blocktime.png", ylim=(940, 1030))

# Пропускная способность: медиана по 3 прогонам, отдельные оси для двух режимов
def med(summary, prof, key):
    return statistics.median([s[key] for s in summary if s["profile"] == prof])
sa = load("automine-summary.json"); sb = load("blocktime1s-summary.json") + load("blocktime1s-pipelined-summary.json")
fig, axes = plt.subplots(1, 2, figsize=(8, 3.6))
for ax, summ, profs, ttl in [(axes[0], sa, ["sequential", "parallel5"], "automine"),
                             (axes[1], sb, ["sequential", "parallel5", "pipelined"], "block-time 1 с")]:
    vals = [med(summ, p, "throughput") for p in profs]
    bars = ax.bar(range(len(profs)), vals, color=[C[p] for p in profs], width=0.6)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v, f"{v:g}", ha="center", va="bottom", fontsize=9, color="#0b0b0b")
    ax.set_xticks(range(len(profs))); ax.set_xticklabels([LBL[p].replace(" (", "\n(").replace("30 ", "30\n") for p in profs], fontsize=8)
    ax.set_title(f"Пропускная способность, {ttl}", loc="left", fontsize=10, color="#0b0b0b")
    ax.set_ylabel("операций/с"); ax.grid(axis="y", color="#ecebe7", lw=0.8); ax.set_axisbelow(True)
fig.tight_layout(); fig.savefig(os.path.join(FIG, "throughput.png"), dpi=200); plt.close(fig)
print("ok")
