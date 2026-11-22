-- A reconciliation run also checks that the most recent reserve statement covers the supply. A run whose
-- books agree with the chain but whose supply is larger than the statement is recorded as a shortfall.

ALTER TABLE reconciliation_runs DROP CONSTRAINT reconciliation_runs_status_check;
ALTER TABLE reconciliation_runs
    ADD CONSTRAINT reconciliation_runs_status_check CHECK (status IN ('Balanced', 'Mismatch', 'Shortfall'));
