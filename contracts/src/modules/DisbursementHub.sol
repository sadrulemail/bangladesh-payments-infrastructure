// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";

import {IParticipantRegistry} from "../interfaces/IParticipantRegistry.sol";
import {SettlementModule} from "./SettlementModule.sol";

/// @title DisbursementHub
/// @notice Bulk payouts such as factory wages and social safety-net allowances.
/// @dev A payer funds a batch and commits to its payout list with a Merkle root, so the list itself
///      stays off-chain. The payer's bank approves the batch, then payouts are executed in chunks,
///      each one proven against the root. A payout that cannot be delivered is recorded as failed
///      without blocking the rest, and the undelivered amount returns to the payer when the batch closes.
contract DisbursementHub is SettlementModule {
    using BitMaps for BitMaps.BitMap;

    /// @notice Time after approval when a batch can be closed even if some payouts were never executed.
    uint64 public constant EXECUTION_WINDOW = 30 days;

    enum Status {
        None,
        AwaitingApproval,
        Approved,
        Rejected,
        Closed
    }

    struct Batch {
        address payer;
        Status status;
        bytes4 purpose;
        uint32 count;
        uint32 processed;
        uint64 createdAt;
        uint64 approvedAt;
        bytes32 payerInstitution;
        bytes32 merkleRoot;
        bytes32 batchRef;
        uint128 total;
        uint128 paid;
        uint128 failed;
    }

    struct Payout {
        uint32 index;
        address account;
        uint128 amount;
        bytes32[] proof;
    }

    Batch[] private _batches;
    mapping(uint256 batchId => BitMaps.BitMap) private _processed;
    mapping(address payer => mapping(bytes32 batchRef => bool)) private _batchRefUsed;

    event BatchCreated(
        uint256 indexed batchId,
        address indexed payer,
        bytes32 indexed payerInstitution,
        bytes32 batchRef,
        bytes32 merkleRoot,
        uint256 total,
        uint32 count,
        bytes4 purpose
    );
    event BatchApproved(uint256 indexed batchId, address indexed approver);
    event BatchRejected(uint256 indexed batchId, bytes32 reason, address indexed approver);
    event PayoutSettled(uint256 indexed batchId, uint32 indexed index, address indexed account, uint256 amount);
    event PayoutFailed(uint256 indexed batchId, uint32 indexed index, address indexed account, uint256 amount);
    event BatchClosed(uint256 indexed batchId, uint256 paid, uint256 returned);

    error InvalidBatch();
    error PayerNotEligible(address payer);
    error DuplicateBatchRef(bytes32 batchRef);
    error UnknownBatch(uint256 batchId);
    error InvalidStatus(uint256 batchId, Status status);
    error NotAuthorised(address caller);
    error InvalidPayout(uint256 batchId, uint32 index);
    error PayoutAlreadyProcessed(uint256 batchId, uint32 index);
    error BatchOverdrawn(uint256 batchId);
    error BatchStillOpen(uint256 batchId, uint256 closableAt);

    constructor(IERC20 token_, IParticipantRegistry registry_) SettlementModule(token_, registry_) {}

    // ------------------------------------------------------------------ approval

    /// @notice Approves a batch. Reserved to the administrator of the payer's institution.
    function approve(uint256 batchId) external {
        Batch storage batch_ = _awaitingApproval(batchId, msg.sender);
        batch_.status = Status.Approved;
        batch_.approvedAt = uint64(block.timestamp);
        emit BatchApproved(batchId, msg.sender);
    }

    /// @notice Rejects a batch and returns its funds to the payer.
    function reject(uint256 batchId, bytes32 reason) external {
        Batch storage batch_ = _awaitingApproval(batchId, msg.sender);
        batch_.status = Status.Rejected;
        emit BatchRejected(batchId, reason, msg.sender);

        _pay(batch_.payer, batch_.total);
    }

    // ------------------------------------------------------------------ execution

    /// @notice Executes a chunk of payouts of an approved batch.
    /// @dev Each payout is proven against the batch root and can be processed only once.
    function execute(uint256 batchId, Payout[] calldata payouts) external {
        Batch storage batch_ = _requireBatch(batchId);
        if (batch_.status != Status.Approved) revert InvalidStatus(batchId, batch_.status);
        _requireOperator(batch_, msg.sender);

        BitMaps.BitMap storage processed = _processed[batchId];
        uint256 paid = batch_.paid;
        uint256 failed = batch_.failed;

        for (uint256 i = 0; i < payouts.length; ++i) {
            Payout calldata payout = payouts[i];
            if (payout.index >= batch_.count) revert InvalidPayout(batchId, payout.index);
            if (processed.get(payout.index)) revert PayoutAlreadyProcessed(batchId, payout.index);
            if (!MerkleProof.verifyCalldata(payout.proof, batch_.merkleRoot, _leaf(payout))) {
                revert InvalidPayout(batchId, payout.index);
            }
            if (paid + failed + payout.amount > batch_.total) revert BatchOverdrawn(batchId);
            processed.set(payout.index);

            if (_deliver(payout.account, payout.amount)) {
                paid += payout.amount;
                emit PayoutSettled(batchId, payout.index, payout.account, payout.amount);
            } else {
                failed += payout.amount;
                emit PayoutFailed(batchId, payout.index, payout.account, payout.amount);
            }
        }

        batch_.paid = uint128(paid);
        batch_.failed = uint128(failed);
        batch_.processed += uint32(payouts.length);
    }

    /// @notice Closes a batch and returns whatever was not delivered to the payer.
    /// @dev Allowed once every payout was processed, or after the execution window.
    function close(uint256 batchId) external {
        Batch storage batch_ = _requireBatch(batchId);
        if (batch_.status != Status.Approved) revert InvalidStatus(batchId, batch_.status);
        _requireOperator(batch_, msg.sender);

        uint256 closableAt = uint256(batch_.approvedAt) + EXECUTION_WINDOW;
        if (batch_.processed < batch_.count && block.timestamp < closableAt) {
            revert BatchStillOpen(batchId, closableAt);
        }

        uint256 returned = batch_.total - batch_.paid;
        batch_.status = Status.Closed;
        emit BatchClosed(batchId, batch_.paid, returned);

        _pay(batch_.payer, returned);
    }

    // ------------------------------------------------------------------ views

    /// @notice Instruction that creates a batch funded with the transferred amount.
    /// @param batchRef Payer's own reference. Each reference is accepted once per payer.
    /// @param merkleRoot Root of the payout list, with leaves `(index, account, amount)`.
    /// @param count Number of payouts in the list.
    /// @param purpose ISO 20022 purpose code, for instance `bytes4("SALA")`.
    function encodeBatch(
        bytes32 batchRef,
        bytes32 merkleRoot,
        uint32 count,
        bytes4 purpose
    ) external pure returns (bytes memory) {
        return abi.encode(batchRef, merkleRoot, count, purpose);
    }

    function batch(uint256 batchId) external view returns (Batch memory) {
        return _requireBatch(batchId);
    }

    function batchCount() external view returns (uint256) {
        return _batches.length;
    }

    function isProcessed(uint256 batchId, uint32 index) external view returns (bool) {
        return _processed[batchId].get(index);
    }

    // ------------------------------------------------------------------ internals

    function _onFundsReceived(address from, uint256 value, bytes calldata data) internal override {
        (bytes32 batchRef, bytes32 merkleRoot, uint32 count, bytes4 purpose) = abi.decode(
            data,
            (bytes32, bytes32, uint32, bytes4)
        );
        if (value == 0 || count == 0 || merkleRoot == bytes32(0)) revert InvalidBatch();

        IParticipantRegistry.Account memory payer = registry.account(from);
        bool eligible =
            payer.tier == IParticipantRegistry.Tier.Corporate || payer.tier == IParticipantRegistry.Tier.Institution;
        if (!eligible) revert PayerNotEligible(from);
        if (_batchRefUsed[from][batchRef]) revert DuplicateBatchRef(batchRef);
        _batchRefUsed[from][batchRef] = true;

        uint256 batchId = _batches.length;
        _batches.push(
            Batch({
                payer: from,
                status: Status.AwaitingApproval,
                purpose: purpose,
                count: count,
                processed: 0,
                createdAt: uint64(block.timestamp),
                approvedAt: 0,
                payerInstitution: payer.institution,
                merkleRoot: merkleRoot,
                batchRef: batchRef,
                total: uint128(value),
                paid: 0,
                failed: 0
            })
        );
        emit BatchCreated(batchId, from, payer.institution, batchRef, merkleRoot, value, count, purpose);
    }

    /// @dev A payout fails, instead of reverting the chunk, when the beneficiary cannot receive:
    ///      frozen or closed account, suspended institution, or balance cap reached.
    function _deliver(address account, uint256 amount) private returns (bool) {
        try token.transfer(account, amount) returns (bool delivered) {
            return delivered;
        } catch {
            return false;
        }
    }

    function _leaf(Payout calldata payout) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(payout.index, payout.account, payout.amount))));
    }

    function _requireBatch(uint256 batchId) private view returns (Batch storage batch_) {
        if (batchId >= _batches.length) revert UnknownBatch(batchId);
        batch_ = _batches[batchId];
    }

    function _awaitingApproval(uint256 batchId, address caller) private view returns (Batch storage batch_) {
        batch_ = _requireBatch(batchId);
        if (batch_.status != Status.AwaitingApproval) revert InvalidStatus(batchId, batch_.status);
        if (_institutionOfAdmin(caller) != batch_.payerInstitution) revert NotAuthorised(caller);
    }

    /// @dev The payer and the administrator of its institution may execute and close a batch.
    function _requireOperator(Batch storage batch_, address caller) private view {
        if (caller == batch_.payer) return;
        if (registry.institutionOfAdmin(caller) != batch_.payerInstitution) revert NotAuthorised(caller);
    }
}
