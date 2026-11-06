// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {InsuranceClaimRegistry} from "../src/InsuranceClaimRegistry.sol";

/// @notice Handler генерирует случайные последовательности вызовов от разных ролей.
contract Handler is Test {
    InsuranceClaimRegistry public reg;
    address public insurer;
    address[] public actors;
    uint256[] public ids;

    // Счётчик выплат по каждому id - для инварианта "нет двойных выплат"
    mapping(uint256 => uint256) public payouts;
    // Число успешных привилегированных вызовов от адресов без роли
    uint256 public unauthorizedSuccesses;

    constructor(InsuranceClaimRegistry _reg, address _insurer) {
        reg = _reg;
        insurer = _insurer;
        actors.push(makeAddr("a1"));
        actors.push(makeAddr("a2"));
        actors.push(makeAddr("a3"));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _id(uint256 seed) internal view returns (uint256) {
        if (ids.length == 0) return 1;
        return ids[seed % ids.length];
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 5 ether);
        vm.deal(insurer, amount);
        vm.prank(insurer);
        reg.fundPool{value: amount}();
    }

    function submit(uint256 actorSeed, uint256 amount) external {
        amount = bound(amount, 1, 3 ether);
        vm.prank(_actor(actorSeed));
        ids.push(reg.submitClaim(amount, keccak256(abi.encode(actorSeed, amount))));
    }

    function review(uint256 idSeed) external {
        vm.prank(insurer);
        try reg.startReview(_id(idSeed)) {} catch {}
    }

    function approve(uint256 idSeed) external {
        vm.prank(insurer);
        try reg.approveClaim(_id(idSeed)) {} catch {}
    }

    function reject(uint256 idSeed) external {
        vm.prank(insurer);
        try reg.rejectClaim(_id(idSeed)) {} catch {}
    }

    function withdraw(uint256 idSeed, uint256 actorSeed) external {
        uint256 id = _id(idSeed);
        vm.prank(_actor(actorSeed));
        try reg.withdrawPayout(id) {
            payouts[id]++;
        } catch {}
    }

    /// Попытки привилегированных действий от адресов без роли
    function attackPrivileged(uint256 actorSeed, uint256 idSeed) external {
        address a = _actor(actorSeed);
        uint256 id = _id(idSeed);
        vm.startPrank(a);
        try reg.startReview(id) { unauthorizedSuccesses++; } catch {}
        try reg.approveClaim(id) { unauthorizedSuccesses++; } catch {}
        try reg.rejectClaim(id) { unauthorizedSuccesses++; } catch {}
        vm.stopPrank();
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }
}

/// @notice Три инварианта безопасности из модели STRIDE (раздел 2.1 отчёта).
contract InvariantTest is Test {
    InsuranceClaimRegistry reg;
    Handler handler;
    address insurer = makeAddr("insurer");

    function setUp() public {
        reg = new InsuranceClaimRegistry(insurer);
        handler = new Handler(reg, insurer);
        targetContract(address(handler));
    }

    /// I1 (авторизация): ни один адрес без ADJUSTER_ROLE не смог изменить статус случая.
    function invariant_I1_OnlyAdjusterChangesStatus() public view {
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    /// I2 (платёжеспособность и целостность резерва): баланс >= reserved,
    ///     reserved == сумма amount по одобренным случаям.
    function invariant_I2_SolvencyAndReserve() public view {
        assertGe(address(reg).balance, reg.reserved());
        uint256 sum;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            (, uint256 amount,, InsuranceClaimRegistry.Status st) = reg.getClaim(handler.ids(i));
            if (st == InsuranceClaimRegistry.Status.Approved) sum += amount;
        }
        assertEq(reg.reserved(), sum);
    }

    /// I3 (нет двойных выплат): по каждому случаю не более одной выплаты,
    ///     и выплата была только у случаев в статусе Paid.
    function invariant_I3_NoDoublePayout() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            uint256 id = handler.ids(i);
            uint256 p = handler.payouts(id);
            assertLe(p, 1);
            if (p == 1) {
                (,,, InsuranceClaimRegistry.Status st) = reg.getClaim(id);
                assertEq(uint8(st), uint8(InsuranceClaimRegistry.Status.Paid));
            }
        }
    }
}
