// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {InsuranceClaimRegistry} from "../src/InsuranceClaimRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Интеграционные сценарии: полный жизненный цикл страхового случая,
///         негативные сценарии авторизации, проверка изменения состояния и событий.
contract IntegrationTest is Test {
    InsuranceClaimRegistry reg;
    address insurer = makeAddr("insurer");
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");
    bytes32 constant EVIDENCE = keccak256("claim-docs-001");

    event ClaimSubmitted(uint256 indexed claimId, address indexed claimant, uint256 amount, bytes32 evidenceHash);
    event ClaimStatusChanged(
        uint256 indexed claimId, InsuranceClaimRegistry.Status indexed from, InsuranceClaimRegistry.Status indexed to
    );
    event PayoutWithdrawn(uint256 indexed claimId, address indexed claimant, uint256 amount);

    function setUp() public {
        reg = new InsuranceClaimRegistry(insurer);
        vm.deal(insurer, 100 ether);
        vm.prank(insurer);
        reg.fundPool{value: 10 ether}();
    }

    function _submitAndApprove(uint256 amount) internal returns (uint256 id) {
        vm.prank(alice);
        id = reg.submitClaim(amount, EVIDENCE);
        vm.startPrank(insurer);
        reg.startReview(id);
        reg.approveClaim(id);
        vm.stopPrank();
    }

    // 1. Положительный: полный цикл, баланс заявителя и пула меняются ровно на сумму выплаты
    function test_FullLifecycle_ChangesStateAndBalances() public {
        uint256 id = _submitAndApprove(1 ether);
        assertEq(reg.reserved(), 1 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        reg.withdrawPayout(id);

        (,,, InsuranceClaimRegistry.Status st) = reg.getClaim(id);
        assertEq(uint8(st), uint8(InsuranceClaimRegistry.Status.Paid));
        assertEq(alice.balance - before, 1 ether);
        assertEq(reg.poolBalance(), 9 ether);
        assertEq(reg.reserved(), 0);
    }

    // 2. События: submitClaim порождает ClaimSubmitted и ClaimStatusChanged(None->Submitted)
    function test_Submit_EmitsEvents() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit ClaimSubmitted(1, alice, 2 ether, EVIDENCE);
        vm.expectEmit(true, true, true, false, address(reg));
        emit ClaimStatusChanged(1, InsuranceClaimRegistry.Status.None, InsuranceClaimRegistry.Status.Submitted);
        vm.prank(alice);
        reg.submitClaim(2 ether, EVIDENCE);
    }

    // 3. События: журнал выплаты содержит ровно одно событие PayoutWithdrawn
    function test_Withdraw_EmitsSinglePayoutEvent() public {
        uint256 id = _submitAndApprove(1 ether);
        vm.recordLogs();
        vm.prank(alice);
        reg.withdrawPayout(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == PayoutWithdrawn.selector) count++;
        }
        assertEq(count, 1);
    }

    // 4. Негативный: approveClaim без ADJUSTER_ROLE -> AccessControlUnauthorizedAccount
    function test_RevertWhen_NonAdjusterApproves() public {
        vm.prank(alice);
        uint256 id = reg.submitClaim(1 ether, EVIDENCE);
        vm.prank(insurer);
        reg.startReview(id);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, reg.ADJUSTER_ROLE()
            )
        );
        vm.prank(mallory);
        reg.approveClaim(id);
    }

    // 5. Негативный: fundPool доступен только администратору
    function test_RevertWhen_NonAdminFunds() public {
        vm.deal(mallory, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, reg.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(mallory);
        reg.fundPool{value: 1 ether}();
    }

    // 6. Негативный: чужой адрес не может забрать выплату
    function test_RevertWhen_StrangerWithdraws() public {
        uint256 id = _submitAndApprove(1 ether);
        vm.expectRevert(abi.encodeWithSelector(InsuranceClaimRegistry.NotClaimant.selector, mallory));
        vm.prank(mallory);
        reg.withdrawPayout(id);
    }

    // 7. Негативный: повторная выплата невозможна, состояние не меняется после отката
    function test_RevertWhen_DoubleWithdraw() public {
        uint256 id = _submitAndApprove(1 ether);
        vm.prank(alice);
        reg.withdrawPayout(id);
        uint256 poolAfterFirst = reg.poolBalance();

        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceClaimRegistry.WrongStatus.selector,
                InsuranceClaimRegistry.Status.Approved,
                InsuranceClaimRegistry.Status.Paid
            )
        );
        vm.prank(alice);
        reg.withdrawPayout(id);
        assertEq(reg.poolBalance(), poolAfterFirst);
    }

    // 8. Негативный: одобрение сверх свободного остатка пула
    function test_RevertWhen_ApproveExceedsPool() public {
        vm.prank(alice);
        uint256 id = reg.submitClaim(11 ether, EVIDENCE);
        vm.startPrank(insurer);
        reg.startReview(id);
        vm.expectRevert(abi.encodeWithSelector(InsuranceClaimRegistry.InsufficientPool.selector, 11 ether, 10 ether));
        reg.approveClaim(id);
        vm.stopPrank();
    }

    // 9. Негативный: пустой хеш доказательства и нулевая сумма отклоняются
    function test_RevertWhen_InvalidInput() public {
        vm.startPrank(alice);
        vm.expectRevert(InsuranceClaimRegistry.InvalidEvidence.selector);
        reg.submitClaim(1 ether, bytes32(0));
        vm.expectRevert(InsuranceClaimRegistry.ZeroAmount.selector);
        reg.submitClaim(0, EVIDENCE);
        vm.stopPrank();
    }

    // --- Fuzz / property-based ---

    // F1. Любой адрес без роли не может изменить статус случая
    function testFuzz_NoRoleCannotChangeStatus(address caller) public {
        vm.assume(caller != insurer);
        vm.prank(alice);
        uint256 id = reg.submitClaim(1 ether, EVIDENCE);

        vm.prank(caller);
        vm.expectRevert();
        reg.startReview(id);

        (,,, InsuranceClaimRegistry.Status st) = reg.getClaim(id);
        assertEq(uint8(st), uint8(InsuranceClaimRegistry.Status.Submitted));
    }

    // F2. Для любой допустимой суммы выплата равна заявленной, резерв возвращается в 0
    function testFuzz_PayoutEqualsClaim(uint256 amount) public {
        amount = bound(amount, 1, 10 ether);
        uint256 id = _submitAndApprove(amount);
        uint256 before = alice.balance;
        vm.prank(alice);
        reg.withdrawPayout(id);
        assertEq(alice.balance - before, amount);
        assertEq(reg.reserved(), 0);
    }
}
