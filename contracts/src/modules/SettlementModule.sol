// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1363Receiver} from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IParticipantRegistry} from "../interfaces/IParticipantRegistry.sol";

/// @title SettlementModule
/// @notice Base of every contract that receives tBDT together with a payment instruction.
/// @dev A holder calls `transferAndCall(module, amount, instruction)` on the token. The token moves the
///      funds and then calls `onTransferReceived`, so a module never needs an allowance and can only
///      act on funds that the holder has just sent to it.
abstract contract SettlementModule is IERC1363Receiver {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IParticipantRegistry public immutable registry;

    error InvalidAddress();
    error UnauthorisedToken(address caller);
    error UnknownInstruction(uint8 kind);
    error NotInstitutionAdmin(address caller);

    constructor(IERC20 token_, IParticipantRegistry registry_) {
        if (address(token_) == address(0) || address(registry_) == address(0)) revert InvalidAddress();
        token = token_;
        registry = registry_;
    }

    /// @inheritdoc IERC1363Receiver
    function onTransferReceived(address, address from, uint256 value, bytes calldata data) external returns (bytes4) {
        if (msg.sender != address(token)) revert UnauthorisedToken(msg.sender);
        _onFundsReceived(from, value, data);
        return IERC1363Receiver.onTransferReceived.selector;
    }

    /// @dev Handles `value` poisha received from `from` with the instruction encoded in `data`.
    function _onFundsReceived(address from, uint256 value, bytes calldata data) internal virtual;

    function _pay(address to, uint256 amount) internal {
        if (amount != 0) token.safeTransfer(to, amount);
    }

    /// @dev Returns the institution administered by `caller`; reverts when there is none.
    function _institutionOfAdmin(address caller) internal view returns (bytes32 id) {
        id = registry.institutionOfAdmin(caller);
        if (id == bytes32(0)) revert NotInstitutionAdmin(caller);
    }
}
