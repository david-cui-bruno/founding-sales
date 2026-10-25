-- Durable owner-curated style only. No source, draft, provider or publishing linkage.
CREATE FUNCTION valid_social_voice_entries(entries jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entry jsonb; ids text[] := '{}'; serialized text := '['; guidance text; units integer;
BEGIN
 IF jsonb_typeof(entries)<>'array' OR jsonb_array_length(entries) NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(entry)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>3
   OR NOT entry ?& ARRAY['entryId','dimension','guidance']
   OR jsonb_typeof(entry->'entryId')<>'string' OR entry->>'entryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(entry->'dimension')<>'string' OR entry->>'dimension' NOT IN ('tone','formality','concision','structure','vocabulary','formatting','avoid')
   OR jsonb_typeof(entry->'guidance')<>'string' OR length(entry->>'guidance') NOT BETWEEN 1 AND 500
   OR length(btrim(entry->>'guidance', E' \t\n\r'))=0 OR octet_length(entry->>'guidance')>2000
   OR lower(entry->>'entryId')=ANY(ids) THEN RETURN false; END IF;
  guidance := entry->>'guidance';
  SELECT COALESCE(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) INTO units FROM regexp_split_to_table(guidance,'') ch;
  IF units>500 OR length(btrim(guidance,E' \t\n\r'||chr(11)||chr(12)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)))=0 THEN RETURN false; END IF;
  serialized := serialized || CASE WHEN cardinality(ids)>0 THEN ',' ELSE '' END || '{"entryId":' || (entry->'entryId')::text || ',"dimension":' || (entry->'dimension')::text || ',"guidance":' || (entry->'guidance')::text || '}';
  ids := array_append(ids,lower(entry->>'entryId'));
 END LOOP;
 RETURN octet_length(serialized||']')<=10000;
END $$;
CREATE TABLE social_voice_preferences (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 entries jsonb,
 removed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,owner_user_id),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE,
 CONSTRAINT social_voice_content CHECK((entries IS NULL AND removed_at IS NOT NULL) OR (entries IS NOT NULL AND removed_at IS NULL AND valid_social_voice_entries(entries)))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_voice_preferences TO app_runtime,migration;
CREATE FUNCTION erase_departed_social_voice_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM 'active' THEN
  UPDATE social_voice_preferences SET entries=NULL,removed_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
   WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id AND entries IS NOT NULL;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_voice_owner_departure AFTER UPDATE OF status ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION erase_departed_social_voice_owner();
