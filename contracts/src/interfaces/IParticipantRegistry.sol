// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IParticipantRegistry
/// @notice Directory of licensed institutions and the accounts they sponsor on the network.
/// @dev The registry is the single source of eligibility: the token asks it before every movement of value.
interface IParticipantRegistry {
    /// @notice Licence category of a member institution.
    enum InstitutionKind {
        None,
        NetworkOperator,
        SettlementBank,
        CommercialBank,
        MobileFinancialService,
        PaymentServiceProvider,
        ExchangeHouse,
        Treasury
    }

    /// @notice Know-your-customer tier of an account. The tier selects the limits that apply to it.
    enum Tier {
        None,
        Basic,
        Full,
        Merchant,
        Corporate,
        Institution,
        System
    }

    /// @notice Lifecycle state of an account.
    enum AccountStatus {
        None,
        Active,
        Frozen,
        Closed
    }

    struct Institution {
        InstitutionKind kind;
        bool active;
        bytes2 country;
        address admin;
        address settlementAccount;
        string name;
    }

    struct Account {
        bytes32 institution;
        Tier tier;
        AccountStatus status;
        uint64 openedAt;
        bytes32 identityRef;
    }

    /// @notice Limits in poisha. A zero value means the limit does not apply.
    struct TierLimits {
        uint128 perTransaction;
        uint128 dailyOutflow;
        uint128 maxBalance;
    }

    event InstitutionRegistered(
        bytes32 indexed id,
        InstitutionKind kind,
        string name,
        bytes2 country,
        address admin,
        address settlementAccount
    );
    event InstitutionStatusChanged(bytes32 indexed id, bool active, address indexed by);
    event InstitutionAdminChanged(bytes32 indexed id, address indexed previousAdmin, address indexed newAdmin);
    event AccountOpened(address indexed holder, bytes32 indexed institution, Tier tier, bytes32 identityRef);
    event AccountTierChanged(address indexed holder, Tier previousTier, Tier newTier);
    event AccountStatusChanged(address indexed holder, AccountStatus status, bytes32 reason, address indexed by);
    event TierLimitsUpdated(Tier indexed tier, uint128 perTransaction, uint128 dailyOutflow, uint128 maxBalance);

    error InvalidAddress();
    error InvalidInstitution();
    error InvalidTier(Tier tier);
    error InstitutionExists(bytes32 id);
    error UnknownInstitution(bytes32 id);
    error InstitutionInactive(bytes32 id);
    error AdminAlreadyAssigned(address admin);
    error NotInstitutionAdmin(address caller);
    error AccountExists(address holder);
    error UnknownAccount(address holder);
    error AccountNotActive(address holder, AccountStatus status);
    error InvalidStatusChange(address holder, AccountStatus status);
    error NotAuthorised(address caller);

    /// @notice Returns the limits that apply to `holder`.
    /// @dev Reverts unless the account is active and its sponsoring institution is active.
    function policyOf(address holder) external view returns (TierLimits memory);

    /// @notice True when `holder` may send and receive value.
    function isEligible(address holder) external view returns (bool);

    function institution(bytes32 id) external view returns (Institution memory);

    function account(address holder) external view returns (Account memory);

    /// @notice Institution administered by `admin`, or zero when the address administers none.
    function institutionOfAdmin(address admin) external view returns (bytes32);

    function tierLimits(Tier tier) external view returns (TierLimits memory);

    function institutionIds() external view returns (bytes32[] memory);
}
