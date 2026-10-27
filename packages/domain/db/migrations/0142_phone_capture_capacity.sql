-- changes: sourcing_prospect_phone_discoveries
-- Phone-only whole-original capacity. All inherited source/hash/shape guards remain.
CREATE OR REPLACE FUNCTION prospect_phone_content_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb; b jsonb; u jsonb; host text; n integer; page_characters integer; serialized text;
BEGIN
 IF c IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>110000
  OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR NOT c ?& ARRAY['website','sourceUrls','observations']
  OR jsonb_typeof(c->'website') IS DISTINCT FROM 'string' OR length(c->>'website') NOT BETWEEN 1 AND 2000
  OR (c->>'website') !~ '^https://[^/@?#:]+([/][^?#]*)?$'
  OR jsonb_typeof(c->'sourceUrls') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'sourceUrls') NOT BETWEEN 1 AND 18
  OR jsonb_typeof(c->'observations') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'observations')>4
  OR octet_length((c->'observations')::text)>100000 THEN RETURN false; END IF;
 host:=regexp_replace(lower(substring(c->>'website' FROM '^https://([^/]+)')),'^www\.','');
 FOR u IN SELECT value FROM jsonb_array_elements(c->'sourceUrls') LOOP
  IF jsonb_typeof(u) IS DISTINCT FROM 'string' OR length(u#>>'{}') NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(c->'sourceUrls'))<>jsonb_array_length(c->'sourceUrls') THEN RETURN false; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(c->'observations') LOOP
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>10
   OR NOT p ?& ARRAY['id','url','contentHash','relevantTextHash','retrievedAt','publishedAt','publishedAtBlockId','firstParty','truncated','blocks']
   OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR (p->>'id') !~ '^[a-f0-9-]{36}$'
   OR jsonb_typeof(p->'url') IS DISTINCT FROM 'string' OR length(p->>'url') NOT BETWEEN 1 AND 2000
   OR (p->>'url') !~ '^https://[^/@?#:]+([/][^?#]*)?$'
   OR regexp_replace(lower(substring(p->>'url' FROM '^https://([^/]+)')),'^www\.','') IS DISTINCT FROM host
   OR jsonb_typeof(p->'contentHash') IS DISTINCT FROM 'string' OR (p->>'contentHash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p->'relevantTextHash') IS DISTINCT FROM 'string' OR (p->>'relevantTextHash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p->'retrievedAt') IS DISTINCT FROM 'string' OR NOT isfinite((p->>'retrievedAt')::timestamptz)
   OR p->'publishedAt' IS DISTINCT FROM 'null'::jsonb OR p->'publishedAtBlockId' IS DISTINCT FROM 'null'::jsonb
   OR p->'firstParty' IS DISTINCT FROM 'true'::jsonb OR p->'truncated' IS DISTINCT FROM 'false'::jsonb
   OR jsonb_typeof(p->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'blocks') NOT BETWEEN 1 AND 256 THEN RETURN false; END IF;
  page_characters:=2*(jsonb_array_length(p->'blocks')-1);
  FOR b IN SELECT value FROM jsonb_array_elements(p->'blocks') LOOP
   IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>2 OR NOT b ?& ARRAY['id','text']
    OR jsonb_typeof(b->'id') IS DISTINCT FROM 'string' OR length(b->>'id') NOT BETWEEN 1 AND 80
    OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR length(b->>'text')<1 THEN RETURN false; END IF;
   SELECT COALESCE(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) INTO n FROM regexp_split_to_table(b->>'text','') ch;
   IF n>16000 THEN RETURN false; END IF;
   page_characters:=page_characters+n;
   IF page_characters>50000 THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'blocks'))<>jsonb_array_length(p->'blocks') THEN RETURN false; END IF;
  PERFORM (p->>'id')::uuid;
  SELECT '['||string_agg('{"id":'||to_jsonb(value->>'id')::text||',"text":'||to_jsonb(value->>'text')::text||'}',',' ORDER BY ord)||']'
   INTO serialized FROM jsonb_array_elements(p->'blocks') WITH ORDINALITY blocks(value,ord);
  IF encode(sha256(convert_to(serialized,'UTF8')),'hex') IS DISTINCT FROM p->>'relevantTextHash' THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(c->'observations'))<>jsonb_array_length(c->'observations')
 OR (SELECT count(DISTINCT value->>'url') FROM jsonb_array_elements(c->'observations'))<>jsonb_array_length(c->'observations') THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
