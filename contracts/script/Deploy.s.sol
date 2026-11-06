// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {InsuranceClaimRegistry} from "../src/InsuranceClaimRegistry.sol";

/// @notice Развёртывание в локальной сети Anvil.
/// Аккаунт #0 Anvil становится страховщиком (админ + оценщик) и пополняет пул на 50 ETH.
contract DeployLocal is Script {
    function run() external returns (InsuranceClaimRegistry reg) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address insurer = vm.addr(pk);
        vm.startBroadcast(pk);
        reg = new InsuranceClaimRegistry(insurer);
        reg.fundPool{value: 50 ether}();
        vm.stopBroadcast();
        console.log("InsuranceClaimRegistry:", address(reg));
        console.log("Insurer (admin+adjuster):", insurer);
    }
}
