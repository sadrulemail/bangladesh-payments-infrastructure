-- Read models projected from contract events. Every table here can be rebuilt from the chain.
-- Amounts are integers in poisha; addresses are lower-case hex.

CREATE TABLE indexer_cursor (
    id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    block_number  bigint      NOT NULL,
    block_time    timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chain_events (
    id            bigserial   PRIMARY KEY,
    block_number  bigint      NOT NULL,
    block_time    timestamptz NOT NULL,
    tx_hash       text        NOT NULL,
    log_index     integer     NOT NULL,
    contract      text        NOT NULL,
    event_name    text        NOT NULL,
    args          jsonb       NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX chain_events_block_idx ON chain_events (block_number);
CREATE INDEX chain_events_name_idx  ON chain_events (contract, event_name);

-- ---------------------------------------------------------------- directory

CREATE TABLE institutions (
    id                  text        PRIMARY KEY,
    kind                text        NOT NULL,
    name                text        NOT NULL,
    country             char(2)     NOT NULL,
    admin_address       text        NOT NULL,
    settlement_account  text        NOT NULL,
    active              boolean     NOT NULL DEFAULT true,
    registered_at       timestamptz NOT NULL
);

CREATE TABLE accounts (
    address         text        PRIMARY KEY,
    institution_id  text        NOT NULL REFERENCES institutions (id),
    tier            text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('Active', 'Frozen', 'Closed')),
    status_reason   text,
    identity_ref    text        NOT NULL,
    opened_at       timestamptz NOT NULL
);
CREATE INDEX accounts_institution_idx ON accounts (institution_id);

CREATE TABLE tier_limits (
    tier             text   PRIMARY KEY,
    per_transaction  bigint NOT NULL,
    daily_outflow    bigint NOT NULL,
    max_balance      bigint NOT NULL
);

CREATE TABLE merchants (
    id             text        PRIMARY KEY,
    acquirer_id    text        NOT NULL REFERENCES institutions (id),
    account        text        NOT NULL REFERENCES accounts (address),
    category_code  integer     NOT NULL,
    active         boolean     NOT NULL DEFAULT true,
    registered_at  timestamptz NOT NULL
);

CREATE TABLE fee_schedule (
    id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    default_fee_bps     integer  NOT NULL,
    acquirer_share_bps  integer  NOT NULL
);

CREATE TABLE category_fees (
    category_code  integer PRIMARY KEY,
    fee_bps        integer NOT NULL
);

-- ---------------------------------------------------------------- token

CREATE TABLE token_transfers (
    id            bigserial   PRIMARY KEY,
    block_number  bigint      NOT NULL,
    block_time    timestamptz NOT NULL,
    tx_hash       text        NOT NULL,
    log_index     integer     NOT NULL,
    from_address  text        NOT NULL,
    to_address    text        NOT NULL,
    amount        bigint      NOT NULL CHECK (amount >= 0),
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX token_transfers_from_idx ON token_transfers (from_address, block_time DESC);
CREATE INDEX token_transfers_to_idx   ON token_transfers (to_address, block_time DESC);
CREATE INDEX token_transfers_time_idx ON token_transfers (block_time);

-- ---------------------------------------------------------------- reserve

CREATE TABLE reserve_statements (
    idx            integer     PRIMARY KEY,
    as_of          timestamptz NOT NULL,
    balance        bigint      NOT NULL,
    document_hash  text        NOT NULL,
    publisher      text        NOT NULL,
    published_at   timestamptz NOT NULL,
    tx_hash        text        NOT NULL
);

CREATE TABLE issuance_requests (
    id              bigint      PRIMARY KEY,
    institution_id  text        NOT NULL REFERENCES institutions (id),
    amount          bigint      NOT NULL,
    funding_ref     text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('Pending', 'Completed', 'Rejected')),
    maker           text        NOT NULL,
    checker         text,
    reason          text,
    requested_at    timestamptz NOT NULL,
    decided_at      timestamptz,
    tx_hash         text        NOT NULL
);

CREATE TABLE redemption_requests (
    id              bigint      PRIMARY KEY,
    institution_id  text        NOT NULL REFERENCES institutions (id),
    account         text        NOT NULL,
    amount          bigint      NOT NULL,
    payout_ref      text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('Pending', 'Completed', 'Rejected')),
    checker         text,
    reason          text,
    requested_at    timestamptz NOT NULL,
    decided_at      timestamptz,
    tx_hash         text        NOT NULL
);

-- ---------------------------------------------------------------- payments

CREATE TABLE payments (
    id            bigint      PRIMARY KEY,
    kind          text        NOT NULL CHECK (kind IN ('merchant', 'person')),
    payer         text        NOT NULL,
    payee         text        NOT NULL,
    merchant_id   text        REFERENCES merchants (id),
    amount        bigint      NOT NULL,
    acquirer_fee  bigint      NOT NULL DEFAULT 0,
    network_fee   bigint      NOT NULL DEFAULT 0,
    refunded      bigint      NOT NULL DEFAULT 0,
    reference     text,
    purpose       text,
    settled_at    timestamptz NOT NULL,
    tx_hash       text        NOT NULL
);
CREATE INDEX payments_time_idx     ON payments (settled_at DESC);
CREATE INDEX payments_merchant_idx ON payments (merchant_id, settled_at DESC);
CREATE INDEX payments_payer_idx    ON payments (payer);

CREATE TABLE refunds (
    id           bigserial   PRIMARY KEY,
    payment_id   bigint      NOT NULL REFERENCES payments (id),
    amount       bigint      NOT NULL,
    refunded_at  timestamptz NOT NULL,
    tx_hash      text        NOT NULL
);

-- ---------------------------------------------------------------- remittances

CREATE TABLE corridors (
    id               text        PRIMARY KEY,
    currency         char(3)     NOT NULL,
    active           boolean     NOT NULL,
    max_amount       bigint      NOT NULL,
    reference_rate   bigint,
    rate_updated_at  timestamptz
);

CREATE TABLE corridor_originators (
    corridor_id     text NOT NULL REFERENCES corridors (id),
    institution_id  text NOT NULL REFERENCES institutions (id),
    PRIMARY KEY (corridor_id, institution_id)
);

CREATE TABLE reference_rates (
    id            bigserial   PRIMARY KEY,
    corridor_id   text        NOT NULL REFERENCES corridors (id),
    rate          bigint      NOT NULL,
    publisher     text        NOT NULL,
    published_at  timestamptz NOT NULL,
    tx_hash       text        NOT NULL
);
CREATE INDEX reference_rates_corridor_idx ON reference_rates (corridor_id, published_at DESC);

CREATE TABLE gateway_policy (
    id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    incentive_bps        integer  NOT NULL,
    rate_band_bps        integer  NOT NULL,
    rate_validity        integer  NOT NULL,
    review_window        integer  NOT NULL,
    screening_threshold  bigint   NOT NULL,
    incentive_pool       bigint   NOT NULL DEFAULT 0
);

CREATE TABLE remittances (
    id                  bigint      PRIMARY KEY,
    corridor_id         text        NOT NULL REFERENCES corridors (id),
    originator_id       text        NOT NULL REFERENCES institutions (id),
    beneficiary         text        NOT NULL,
    amount              bigint      NOT NULL,
    incentive           bigint      NOT NULL DEFAULT 0,
    incentive_paid      boolean     NOT NULL DEFAULT false,
    source_amount       bigint      NOT NULL,
    rate                bigint      NOT NULL,
    purpose             text        NOT NULL,
    sender_ref          text        NOT NULL,
    status              text        NOT NULL CHECK (status IN ('UnderReview', 'Paid', 'Rejected', 'Reclaimed')),
    reason              text,
    created_at          timestamptz NOT NULL,
    settled_at          timestamptz,
    tx_hash             text        NOT NULL,
    settlement_tx_hash  text
);
CREATE INDEX remittances_time_idx        ON remittances (created_at DESC);
CREATE INDEX remittances_status_idx      ON remittances (status);
CREATE INDEX remittances_beneficiary_idx ON remittances (beneficiary);

-- ---------------------------------------------------------------- disbursements

CREATE TABLE disbursement_batches (
    id                    bigint      PRIMARY KEY,
    payer                 text        NOT NULL,
    payer_institution_id  text        NOT NULL REFERENCES institutions (id),
    batch_ref             text        NOT NULL,
    merkle_root           text        NOT NULL,
    total                 bigint      NOT NULL,
    paid                  bigint      NOT NULL DEFAULT 0,
    failed                bigint      NOT NULL DEFAULT 0,
    returned              bigint,
    payout_count          integer     NOT NULL,
    processed             integer     NOT NULL DEFAULT 0,
    purpose               text        NOT NULL,
    status                text        NOT NULL CHECK (status IN ('AwaitingApproval', 'Approved', 'Rejected', 'Closed')),
    reason                text,
    created_at            timestamptz NOT NULL,
    approved_at           timestamptz,
    closed_at             timestamptz,
    tx_hash               text        NOT NULL
);

CREATE TABLE disbursement_payouts (
    batch_id      bigint  NOT NULL REFERENCES disbursement_batches (id),
    idx           integer NOT NULL,
    account       text    NOT NULL,
    amount        bigint  NOT NULL,
    status        text    NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Settled', 'Failed')),
    processed_at  timestamptz,
    tx_hash       text,
    PRIMARY KEY (batch_id, idx)
);
