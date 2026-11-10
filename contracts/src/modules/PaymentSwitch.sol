// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IParticipantRegistry} from "../interfaces/IParticipantRegistry.sol";
import {SettlementModule} from "./SettlementModule.sol";

/// @title PaymentSwitch
/// @notice Interoperable retail payments: merchant payments, person-to-person transfers and refunds
///         between customers of any member institution, settled in tBDT in a single transaction.
/// @dev The payer funds the switch with `transferAndCall`; the switch pays the beneficiary and splits
///      the merchant fee between the acquirer and the network in the same transaction.
contract PaymentSwitch is AccessControl, SettlementModule {
    /// @notice Sets the fee schedule and the fee collector.
    bytes32 public constant FEE_ROLE = keccak256("FEE_ROLE");

    uint8 public constant INSTRUCTION_MERCHANT_PAYMENT = 1;
    uint8 public constant INSTRUCTION_PERSON_TRANSFER = 2;
    uint8 public constant INSTRUCTION_REFUND = 3;

    uint16 public constant BPS = 10_000;
    /// @notice Ceiling of any merchant fee: 3%.
    uint16 public constant MAX_FEE_BPS = 300;

    enum PaymentKind {
        Merchant,
        Person
    }

    struct Merchant {
        bytes32 acquirer;
        address account;
        uint16 categoryCode;
        bool active;
    }

    struct Payment {
        PaymentKind kind;
        uint64 settledAt;
        address payer;
        address payee;
        uint128 amount;
        uint128 fee;
        uint128 refunded;
        bytes32 merchantId;
    }

    struct CategoryFee {
        bool set;
        uint16 feeBps;
    }

    /// @notice Merchant fee applied when the category has no fee of its own.
    uint16 public defaultFeeBps;
    /// @notice Share of the merchant fee paid to the acquiring institution.
    uint16 public acquirerShareBps;
    /// @notice Account that collects the network's share of fees.
    address public feeCollector;

    mapping(bytes32 merchantId => Merchant) private _merchants;
    mapping(uint16 categoryCode => CategoryFee) private _categoryFees;
    mapping(bytes32 merchantId => mapping(bytes32 invoiceRef => bool)) private _invoicePaid;
    Payment[] private _payments;

    event MerchantRegistered(
        bytes32 indexed merchantId,
        bytes32 indexed acquirer,
        address account,
        uint16 categoryCode
    );
    event MerchantStatusChanged(bytes32 indexed merchantId, bool active);
    event FeeScheduleChanged(uint16 defaultFeeBps, uint16 acquirerShareBps);
    event CategoryFeeChanged(uint16 indexed categoryCode, bool set, uint16 feeBps);
    event FeeCollectorChanged(address indexed feeCollector);
    event MerchantPaymentSettled(
        uint256 indexed paymentId,
        bytes32 indexed merchantId,
        address indexed payer,
        address payee,
        uint256 amount,
        uint256 acquirerFee,
        uint256 networkFee,
        bytes32 invoiceRef
    );
    event PersonTransferSettled(
        uint256 indexed paymentId,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        bytes32 endToEndRef,
        bytes4 purpose
    );
    event PaymentRefunded(uint256 indexed paymentId, address indexed payer, uint256 amount, uint256 refundedTotal);

    error InvalidAmount();
    error InvalidMerchant();
    error FeeTooHigh(uint16 feeBps);
    error InvalidShare(uint16 shareBps);
    error MerchantExists(bytes32 merchantId);
    error UnknownMerchant(bytes32 merchantId);
    error MerchantInactive(bytes32 merchantId);
    error MerchantAccountNotEligible(address account);
    error NotAcquirer(address caller);
    error InvoiceAlreadyPaid(bytes32 merchantId, bytes32 invoiceRef);
    error UnknownPayment(uint256 paymentId);
    error NotRefundable(uint256 paymentId);
    error RefundExceedsPayment(uint256 paymentId, uint256 refundedTotal, uint256 amount);

    constructor(
        address governance,
        IERC20 token_,
        IParticipantRegistry registry_,
        address feeCollector_,
        uint16 defaultFeeBps_,
        uint16 acquirerShareBps_
    ) SettlementModule(token_, registry_) {
        if (governance == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
        _setFeeCollector(feeCollector_);
        _setFeeSchedule(defaultFeeBps_, acquirerShareBps_);
    }

    // ------------------------------------------------------------------ merchants

    /// @notice Onboards a merchant acquired by the caller's institution.
    /// @param account Merchant-tier account, sponsored by the same institution, that receives payments.
    /// @param categoryCode ISO 18245 merchant category code.
    function registerMerchant(bytes32 merchantId, address account, uint16 categoryCode) external {
        bytes32 acquirer = _institutionOfAdmin(msg.sender);
        if (merchantId == bytes32(0)) revert InvalidMerchant();
        if (_merchants[merchantId].account != address(0)) revert MerchantExists(merchantId);

        IParticipantRegistry.Account memory record = registry.account(account);
        bool eligible =
            record.institution == acquirer &&
                record.tier == IParticipantRegistry.Tier.Merchant &&
                record.status == IParticipantRegistry.AccountStatus.Active;
        if (!eligible) revert MerchantAccountNotEligible(account);

        _merchants[merchantId] = Merchant({
            acquirer: acquirer,
            account: account,
            categoryCode: categoryCode,
            active: true
        });
        emit MerchantRegistered(merchantId, acquirer, account, categoryCode);
    }

    /// @notice Suspends or reinstates a merchant. Only its acquirer may do so.
    function setMerchantActive(bytes32 merchantId, bool active) external {
        Merchant storage record = _requireMerchant(merchantId);
        if (_institutionOfAdmin(msg.sender) != record.acquirer) revert NotAcquirer(msg.sender);
        record.active = active;
        emit MerchantStatusChanged(merchantId, active);
    }

    // ------------------------------------------------------------------ fee schedule

    function setFeeSchedule(uint16 defaultFeeBps_, uint16 acquirerShareBps_) external onlyRole(FEE_ROLE) {
        _setFeeSchedule(defaultFeeBps_, acquirerShareBps_);
    }

    /// @notice Sets or clears the fee of one merchant category.
    function setCategoryFee(uint16 categoryCode, bool set, uint16 feeBps) external onlyRole(FEE_ROLE) {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        _categoryFees[categoryCode] = CategoryFee({set: set, feeBps: set ? feeBps : 0});
        emit CategoryFeeChanged(categoryCode, set, set ? feeBps : 0);
    }

    function setFeeCollector(address feeCollector_) external onlyRole(FEE_ROLE) {
        _setFeeCollector(feeCollector_);
    }

    // ------------------------------------------------------------------ views

    /// @notice Instruction that pays `merchantId`. A non-zero `invoiceRef` can be paid only once.
    function encodeMerchantPayment(bytes32 merchantId, bytes32 invoiceRef) external pure returns (bytes memory) {
        return abi.encode(INSTRUCTION_MERCHANT_PAYMENT, abi.encode(merchantId, invoiceRef));
    }

    /// @notice Instruction that transfers to `payee` with an end-to-end reference and a purpose code.
    function encodePersonTransfer(
        address payee,
        bytes32 endToEndRef,
        bytes4 purpose
    ) external pure returns (bytes memory) {
        return abi.encode(INSTRUCTION_PERSON_TRANSFER, abi.encode(payee, endToEndRef, purpose));
    }

    /// @notice Instruction a merchant uses to refund all or part of `paymentId`.
    function encodeRefund(uint256 paymentId) external pure returns (bytes memory) {
        return abi.encode(INSTRUCTION_REFUND, abi.encode(paymentId));
    }

    function merchant(bytes32 merchantId) external view returns (Merchant memory) {
        return _merchants[merchantId];
    }

    function payment(uint256 paymentId) external view returns (Payment memory) {
        if (paymentId >= _payments.length) revert UnknownPayment(paymentId);
        return _payments[paymentId];
    }

    function paymentCount() external view returns (uint256) {
        return _payments.length;
    }

    /// @notice Fee in basis points charged on payments to merchants of `categoryCode`.
    function feeBpsFor(uint16 categoryCode) public view returns (uint16) {
        CategoryFee storage category = _categoryFees[categoryCode];
        return category.set ? category.feeBps : defaultFeeBps;
    }

    /// @notice Fee split for a merchant payment of `amount` poisha.
    function quoteFee(
        bytes32 merchantId,
        uint256 amount
    ) public view returns (uint256 acquirerFee, uint256 networkFee) {
        uint256 fee = (amount * feeBpsFor(_merchants[merchantId].categoryCode)) / BPS;
        acquirerFee = (fee * acquirerShareBps) / BPS;
        networkFee = fee - acquirerFee;
    }

    function isInvoicePaid(bytes32 merchantId, bytes32 invoiceRef) external view returns (bool) {
        return _invoicePaid[merchantId][invoiceRef];
    }

    // ------------------------------------------------------------------ settlement

    function _onFundsReceived(address from, uint256 value, bytes calldata data) internal override {
        if (value == 0) revert InvalidAmount();
        (uint8 kind, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (kind == INSTRUCTION_MERCHANT_PAYMENT) {
            (bytes32 merchantId, bytes32 invoiceRef) = abi.decode(payload, (bytes32, bytes32));
            _settleMerchantPayment(from, value, merchantId, invoiceRef);
        } else if (kind == INSTRUCTION_PERSON_TRANSFER) {
            (address payee, bytes32 endToEndRef, bytes4 purpose) = abi.decode(payload, (address, bytes32, bytes4));
            _settlePersonTransfer(from, value, payee, endToEndRef, purpose);
        } else if (kind == INSTRUCTION_REFUND) {
            _settleRefund(from, value, abi.decode(payload, (uint256)));
        } else {
            revert UnknownInstruction(kind);
        }
    }

    function _settleMerchantPayment(address payer, uint256 amount, bytes32 merchantId, bytes32 invoiceRef) private {
        Merchant storage payee = _requireMerchant(merchantId);
        if (!payee.active) revert MerchantInactive(merchantId);
        if (invoiceRef != bytes32(0)) {
            if (_invoicePaid[merchantId][invoiceRef]) revert InvoiceAlreadyPaid(merchantId, invoiceRef);
            _invoicePaid[merchantId][invoiceRef] = true;
        }

        (uint256 acquirerFee, uint256 networkFee) = quoteFee(merchantId, amount);
        uint256 fee = acquirerFee + networkFee;
        uint256 paymentId = _record(PaymentKind.Merchant, payer, payee.account, amount, fee, merchantId);
        emit MerchantPaymentSettled(
            paymentId,
            merchantId,
            payer,
            payee.account,
            amount,
            acquirerFee,
            networkFee,
            invoiceRef
        );

        _pay(payee.account, amount - fee);
        _pay(registry.institution(payee.acquirer).settlementAccount, acquirerFee);
        _pay(feeCollector, networkFee);
    }

    function _settlePersonTransfer(
        address payer,
        uint256 amount,
        address payee,
        bytes32 endToEndRef,
        bytes4 purpose
    ) private {
        uint256 paymentId = _record(PaymentKind.Person, payer, payee, amount, 0, bytes32(0));
        emit PersonTransferSettled(paymentId, payer, payee, amount, endToEndRef, purpose);
        _pay(payee, amount);
    }

    /// @dev The merchant returns funds to the original payer. Fees already settled are not reversed.
    function _settleRefund(address from, uint256 amount, uint256 paymentId) private {
        if (paymentId >= _payments.length) revert UnknownPayment(paymentId);
        Payment storage original = _payments[paymentId];
        if (original.kind != PaymentKind.Merchant || original.payee != from) revert NotRefundable(paymentId);

        uint256 refundedTotal = uint256(original.refunded) + amount;
        if (refundedTotal > original.amount) {
            revert RefundExceedsPayment(paymentId, refundedTotal, original.amount);
        }
        original.refunded = uint128(refundedTotal);
        emit PaymentRefunded(paymentId, original.payer, amount, refundedTotal);

        _pay(original.payer, amount);
    }

    function _record(
        PaymentKind kind,
        address payer,
        address payee,
        uint256 amount,
        uint256 fee,
        bytes32 merchantId
    ) private returns (uint256 paymentId) {
        paymentId = _payments.length;
        _payments.push(
            Payment({
                kind: kind,
                settledAt: uint64(block.timestamp),
                payer: payer,
                payee: payee,
                amount: uint128(amount),
                fee: uint128(fee),
                refunded: 0,
                merchantId: merchantId
            })
        );
    }

    // ------------------------------------------------------------------ internals

    function _setFeeSchedule(uint16 defaultFeeBps_, uint16 acquirerShareBps_) private {
        if (defaultFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh(defaultFeeBps_);
        if (acquirerShareBps_ > BPS) revert InvalidShare(acquirerShareBps_);
        defaultFeeBps = defaultFeeBps_;
        acquirerShareBps = acquirerShareBps_;
        emit FeeScheduleChanged(defaultFeeBps_, acquirerShareBps_);
    }

    function _setFeeCollector(address feeCollector_) private {
        if (feeCollector_ == address(0)) revert InvalidAddress();
        feeCollector = feeCollector_;
        emit FeeCollectorChanged(feeCollector_);
    }

    function _requireMerchant(bytes32 merchantId) private view returns (Merchant storage record) {
        record = _merchants[merchantId];
        if (record.account == address(0)) revert UnknownMerchant(merchantId);
    }
}
