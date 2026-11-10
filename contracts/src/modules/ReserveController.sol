// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IParticipantRegistry} from "../interfaces/IParticipantRegistry.sol";
import {ITokenisedTaka} from "../interfaces/ITokenisedTaka.sol";
import {SettlementModule} from "./SettlementModule.sol";

/// @title ReserveController
/// @notice Issues and redeems tBDT against the taka held in the reserve trust account.
/// @dev Issuance is maker-checker: one officer records the incoming bank transfer, a different officer
///      approves it. Supply can never exceed the balance of the most recent reserve statement, and a
///      stale statement blocks issuance altogether.
contract ReserveController is AccessControl, SettlementModule {
    /// @notice Records issuance requests against bank transfers received in the trust account.
    bytes32 public constant MAKER_ROLE = keccak256("MAKER_ROLE");
    /// @notice Approves issuance and confirms that redemption payouts were made.
    bytes32 public constant CHECKER_ROLE = keccak256("CHECKER_ROLE");
    /// @notice Publishes the balance of the reserve trust account.
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    enum RequestStatus {
        None,
        Pending,
        Completed,
        Rejected
    }

    struct ReserveStatement {
        uint64 asOf;
        uint64 publishedAt;
        uint128 balance;
        bytes32 documentHash;
        address publisher;
    }

    struct IssuanceRequest {
        bytes32 institution;
        uint128 amount;
        RequestStatus status;
        uint64 requestedAt;
        uint64 decidedAt;
        address maker;
        address checker;
        bytes32 fundingRef;
    }

    struct RedemptionRequest {
        bytes32 institution;
        address account;
        uint128 amount;
        RequestStatus status;
        uint64 requestedAt;
        uint64 decidedAt;
        address checker;
        bytes32 payoutRef;
    }

    /// @notice Oldest reserve statement, in seconds, that still supports issuance.
    uint64 public maxStatementAge;

    ReserveStatement[] private _statements;
    IssuanceRequest[] private _issuances;
    RedemptionRequest[] private _redemptions;
    mapping(bytes32 fundingRef => bool) private _fundingRefUsed;

    event MaxStatementAgeChanged(uint64 maxStatementAge);
    event ReserveStatementPublished(
        uint256 indexed index,
        uint64 asOf,
        uint256 balance,
        bytes32 documentHash,
        address indexed publisher
    );
    event IssuanceRequested(
        uint256 indexed id,
        bytes32 indexed institution,
        uint256 amount,
        bytes32 fundingRef,
        address indexed maker
    );
    event IssuanceApproved(
        uint256 indexed id,
        bytes32 indexed institution,
        address account,
        uint256 amount,
        address indexed checker
    );
    event IssuanceRejected(uint256 indexed id, bytes32 reason, address indexed checker);
    event RedemptionRequested(
        uint256 indexed id,
        bytes32 indexed institution,
        address account,
        uint256 amount,
        bytes32 payoutRef
    );
    event RedemptionSettled(uint256 indexed id, uint256 amount, address indexed checker);
    event RedemptionRejected(uint256 indexed id, bytes32 reason, address indexed checker);

    error InvalidAmount();
    error InvalidStatementDate(uint64 asOf);
    error FundingRefUsed(bytes32 fundingRef);
    error InstitutionNotActive(bytes32 institution);
    error UnknownRequest(uint256 id);
    error RequestNotPending(uint256 id, RequestStatus status);
    error MakerCannotApprove(address maker);
    error ReserveStatementMissing();
    error ReserveStatementStale(uint64 asOf, uint64 maxAge);
    error ReserveExceeded(uint256 supplyAfter, uint256 reserve);
    error NotSettlementAccount(address account);

    constructor(
        address governance,
        ITokenisedTaka token_,
        IParticipantRegistry registry_,
        uint64 maxStatementAge_
    ) SettlementModule(IERC20(address(token_)), registry_) {
        if (governance == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
        _setMaxStatementAge(maxStatementAge_);
    }

    // ------------------------------------------------------------------ reserve statements

    /// @notice Publishes the reserve balance as of `asOf`.
    /// @param documentHash Hash of the signed bank statement or assurance report.
    function publishReserveStatement(
        uint64 asOf,
        uint128 balance,
        bytes32 documentHash
    ) external onlyRole(AUDITOR_ROLE) {
        uint256 count = _statements.length;
        bool notNewer = count != 0 && asOf <= _statements[count - 1].asOf;
        if (asOf > block.timestamp || notNewer) revert InvalidStatementDate(asOf);

        _statements.push(
            ReserveStatement({
                asOf: asOf,
                publishedAt: uint64(block.timestamp),
                balance: balance,
                documentHash: documentHash,
                publisher: msg.sender
            })
        );
        emit ReserveStatementPublished(count, asOf, balance, documentHash, msg.sender);
    }

    function setMaxStatementAge(uint64 maxStatementAge_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMaxStatementAge(maxStatementAge_);
    }

    // ------------------------------------------------------------------ issuance

    /// @notice Records taka received in the trust account for `institution`.
    /// @param fundingRef Reference of the incoming bank transfer. Each reference funds one issuance.
    function requestIssuance(
        bytes32 institution,
        uint128 amount,
        bytes32 fundingRef
    ) external onlyRole(MAKER_ROLE) returns (uint256 id) {
        if (amount == 0) revert InvalidAmount();
        if (_fundingRefUsed[fundingRef]) revert FundingRefUsed(fundingRef);
        _requireActiveInstitution(institution);

        _fundingRefUsed[fundingRef] = true;
        id = _issuances.length;
        _issuances.push(
            IssuanceRequest({
                institution: institution,
                amount: amount,
                status: RequestStatus.Pending,
                requestedAt: uint64(block.timestamp),
                decidedAt: 0,
                maker: msg.sender,
                checker: address(0),
                fundingRef: fundingRef
            })
        );
        emit IssuanceRequested(id, institution, amount, fundingRef, msg.sender);
    }

    /// @notice Approves a request and mints to the institution's settlement account.
    function approveIssuance(uint256 id) external onlyRole(CHECKER_ROLE) {
        IssuanceRequest storage request = _pendingIssuance(id);
        if (request.maker == msg.sender) revert MakerCannotApprove(msg.sender);

        IParticipantRegistry.Institution memory member = _requireActiveInstitution(request.institution);
        _requireReserveCover(request.amount);

        request.status = RequestStatus.Completed;
        request.checker = msg.sender;
        request.decidedAt = uint64(block.timestamp);
        emit IssuanceApproved(id, request.institution, member.settlementAccount, request.amount, msg.sender);

        ITokenisedTaka(address(token)).mint(member.settlementAccount, request.amount);
    }

    /// @notice Rejects a request. Its funding reference stays consumed.
    function rejectIssuance(uint256 id, bytes32 reason) external onlyRole(CHECKER_ROLE) {
        IssuanceRequest storage request = _pendingIssuance(id);
        request.status = RequestStatus.Rejected;
        request.checker = msg.sender;
        request.decidedAt = uint64(block.timestamp);
        emit IssuanceRejected(id, reason, msg.sender);
    }

    // ------------------------------------------------------------------ redemption

    /// @notice Confirms that the taka was paid out and destroys the redeemed tBDT.
    function settleRedemption(uint256 id) external onlyRole(CHECKER_ROLE) {
        RedemptionRequest storage request = _pendingRedemption(id);
        request.status = RequestStatus.Completed;
        request.checker = msg.sender;
        request.decidedAt = uint64(block.timestamp);
        emit RedemptionSettled(id, request.amount, msg.sender);

        ITokenisedTaka(address(token)).burn(request.amount);
    }

    /// @notice Rejects a redemption and returns the tBDT to the institution.
    function rejectRedemption(uint256 id, bytes32 reason) external onlyRole(CHECKER_ROLE) {
        RedemptionRequest storage request = _pendingRedemption(id);
        request.status = RequestStatus.Rejected;
        request.checker = msg.sender;
        request.decidedAt = uint64(block.timestamp);
        emit RedemptionRejected(id, reason, msg.sender);

        _pay(request.account, request.amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice Instruction for `transferAndCall` that opens a redemption request.
    function encodeRedemption(bytes32 payoutRef) external pure returns (bytes memory) {
        return abi.encode(payoutRef);
    }

    function reserveStatementCount() external view returns (uint256) {
        return _statements.length;
    }

    function reserveStatement(uint256 index) external view returns (ReserveStatement memory) {
        return _statements[index];
    }

    /// @notice Most recent reserve statement. Reverts when none has been published.
    function currentStatement() public view returns (ReserveStatement memory) {
        uint256 count = _statements.length;
        if (count == 0) revert ReserveStatementMissing();
        return _statements[count - 1];
    }

    function issuanceCount() external view returns (uint256) {
        return _issuances.length;
    }

    function issuance(uint256 id) external view returns (IssuanceRequest memory) {
        if (id >= _issuances.length) revert UnknownRequest(id);
        return _issuances[id];
    }

    function redemptionCount() external view returns (uint256) {
        return _redemptions.length;
    }

    function redemption(uint256 id) external view returns (RedemptionRequest memory) {
        if (id >= _redemptions.length) revert UnknownRequest(id);
        return _redemptions[id];
    }

    // ------------------------------------------------------------------ internals

    /// @dev A settlement account sends tBDT here to redeem it. The funds stay in the controller, and in
    ///      the supply, until the checker confirms the payout.
    function _onFundsReceived(address from, uint256 value, bytes calldata data) internal override {
        if (value == 0) revert InvalidAmount();
        IParticipantRegistry.Account memory sender = registry.account(from);
        if (sender.tier != IParticipantRegistry.Tier.Institution) revert NotSettlementAccount(from);

        bytes32 payoutRef = abi.decode(data, (bytes32));
        uint256 id = _redemptions.length;
        _redemptions.push(
            RedemptionRequest({
                institution: sender.institution,
                account: from,
                amount: uint128(value),
                status: RequestStatus.Pending,
                requestedAt: uint64(block.timestamp),
                decidedAt: 0,
                checker: address(0),
                payoutRef: payoutRef
            })
        );
        emit RedemptionRequested(id, sender.institution, from, value, payoutRef);
    }

    function _setMaxStatementAge(uint64 maxStatementAge_) private {
        if (maxStatementAge_ == 0) revert InvalidAmount();
        maxStatementAge = maxStatementAge_;
        emit MaxStatementAgeChanged(maxStatementAge_);
    }

    function _pendingIssuance(uint256 id) private view returns (IssuanceRequest storage request) {
        if (id >= _issuances.length) revert UnknownRequest(id);
        request = _issuances[id];
        if (request.status != RequestStatus.Pending) revert RequestNotPending(id, request.status);
    }

    function _pendingRedemption(uint256 id) private view returns (RedemptionRequest storage request) {
        if (id >= _redemptions.length) revert UnknownRequest(id);
        request = _redemptions[id];
        if (request.status != RequestStatus.Pending) revert RequestNotPending(id, request.status);
    }

    function _requireActiveInstitution(
        bytes32 id
    ) private view returns (IParticipantRegistry.Institution memory member) {
        member = registry.institution(id);
        if (!member.active) revert InstitutionNotActive(id);
    }

    /// @dev Supply after the mint must stay within a reserve statement that is still current.
    function _requireReserveCover(uint256 amount) private view {
        ReserveStatement memory statement = currentStatement();
        if (block.timestamp - statement.asOf > maxStatementAge) {
            revert ReserveStatementStale(statement.asOf, maxStatementAge);
        }
        uint256 supplyAfter = token.totalSupply() + amount;
        if (supplyAfter > statement.balance) revert ReserveExceeded(supplyAfter, statement.balance);
    }
}
