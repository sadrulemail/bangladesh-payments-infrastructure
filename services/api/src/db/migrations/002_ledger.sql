-- Double-entry ledger. Each token movement on chain posts one balanced journal entry, so the books
-- can be reconciled against chain balances and against the reserve statement at any block.
--
-- Chart of accounts
--   1000            Reserve trust account            asset      taka held at the settlement bank
--   2000:<address>  Wallet                           liability  tBDT owed to the holder of the wallet

CREATE TABLE ledger_accounts (
    id        serial PRIMARY KEY,
    code      text   NOT NULL UNIQUE,
    name      text   NOT NULL,
    category  text   NOT NULL CHECK (category IN ('asset', 'liability')),
    wallet    text   UNIQUE
);

INSERT INTO ledger_accounts (code, name, category) VALUES ('1000', 'Reserve trust account', 'asset');

CREATE TABLE journal_entries (
    id            bigserial   PRIMARY KEY,
    entry_type    text        NOT NULL CHECK (entry_type IN ('issuance', 'redemption', 'transfer')),
    block_number  bigint      NOT NULL,
    posted_at     timestamptz NOT NULL,
    tx_hash       text        NOT NULL,
    log_index     integer     NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX journal_entries_time_idx ON journal_entries (posted_at DESC);

CREATE TABLE journal_lines (
    id          bigserial PRIMARY KEY,
    entry_id    bigint    NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
    account_id  integer   NOT NULL REFERENCES ledger_accounts (id),
    debit       bigint    NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit      bigint    NOT NULL DEFAULT 0 CHECK (credit >= 0),
    CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX journal_lines_entry_idx   ON journal_lines (entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (account_id);

-- An entry must balance by the time its transaction commits.
CREATE FUNCTION assert_journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    entry       bigint := COALESCE(NEW.entry_id, OLD.entry_id);
    difference  numeric;
BEGIN
    SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0)
      INTO difference
      FROM journal_lines
     WHERE entry_id = entry;

    IF difference <> 0 THEN
        RAISE EXCEPTION 'Journal entry % is out of balance by % poisha', entry, difference;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced
    AFTER INSERT OR UPDATE OR DELETE ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

-- Balance of every ledger account. Assets carry a debit balance, liabilities a credit balance.
CREATE VIEW ledger_balances AS
SELECT a.id,
       a.code,
       a.name,
       a.category,
       a.wallet,
       COALESCE(SUM(l.debit), 0)::bigint  AS debit,
       COALESCE(SUM(l.credit), 0)::bigint AS credit,
       (CASE a.category
            WHEN 'asset' THEN COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)
            ELSE COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0)
        END)::bigint                       AS balance
  FROM ledger_accounts a
  LEFT JOIN journal_lines l ON l.account_id = a.id
 GROUP BY a.id;

CREATE TABLE reconciliation_runs (
    id                  bigserial   PRIMARY KEY,
    run_at              timestamptz NOT NULL DEFAULT now(),
    block_number        bigint      NOT NULL,
    total_supply        bigint      NOT NULL,
    ledger_liabilities  bigint      NOT NULL,
    ledger_reserve      bigint      NOT NULL,
    reported_reserve    bigint,
    wallets_checked     integer     NOT NULL,
    mismatches          jsonb       NOT NULL DEFAULT '[]',
    status              text        NOT NULL CHECK (status IN ('Balanced', 'Mismatch')),
    triggered_by        text        NOT NULL
);
