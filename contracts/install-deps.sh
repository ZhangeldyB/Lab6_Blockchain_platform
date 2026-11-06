#!/usr/bin/env bash
# Зависимости контракта с фиксированными версиями (lib/ не хранится в git)
set -euo pipefail
cd "$(dirname "$0")"
[ -d lib/forge-std ] || forge install foundry-rs/forge-std@v1.17.0 --no-git
[ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git
