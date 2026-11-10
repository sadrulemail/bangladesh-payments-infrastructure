// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ITokenisedTaka
/// @notice Supply operations of the settlement token, used by the reserve controller.
interface ITokenisedTaka is IERC20 {
    /// @notice Creates `amount` poisha for `to`. Restricted to the reserve controller.
    function mint(address to, uint256 amount) external;

    /// @notice Destroys `amount` poisha held by the caller. Restricted to the reserve controller.
    function burn(uint256 amount) external;
}
