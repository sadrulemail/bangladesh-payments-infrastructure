-- Operational data owned by this service. It does not come from the chain and is not rebuilt from it.

-- Console operators. Each operator signs with the key at `key_index` of the custody keystore.
CREATE TABLE operators (
    username        text        PRIMARY KEY,
    display_name    text        NOT NULL,
    role            text        NOT NULL,
    institution_id  text,
    address         text        NOT NULL,
    key_index       integer     NOT NULL,
    password_hash   text        NOT NULL,
    active          boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Wallets whose keys the custody service holds, by derivation index. No key material is stored.
CREATE TABLE custody_keys (
    address         text    PRIMARY KEY,
    key_index       integer NOT NULL UNIQUE,
    institution_id  text    NOT NULL
);

-- Display details of an account, kept off chain by the sponsoring institution.
CREATE TABLE account_profiles (
    address   text PRIMARY KEY,
    label     text NOT NULL,
    district  text
);

CREATE TABLE merchant_profiles (
    id    text PRIMARY KEY,
    name  text NOT NULL,
    city  text NOT NULL
);

-- Payout lists of disbursement batches. Only the Merkle root of a list goes on chain.
CREATE TABLE disbursement_payout_lists (
    payer       text        NOT NULL,
    batch_ref   text        NOT NULL,
    entries     jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (payer, batch_ref)
);

-- Every command an operator submits, whether the network accepted it or not.
CREATE TABLE audit_log (
    id          bigserial   PRIMARY KEY,
    operator    text        NOT NULL,
    action      text        NOT NULL,
    signer      text,
    details     jsonb       NOT NULL DEFAULT '{}',
    outcome     text        NOT NULL CHECK (outcome IN ('Accepted', 'Rejected')),
    tx_hash     text,
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time_idx ON audit_log (created_at DESC);
