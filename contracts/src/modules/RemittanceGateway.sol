// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IParticipantRegistry} from "../interfaces/IParticipantRegistry.sol";
import {SettlementModule} from "./SettlementModule.sol";

/// @title RemittanceGateway
/// @notice Inward remittance corridors. A licensed exchange house abroad pays a beneficiary in
///         Bangladesh in tBDT, at a rate bound to the published reference rate, and the beneficiary
///         receives the government cash incentive on top of the principal.
/// @dev Small-value remittances settle straight through. Amounts above the screening threshold wait
///      for a compliance decision and can be reclaimed by the originator once the review window ends.
contract RemittanceGateway is AccessControl, SettlementModule {
    /// @notice Opens corridors, authorises originators and sets the gateway policy.
    bytes32 public constant CORRIDOR_ROLE = keccak256("CORRIDOR_ROLE");
    /// @notice Publishes the reference exchange rate of each corridor.
    bytes32 public constant RATE_PUBLISHER_ROLE = keccak256("RATE_PUBLISHER_ROLE");
    /// @notice Releases or rejects remittances held for review.
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    uint8 public constant INSTRUCTION_REMITTANCE = 1;
    uint8 public constant INSTRUCTION_FUND_INCENTIVE = 2;

    /// @notice Rates are quoted in taka per unit of source currency, scaled by one million.
    uint256 public constant RATE_SCALE = 1e6;
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_INCENTIVE_BPS = 1_000;

    enum Status {
        None,
        UnderReview,
        Paid,
        Rejected,
        Reclaimed
    }

    struct Corridor {
        bytes3 currency;
        bool active;
        uint64 rateUpdatedAt;
        uint128 maxAmount;
        uint128 referenceRate;
    }

    struct Policy {
        uint16 incentiveBps;
        uint16 rateBandBps;
        uint32 rateValidity;
        uint32 reviewWindow;
        uint128 screeningThreshold;
    }

    struct Remittance {
        bytes32 corridor;
        bytes32 originator;
        address sender;
        address beneficiary;
        uint128 amount;
        uint128 incentive;
        uint128 sourceAmount;
        uint128 rate;
        uint64 createdAt;
        uint64 settledAt;
        bytes4 purpose;
        Status status;
        bool incentivePaid;
    }

    Policy public policy;
    /// @notice tBDT set aside by the Treasury to pay the incentive.
    uint256 public incentivePool;

    mapping(bytes32 corridorId => Corridor) private _corridors;
    mapping(bytes32 corridorId => mapping(bytes32 institution => bool)) private _originators;
    mapping(bytes32 institution => mapping(bytes32 senderRef => bool)) private _senderRefUsed;
    bytes32[] private _corridorIds;
    Remittance[] private _remittances;

    event PolicyChanged(
        uint16 incentiveBps,
        uint16 rateBandBps,
        uint32 rateValidity,
        uint32 reviewWindow,
        uint128 screeningThreshold
    );
    event CorridorConfigured(bytes32 indexed corridor, bytes3 currency, uint128 maxAmount, bool active);
    event OriginatorAuthorised(bytes32 indexed corridor, bytes32 indexed institution, bool authorised);
    event ReferenceRatePublished(bytes32 indexed corridor, uint128 rate, address indexed publisher);
    event IncentivePoolFunded(address indexed from, uint256 amount, uint256 pool);
    event RemittanceReceived(
        uint256 indexed id,
        bytes32 indexed corridor,
        bytes32 indexed originator,
        address beneficiary,
        uint256 amount,
        uint256 sourceAmount,
        uint256 rate,
        bytes4 purpose,
        bytes32 senderRef,
        bool underReview
    );
    event RemittancePaid(
        uint256 indexed id,
        address indexed beneficiary,
        uint256 amount,
        uint256 incentive,
        bool incentivePaid
    );
    event IncentiveSettled(uint256 indexed id, address indexed beneficiary, uint256 incentive);
    event RemittanceRejected(uint256 indexed id, bytes32 reason, address indexed officer);
    event RemittanceReclaimed(uint256 indexed id);

    error InvalidAmount();
    error InvalidPolicy();
    error InvalidCorridor();
    error UnknownCorridor(bytes32 corridor);
    error CorridorInactive(bytes32 corridor);
    error NotExchangeHouse(bytes32 institution);
    error OriginatorNotAuthorised(address sender);
    error DuplicateReference(bytes32 senderRef);
    error AmountAboveCorridorCap(uint256 amount, uint256 cap);
    error ReferenceRateMissing(bytes32 corridor);
    error ReferenceRateExpired(bytes32 corridor, uint64 updatedAt);
    error RateOutsideBand(uint256 quotedRate, uint256 referenceRate);
    error AmountMismatch(uint256 amount, uint256 expected);
    error BeneficiaryNotEligible(address beneficiary);
    error UnknownRemittance(uint256 id);
    error InvalidStatus(uint256 id, Status status);
    error ReviewWindowOpen(uint256 id, uint256 closesAt);
    error NotOriginator(address caller);
    error IncentiveNotDue(uint256 id);
    error IncentivePoolInsufficient(uint256 required, uint256 pool);
    error NotInstitutionAccount(address account);

    constructor(
        address governance,
        IERC20 token_,
        IParticipantRegistry registry_,
        Policy memory policy_
    ) SettlementModule(token_, registry_) {
        if (governance == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
        _setPolicy(policy_);
    }

    // ------------------------------------------------------------------ administration

    function setPolicy(Policy calldata policy_) external onlyRole(CORRIDOR_ROLE) {
        _setPolicy(policy_);
    }

    /// @notice Opens a corridor or updates its cap and status.
    /// @param corridorId Corridor code, for instance `bytes32("AE-BD")`.
    /// @param currency ISO 4217 code of the source currency, for instance `bytes3("AED")`.
    /// @param maxAmount Largest remittance in poisha.
    function configureCorridor(
        bytes32 corridorId,
        bytes3 currency,
        uint128 maxAmount,
        bool active
    ) external onlyRole(CORRIDOR_ROLE) {
        if (corridorId == bytes32(0) || currency == bytes3(0) || maxAmount == 0) revert InvalidCorridor();

        Corridor storage corridor_ = _corridors[corridorId];
        if (corridor_.currency == bytes3(0)) _corridorIds.push(corridorId);
        corridor_.currency = currency;
        corridor_.maxAmount = maxAmount;
        corridor_.active = active;
        emit CorridorConfigured(corridorId, currency, maxAmount, active);
    }

    /// @notice Authorises an exchange house to originate remittances on a corridor, or withdraws it.
    function setOriginator(bytes32 corridorId, bytes32 institution, bool authorised) external onlyRole(CORRIDOR_ROLE) {
        _requireCorridor(corridorId);
        if (registry.institution(institution).kind != IParticipantRegistry.InstitutionKind.ExchangeHouse) {
            revert NotExchangeHouse(institution);
        }
        _originators[corridorId][institution] = authorised;
        emit OriginatorAuthorised(corridorId, institution, authorised);
    }

    /// @notice Publishes the reference rate of a corridor: taka per unit of source currency, scaled 1e6.
    function publishRate(bytes32 corridorId, uint128 rate) external onlyRole(RATE_PUBLISHER_ROLE) {
        if (rate == 0) revert InvalidAmount();
        Corridor storage corridor_ = _requireCorridor(corridorId);
        corridor_.referenceRate = rate;
        corridor_.rateUpdatedAt = uint64(block.timestamp);
        emit ReferenceRatePublished(corridorId, rate, msg.sender);
    }

    // ------------------------------------------------------------------ compliance

    /// @notice Releases a remittance held for review to its beneficiary.
    function release(uint256 id) external onlyRole(COMPLIANCE_ROLE) {
        _payOut(id, _underReview(id));
    }

    /// @notice Rejects a remittance held for review and returns the principal to the originator.
    function reject(uint256 id, bytes32 reason) external onlyRole(COMPLIANCE_ROLE) {
        Remittance storage remittance_ = _underReview(id);
        remittance_.status = Status.Rejected;
        remittance_.settledAt = uint64(block.timestamp);
        emit RemittanceRejected(id, reason, msg.sender);

        _pay(remittance_.sender, remittance_.amount);
    }

    /// @notice Lets the originator take back a remittance that was not decided within the review window.
    function reclaim(uint256 id) external {
        Remittance storage remittance_ = _underReview(id);
        if (remittance_.sender != msg.sender) revert NotOriginator(msg.sender);
        uint256 closesAt = uint256(remittance_.createdAt) + policy.reviewWindow;
        if (block.timestamp < closesAt) revert ReviewWindowOpen(id, closesAt);

        remittance_.status = Status.Reclaimed;
        remittance_.settledAt = uint64(block.timestamp);
        emit RemittanceReclaimed(id);

        _pay(remittance_.sender, remittance_.amount);
    }

    /// @notice Pays an incentive that was deferred because the pool was short when the remittance paid.
    function settleIncentive(uint256 id) external {
        Remittance storage remittance_ = _requireRemittance(id);
        bool due = remittance_.status == Status.Paid && !remittance_.incentivePaid && remittance_.incentive != 0;
        if (!due) revert IncentiveNotDue(id);
        if (remittance_.incentive > incentivePool) {
            revert IncentivePoolInsufficient(remittance_.incentive, incentivePool);
        }

        incentivePool -= remittance_.incentive;
        remittance_.incentivePaid = true;
        emit IncentiveSettled(id, remittance_.beneficiary, remittance_.incentive);

        _pay(remittance_.beneficiary, remittance_.incentive);
    }

    // ------------------------------------------------------------------ views

    /// @notice Instruction that originates a remittance.
    /// @param sourceAmount Amount collected abroad, in minor units of the corridor currency.
    /// @param quotedRate Rate given to the customer, scaled 1e6. The tBDT sent must equal
    ///        `sourceAmount * quotedRate / 1e6`.
    /// @param purpose ISO 20022 purpose code, for instance `bytes4("FAMI")`.
    /// @param senderRef Originator's own reference. Each reference is accepted once.
    function encodeRemittance(
        bytes32 corridorId,
        address beneficiary,
        uint128 sourceAmount,
        uint128 quotedRate,
        bytes4 purpose,
        bytes32 senderRef
    ) external pure returns (bytes memory) {
        return
            abi.encode(
                INSTRUCTION_REMITTANCE,
                abi.encode(corridorId, beneficiary, sourceAmount, quotedRate, purpose, senderRef)
            );
    }

    /// @notice Instruction that adds the transferred amount to the incentive pool.
    function encodeIncentiveFunding() external pure returns (bytes memory) {
        return abi.encode(INSTRUCTION_FUND_INCENTIVE, bytes(""));
    }

    function corridor(bytes32 corridorId) external view returns (Corridor memory) {
        return _corridors[corridorId];
    }

    function corridorIds() external view returns (bytes32[] memory) {
        return _corridorIds;
    }

    function isOriginator(bytes32 corridorId, bytes32 institution) external view returns (bool) {
        return _originators[corridorId][institution];
    }

    function remittance(uint256 id) external view returns (Remittance memory) {
        return _requireRemittance(id);
    }

    function remittanceCount() external view returns (uint256) {
        return _remittances.length;
    }

    /// @notice Payout at the reference rate for `sourceAmount` minor units of the corridor currency.
    function quote(bytes32 corridorId, uint128 sourceAmount) external view returns (uint256 amount, uint256 incentive) {
        amount = (uint256(sourceAmount) * _corridors[corridorId].referenceRate) / RATE_SCALE;
        incentive = (amount * policy.incentiveBps) / BPS;
    }

    // ------------------------------------------------------------------ settlement

    function _onFundsReceived(address from, uint256 value, bytes calldata data) internal override {
        if (value == 0) revert InvalidAmount();
        (uint8 kind, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (kind == INSTRUCTION_REMITTANCE) {
            _receiveRemittance(from, value, payload);
        } else if (kind == INSTRUCTION_FUND_INCENTIVE) {
            _fundIncentivePool(from, value);
        } else {
            revert UnknownInstruction(kind);
        }
    }

    function _receiveRemittance(address from, uint256 value, bytes memory payload) private {
        (
            bytes32 corridorId,
            address beneficiary,
            uint128 sourceAmount,
            uint128 quotedRate,
            bytes4 purpose,
            bytes32 senderRef
        ) = abi.decode(payload, (bytes32, address, uint128, uint128, bytes4, bytes32));

        bytes32 originator = _requireOriginator(corridorId, from);
        if (_senderRefUsed[originator][senderRef]) revert DuplicateReference(senderRef);
        _senderRefUsed[originator][senderRef] = true;

        _checkQuote(corridorId, value, sourceAmount, quotedRate);
        if (!registry.isEligible(beneficiary)) revert BeneficiaryNotEligible(beneficiary);

        bool underReview = value > policy.screeningThreshold;
        uint256 id = _remittances.length;
        _remittances.push(
            Remittance({
                corridor: corridorId,
                originator: originator,
                sender: from,
                beneficiary: beneficiary,
                amount: uint128(value),
                incentive: uint128((value * policy.incentiveBps) / BPS),
                sourceAmount: sourceAmount,
                rate: quotedRate,
                createdAt: uint64(block.timestamp),
                settledAt: 0,
                purpose: purpose,
                status: Status.UnderReview,
                incentivePaid: false
            })
        );
        emit RemittanceReceived(
            id,
            corridorId,
            originator,
            beneficiary,
            value,
            sourceAmount,
            quotedRate,
            purpose,
            senderRef,
            underReview
        );

        if (!underReview) _payOut(id, _remittances[id]);
    }

    /// @dev Pays the principal, and the incentive when the pool covers it. A short pool never blocks
    ///      the principal: the incentive stays due and is paid later through `settleIncentive`.
    function _payOut(uint256 id, Remittance storage remittance_) private {
        uint256 incentive = remittance_.incentive;
        bool funded = incentive <= incentivePool;
        if (funded) incentivePool -= incentive;

        remittance_.status = Status.Paid;
        remittance_.settledAt = uint64(block.timestamp);
        remittance_.incentivePaid = funded;
        emit RemittancePaid(id, remittance_.beneficiary, remittance_.amount, incentive, funded);

        _pay(remittance_.beneficiary, remittance_.amount + (funded ? incentive : 0));
    }

    function _fundIncentivePool(address from, uint256 value) private {
        if (registry.account(from).tier != IParticipantRegistry.Tier.Institution) {
            revert NotInstitutionAccount(from);
        }
        incentivePool += value;
        emit IncentivePoolFunded(from, value, incentivePool);
    }

    // ------------------------------------------------------------------ internals

    function _setPolicy(Policy memory policy_) private {
        bool valid =
            policy_.incentiveBps <= MAX_INCENTIVE_BPS &&
                policy_.rateBandBps <= BPS &&
                policy_.rateValidity != 0 &&
                policy_.reviewWindow != 0;
        if (!valid) revert InvalidPolicy();

        policy = policy_;
        emit PolicyChanged(
            policy_.incentiveBps,
            policy_.rateBandBps,
            policy_.rateValidity,
            policy_.reviewWindow,
            policy_.screeningThreshold
        );
    }

    /// @dev The sender must be the settlement account of an exchange house authorised on the corridor.
    function _requireOriginator(bytes32 corridorId, address from) private view returns (bytes32 originator) {
        Corridor storage corridor_ = _requireCorridor(corridorId);
        if (!corridor_.active) revert CorridorInactive(corridorId);

        IParticipantRegistry.Account memory sender = registry.account(from);
        bool authorised =
            sender.tier == IParticipantRegistry.Tier.Institution && _originators[corridorId][sender.institution];
        if (!authorised) revert OriginatorNotAuthorised(from);
        return sender.institution;
    }

    /// @dev The quoted rate must sit inside the band around a current reference rate, and the tBDT
    ///      received must be exactly the source amount converted at the quoted rate.
    function _checkQuote(bytes32 corridorId, uint256 value, uint256 sourceAmount, uint256 quotedRate) private view {
        Corridor storage corridor_ = _corridors[corridorId];
        if (value > corridor_.maxAmount) revert AmountAboveCorridorCap(value, corridor_.maxAmount);

        uint256 referenceRate = corridor_.referenceRate;
        if (referenceRate == 0) revert ReferenceRateMissing(corridorId);
        if (block.timestamp - corridor_.rateUpdatedAt > policy.rateValidity) {
            revert ReferenceRateExpired(corridorId, corridor_.rateUpdatedAt);
        }

        uint256 band = (referenceRate * policy.rateBandBps) / BPS;
        if (quotedRate + band < referenceRate || quotedRate > referenceRate + band) {
            revert RateOutsideBand(quotedRate, referenceRate);
        }

        uint256 expected = (sourceAmount * quotedRate) / RATE_SCALE;
        if (value != expected) revert AmountMismatch(value, expected);
    }

    function _requireCorridor(bytes32 corridorId) private view returns (Corridor storage corridor_) {
        corridor_ = _corridors[corridorId];
        if (corridor_.currency == bytes3(0)) revert UnknownCorridor(corridorId);
    }

    function _requireRemittance(uint256 id) private view returns (Remittance storage remittance_) {
        if (id >= _remittances.length) revert UnknownRemittance(id);
        remittance_ = _remittances[id];
    }

    function _underReview(uint256 id) private view returns (Remittance storage remittance_) {
        remittance_ = _requireRemittance(id);
        if (remittance_.status != Status.UnderReview) revert InvalidStatus(id, remittance_.status);
    }
}
