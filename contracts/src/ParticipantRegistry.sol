// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IParticipantRegistry} from "./interfaces/IParticipantRegistry.sol";

/// @title ParticipantRegistry
/// @notice Directory of licensed institutions and the customer accounts they sponsor.
/// @dev No personal data is stored. An account carries only its tier, its status and `identityRef`,
///      a salted hash of the KYC record that stays in the sponsoring institution's own systems.
contract ParticipantRegistry is AccessControl, IParticipantRegistry {
    /// @notice Onboards institutions and system accounts.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    /// @notice Sets the limits attached to each tier.
    bytes32 public constant POLICY_ROLE = keccak256("POLICY_ROLE");
    /// @notice Supervisory authority: may suspend institutions and freeze any account.
    bytes32 public constant SUPERVISOR_ROLE = keccak256("SUPERVISOR_ROLE");

    mapping(bytes32 id => Institution) private _institutions;
    mapping(address admin => bytes32 id) private _institutionOfAdmin;
    mapping(address holder => Account) private _accounts;
    mapping(Tier tier => TierLimits) private _tierLimits;
    bytes32[] private _institutionIds;

    constructor(address governance) {
        if (governance == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
    }

    // ------------------------------------------------------------------ institutions

    /// @notice Admits an institution and opens its settlement account.
    /// @param id Short code of the institution, for instance `bytes32("TEESTA")`.
    /// @param admin Key that sponsors accounts on behalf of the institution.
    /// @param settlementAccount Wallet that holds the institution's own funds.
    function registerInstitution(
        bytes32 id,
        InstitutionKind kind,
        string calldata name,
        bytes2 country,
        address admin,
        address settlementAccount
    ) external onlyRole(REGISTRAR_ROLE) {
        if (id == bytes32(0) || kind == InstitutionKind.None) revert InvalidInstitution();
        if (admin == address(0) || settlementAccount == address(0)) revert InvalidAddress();
        if (_institutions[id].kind != InstitutionKind.None) revert InstitutionExists(id);
        if (_institutionOfAdmin[admin] != bytes32(0)) revert AdminAlreadyAssigned(admin);

        _institutions[id] = Institution({
            kind: kind,
            active: true,
            country: country,
            admin: admin,
            settlementAccount: settlementAccount,
            name: name
        });
        _institutionOfAdmin[admin] = id;
        _institutionIds.push(id);
        emit InstitutionRegistered(id, kind, name, country, admin, settlementAccount);

        _open(settlementAccount, id, Tier.Institution, bytes32(0));
    }

    /// @notice Suspends or reinstates an institution. Every account it sponsors follows its status.
    function setInstitutionActive(bytes32 id, bool active) external {
        if (!hasRole(REGISTRAR_ROLE, msg.sender) && !hasRole(SUPERVISOR_ROLE, msg.sender)) {
            revert NotAuthorised(msg.sender);
        }
        Institution storage record = _requireInstitution(id);
        record.active = active;
        emit InstitutionStatusChanged(id, active, msg.sender);
    }

    /// @notice Rotates the administrator key of an institution.
    function setInstitutionAdmin(bytes32 id, address newAdmin) external onlyRole(REGISTRAR_ROLE) {
        if (newAdmin == address(0)) revert InvalidAddress();
        if (_institutionOfAdmin[newAdmin] != bytes32(0)) revert AdminAlreadyAssigned(newAdmin);
        Institution storage record = _requireInstitution(id);

        address previous = record.admin;
        delete _institutionOfAdmin[previous];
        _institutionOfAdmin[newAdmin] = id;
        record.admin = newAdmin;
        emit InstitutionAdminChanged(id, previous, newAdmin);
    }

    /// @notice Registers a settlement module or another operational wallet of the network.
    function registerSystemAccount(bytes32 institutionId, address holder) external onlyRole(REGISTRAR_ROLE) {
        _requireInstitution(institutionId);
        _open(holder, institutionId, Tier.System, bytes32(0));
    }

    // ------------------------------------------------------------------ accounts

    /// @notice Opens a customer account sponsored by the caller's institution.
    /// @param identityRef Salted hash of the customer's KYC record.
    function openAccount(address holder, Tier tier, bytes32 identityRef) external {
        bytes32 id = _requireAdmin(msg.sender);
        if (!_isCustomerTier(tier)) revert InvalidTier(tier);
        _open(holder, id, tier, identityRef);
    }

    /// @notice Moves a customer to another tier, for instance after full KYC is completed.
    function changeTier(address holder, Tier newTier) external {
        Account storage record = _requireOwnAccount(holder, msg.sender);
        if (!_isCustomerTier(newTier) || !_isCustomerTier(record.tier)) revert InvalidTier(newTier);

        Tier previous = record.tier;
        record.tier = newTier;
        emit AccountTierChanged(holder, previous, newTier);
    }

    /// @notice Freezes an account. A frozen account can neither send nor receive.
    /// @param reason Reference of the case or order that motivates the freeze.
    function freezeAccount(address holder, bytes32 reason) external {
        Account storage record = _requireControlled(holder, msg.sender);
        if (record.status != AccountStatus.Active) revert InvalidStatusChange(holder, record.status);
        _setStatus(holder, record, AccountStatus.Frozen, reason);
    }

    /// @notice Lifts a freeze.
    function unfreezeAccount(address holder) external {
        Account storage record = _requireControlled(holder, msg.sender);
        if (record.status != AccountStatus.Frozen) revert InvalidStatusChange(holder, record.status);
        _setStatus(holder, record, AccountStatus.Active, bytes32(0));
    }

    /// @notice Closes an account for good. The institution sweeps the balance beforehand.
    function closeAccount(address holder) external {
        Account storage record = _requireOwnAccount(holder, msg.sender);
        if (record.status == AccountStatus.Closed) revert InvalidStatusChange(holder, record.status);
        _setStatus(holder, record, AccountStatus.Closed, bytes32(0));
    }

    // ------------------------------------------------------------------ policy

    /// @notice Sets the limits of a tier. A zero value switches that limit off.
    function setTierLimits(Tier tier, TierLimits calldata limits) external onlyRole(POLICY_ROLE) {
        if (tier == Tier.None) revert InvalidTier(tier);
        _tierLimits[tier] = limits;
        emit TierLimitsUpdated(tier, limits.perTransaction, limits.dailyOutflow, limits.maxBalance);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IParticipantRegistry
    function policyOf(address holder) external view returns (TierLimits memory) {
        Account storage record = _accounts[holder];
        if (record.status != AccountStatus.Active) revert AccountNotActive(holder, record.status);
        if (!_institutions[record.institution].active) revert InstitutionInactive(record.institution);
        return _tierLimits[record.tier];
    }

    /// @inheritdoc IParticipantRegistry
    function isEligible(address holder) external view returns (bool) {
        Account storage record = _accounts[holder];
        return record.status == AccountStatus.Active && _institutions[record.institution].active;
    }

    function institution(bytes32 id) external view returns (Institution memory) {
        return _institutions[id];
    }

    function account(address holder) external view returns (Account memory) {
        return _accounts[holder];
    }

    /// @inheritdoc IParticipantRegistry
    function institutionOfAdmin(address admin) external view returns (bytes32) {
        return _institutionOfAdmin[admin];
    }

    function tierLimits(Tier tier) external view returns (TierLimits memory) {
        return _tierLimits[tier];
    }

    function institutionIds() external view returns (bytes32[] memory) {
        return _institutionIds;
    }

    // ------------------------------------------------------------------ internals

    function _open(address holder, bytes32 institutionId, Tier tier, bytes32 identityRef) private {
        if (holder == address(0)) revert InvalidAddress();
        if (_accounts[holder].status != AccountStatus.None) revert AccountExists(holder);

        _accounts[holder] = Account({
            institution: institutionId,
            tier: tier,
            status: AccountStatus.Active,
            openedAt: uint64(block.timestamp),
            identityRef: identityRef
        });
        emit AccountOpened(holder, institutionId, tier, identityRef);
    }

    function _setStatus(address holder, Account storage record, AccountStatus status, bytes32 reason) private {
        record.status = status;
        emit AccountStatusChanged(holder, status, reason, msg.sender);
    }

    function _requireInstitution(bytes32 id) private view returns (Institution storage record) {
        record = _institutions[id];
        if (record.kind == InstitutionKind.None) revert UnknownInstitution(id);
    }

    /// @dev Returns the active institution administered by `caller`.
    function _requireAdmin(address caller) private view returns (bytes32 id) {
        id = _institutionOfAdmin[caller];
        if (id == bytes32(0)) revert NotInstitutionAdmin(caller);
        if (!_institutions[id].active) revert InstitutionInactive(id);
    }

    function _requireAccount(address holder) private view returns (Account storage record) {
        record = _accounts[holder];
        if (record.status == AccountStatus.None) revert UnknownAccount(holder);
    }

    /// @dev The account must be sponsored by the caller's institution.
    function _requireOwnAccount(address holder, address caller) private view returns (Account storage record) {
        record = _requireAccount(holder);
        if (_requireAdmin(caller) != record.institution) revert NotAuthorised(caller);
    }

    /// @dev The caller is the supervisor or the administrator of the sponsoring institution.
    function _requireControlled(address holder, address caller) private view returns (Account storage record) {
        if (hasRole(SUPERVISOR_ROLE, caller)) return _requireAccount(holder);
        return _requireOwnAccount(holder, caller);
    }

    function _isCustomerTier(Tier tier) private pure returns (bool) {
        return tier == Tier.Basic || tier == Tier.Full || tier == Tier.Merchant || tier == Tier.Corporate;
    }
}
