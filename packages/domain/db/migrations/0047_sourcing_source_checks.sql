ALTER TABLE sourcing_candidates ADD COLUMN source_check jsonb;
ALTER TABLE sourcing_candidates ADD CONSTRAINT sourcing_candidates_source_check_shape
  CHECK (source_check IS NULL OR (jsonb_typeof(source_check)='object' AND octet_length(source_check::text)<=16000));
