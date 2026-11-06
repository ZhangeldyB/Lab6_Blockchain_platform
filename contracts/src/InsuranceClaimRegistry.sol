// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title InsuranceClaimRegistry (защищённая версия)
/// @notice Вариант 2 — страхование. Регистрация этапа обработки страхового
///         случая: claimId, статус, хеш доказательства, выплата в ETH.
/// @dev В блокчейне хранится только хеш доказательства (keccak256), а не сами
///      документы. Выплата реализована по шаблону pull-payment с CEI и
///      ReentrancyGuard.
contract InsuranceClaimRegistry is AccessControl, ReentrancyGuard {
    // --- Роли ---
    bytes32 public constant ADJUSTER_ROLE = keccak256("ADJUSTER_ROLE");

    // --- Состояния страхового случая ---
    enum Status {
        None,       // 0 - случай не существует
        Submitted,  // 1 - подан заявителем
        UnderReview,// 2 - принят в обработку оценщиком
        Approved,   // 3 - одобрен, сумма зарезервирована под выплату
        Rejected,   // 4 - отклонён
        Paid        // 5 - выплата получена заявителем
    }

    struct Claim {
        address claimant;      // кто подал случай
        uint256 amount;        // запрашиваемая сумма выплаты, wei
        bytes32 evidenceHash;  // keccak256 пакета документов (off-chain)
        Status status;
    }

    uint256 public nextClaimId = 1;
    mapping(uint256 => Claim) private _claims;

    /// @notice Сумма средств, зарезервированных под одобренные, но ещё не
    ///         полученные выплаты. Ключевая величина для инварианта платёжеспособности.
    uint256 public reserved;

    // --- События ---
    event ClaimSubmitted(uint256 indexed claimId, address indexed claimant, uint256 amount, bytes32 evidenceHash);
    event ClaimStatusChanged(uint256 indexed claimId, Status indexed from, Status indexed to);
    event PayoutWithdrawn(uint256 indexed claimId, address indexed claimant, uint256 amount);
    event PoolFunded(address indexed from, uint256 amount);

    // --- Пользовательские ошибки ---
    error ClaimNotFound(uint256 claimId);
    error ZeroAmount();
    error InvalidEvidence();
    error WrongStatus(Status expected, Status actual);
    error NotClaimant(address caller);
    error InsufficientPool(uint256 requested, uint256 available);

    constructor(address insurer) {
        // insurer получает и права администратора, и права оценщика
        _grantRole(DEFAULT_ADMIN_ROLE, insurer);
        _grantRole(ADJUSTER_ROLE, insurer);
    }

    /// @notice Пополнение страхового пула, из которого платятся выплаты.
    function fundPool() external payable onlyRole(DEFAULT_ADMIN_ROLE) {
        if (msg.value == 0) revert ZeroAmount();
        emit PoolFunded(msg.sender, msg.value);
    }

    /// @notice Заявитель подаёт страховой случай.
    /// @param amount запрашиваемая выплата (wei)
    /// @param evidenceHash keccak256 пакета документов, хранящихся вне блокчейна
    function submitClaim(uint256 amount, bytes32 evidenceHash) external returns (uint256 claimId) {
        if (amount == 0) revert ZeroAmount();
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();

        claimId = nextClaimId++;
        _claims[claimId] = Claim({
            claimant: msg.sender,
            amount: amount,
            evidenceHash: evidenceHash,
            status: Status.Submitted
        });

        emit ClaimSubmitted(claimId, msg.sender, amount, evidenceHash);
        emit ClaimStatusChanged(claimId, Status.None, Status.Submitted);
    }

    /// @notice Оценщик принимает случай в обработку.
    function startReview(uint256 claimId) external onlyRole(ADJUSTER_ROLE) {
        Claim storage c = _get(claimId);
        _requireStatus(c, Status.Submitted);
        c.status = Status.UnderReview;
        emit ClaimStatusChanged(claimId, Status.Submitted, Status.UnderReview);
    }

    /// @notice Оценщик одобряет случай и резервирует сумму под выплату.
    function approveClaim(uint256 claimId) external onlyRole(ADJUSTER_ROLE) {
        Claim storage c = _get(claimId);
        _requireStatus(c, Status.UnderReview);

        uint256 available = address(this).balance - reserved;
        if (c.amount > available) revert InsufficientPool(c.amount, available);

        reserved += c.amount;
        c.status = Status.Approved;
        emit ClaimStatusChanged(claimId, Status.UnderReview, Status.Approved);
    }

    /// @notice Оценщик отклоняет случай (только из статусов Submitted/UnderReview).
    function rejectClaim(uint256 claimId) external onlyRole(ADJUSTER_ROLE) {
        Claim storage c = _get(claimId);
        if (c.status != Status.Submitted && c.status != Status.UnderReview) {
            revert WrongStatus(Status.UnderReview, c.status);
        }
        Status from = c.status;
        c.status = Status.Rejected;
        emit ClaimStatusChanged(claimId, from, Status.Rejected);
    }

    /// @notice Заявитель забирает одобренную выплату (pull-payment).
    /// @dev Порядок: проверки -> изменение состояния -> внешний вызов (CEI),
    ///      дополнительно защищено nonReentrant.
    function withdrawPayout(uint256 claimId) external nonReentrant {
        Claim storage c = _get(claimId);
        if (c.claimant != msg.sender) revert NotClaimant(msg.sender);
        _requireStatus(c, Status.Approved);

        uint256 amount = c.amount;

        // Checks-Effects-Interactions: сначала фиксируем состояние
        c.status = Status.Paid;
        reserved -= amount;

        emit ClaimStatusChanged(claimId, Status.Approved, Status.Paid);
        emit PayoutWithdrawn(claimId, msg.sender, amount);

        // Внешний вызов в самом конце
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "payout transfer failed");
    }

    // --- Чтение ---
    function getClaim(uint256 claimId)
        external
        view
        returns (address claimant, uint256 amount, bytes32 evidenceHash, Status status)
    {
        Claim storage c = _get(claimId);
        return (c.claimant, c.amount, c.evidenceHash, c.status);
    }

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // --- Внутреннее ---
    function _get(uint256 claimId) private view returns (Claim storage c) {
        c = _claims[claimId];
        if (c.status == Status.None) revert ClaimNotFound(claimId);
    }

    function _requireStatus(Claim storage c, Status expected) private view {
        if (c.status != expected) revert WrongStatus(expected, c.status);
    }
}
