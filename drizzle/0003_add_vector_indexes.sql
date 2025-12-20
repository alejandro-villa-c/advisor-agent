-- Custom SQL migration file, put your code below! --
-- Speeds up cosine-similarity searches on pgvector
CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
ON document_chunks
USING hnsw (embedding vector_cosine_ops);