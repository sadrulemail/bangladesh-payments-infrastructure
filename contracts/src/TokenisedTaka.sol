// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1363} from "@openzeppelin/contracts/token/ERC20/extensions/ERC1363.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IParticipantRegistry} from "./interfaces/IParticipantRegistry.sol";
import {ITokenisedTaka} from "./interfaces/ITokenisedTaka.sol";

/// @title TokenisedTaka (tBDT)
/// @notice Settlement token of the network: one unit is one poisha, redeemable at par against the
///         taka held in the reserve trust account.
/// @dev Every movement is screened against the participant registry. Value only moves between active
///      accounts of active institutions, within the limits of the sender's and the receiver's tier.
///      ERC-1363 lets a holder fund a settlement module and pass its instruction in one transaction.
contract TokenisedTaka is ERC20, ERC1363, AccessControl, Pausable, ITokenisedTaka {
    /// @notice Issues and redeems supply. Held by the reserve controller only.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    /// @notice Halts and resumes every movement of value.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Executes transfers ordered by a court or by the supervisory authority.
    bytes32 public constant ENFORCEMENT_ROLE = keccak256("ENFORCEMENT_ROLE");

    /// @dev Business days roll over at midnight in Dhaka (UTC+6).
    uint256 private constant DHAKA_UTC_OFFSET = 6 hours;

    IParticipantRegistry public immutable registry;

    struct DailyUsage {
        uint64 day;
        uint128 spent;
    }

    mapping(address holder => DailyUsage) private _usage;

    event ForcedTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes32 indexed orderRef,
        address officer
    );

    error InvalidAddress();
    error TransactionLimitExceeded(address holder, uint256 amount, uint256 limit);
    error DailyLimitExceeded(address holder, uint256 spent, uint256 limit);
    error BalanceCapExceeded(address holder, uint256 balance, uint256 cap);

    constructor(address governance, IParticipantRegistry registry_) ERC20("Tokenised Taka", "tBDT") {
        if (governance == address(0) || address(registry_) == address(0)) revert InvalidAddress();
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
    }

    // ------------------------------------------------------------------ supply

    /// @inheritdoc ITokenisedTaka
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @inheritdoc ITokenisedTaka
    function burn(uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ controls

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Moves funds out of an account under a legal order, including a frozen account.
    /// @dev Limits and the pause switch do not apply. The receiver must still be eligible.
    /// @param orderRef Reference of the court or supervisory order.
    function forceTransfer(
        address from,
        address to,
        uint256 amount,
        bytes32 orderRef
    ) external onlyRole(ENFORCEMENT_ROLE) {
        registry.policyOf(to);
        super._update(from, to, amount);
        emit ForcedTransfer(from, to, amount, orderRef, msg.sender);
    }

    // ------------------------------------------------------------------ views

    /// @notice One unit is one poisha.
    function decimals() public pure override returns (uint8) {
        return 2;
    }

    /// @notice Index of the current business day in Dhaka.
    function businessDay() public view returns (uint64) {
        return uint64((block.timestamp + DHAKA_UTC_OFFSET) / 1 days);
    }

    /// @notice Amount `holder` has sent during the current business day.
    function spentToday(address holder) external view returns (uint256) {
        DailyUsage storage usage = _usage[holder];
        return usage.day == businessDay() ? usage.spent : 0;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1363, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Screens every mint, transfer and burn before balances change.
    function _update(address from, address to, uint256 value) internal override {
        _requireNotPaused();

        bool isMint = from == address(0);
        bool isBurn = to == address(0);

        if (!isMint && !isBurn) {
            _consumeSenderLimits(from, value, registry.policyOf(from));
        }
        if (!isBurn) {
            _checkReceiverCap(from, to, value, registry.policyOf(to));
        }
        super._update(from, to, value);
    }

    function _consumeSenderLimits(address from, uint256 value, IParticipantRegistry.TierLimits memory limits) private {
        if (limits.perTransaction != 0 && value > limits.perTransaction) {
            revert TransactionLimitExceeded(from, value, limits.perTransaction);
        }
        if (limits.dailyOutflow == 0) return;

        uint64 today = businessDay();
        DailyUsage storage usage = _usage[from];
        uint256 spent = (usage.day == today ? usage.spent : 0) + value;
        if (spent > limits.dailyOutflow) revert DailyLimitExceeded(from, spent, limits.dailyOutflow);

        usage.day = today;
        // `spent` is bounded by `dailyOutflow`, a uint128.
        usage.spent = uint128(spent);
    }

    function _checkReceiverCap(
        address from,
        address to,
        uint256 value,
        IParticipantRegistry.TierLimits memory limits
    ) private view {
        if (limits.maxBalance == 0 || from == to) return;
        uint256 balance = balanceOf(to) + value;
        if (balance > limits.maxBalance) revert BalanceCapExceeded(to, balance, limits.maxBalance);
    }
}
