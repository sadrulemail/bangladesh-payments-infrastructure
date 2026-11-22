-- The cursor keeps the hash of its block. When the API starts, the indexer compares it with the block the
-- node has at that height, so read models built from one chain are never extended with the events of
-- another, as would happen after a local node restarts or a reorganisation replaces the block.

ALTER TABLE indexer_cursor ADD COLUMN block_hash text;
