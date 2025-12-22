-- Custom SQL migration file, put your code below! --
-- 1. Trigram extension (required for ILIKE optimization)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. User filtering indexes
CREATE INDEX IF NOT EXISTS document_chunks_user_id_idx 
ON document_chunks (user_id);

CREATE INDEX IF NOT EXISTS documents_user_id_idx 
ON documents (user_id);

-- 3. Full-text search indexes
CREATE INDEX IF NOT EXISTS document_chunks_text_fts_idx 
ON document_chunks 
USING gin (to_tsvector('simple', text));

-- 4. Trigram indexes (makes ILIKE '%pattern%' fast)
CREATE INDEX IF NOT EXISTS document_chunks_text_trgm_idx 
ON document_chunks 
USING gin (text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS documents_title_trgm_idx 
ON documents 
USING gin (title gin_trgm_ops);