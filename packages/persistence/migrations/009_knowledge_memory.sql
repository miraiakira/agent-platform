SELECT pg_advisory_xact_lock(714013);
-- Extension belongs to public, not disposable tenant/test schemas. Migration identity only.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE knowledge_bases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),description text NOT NULL DEFAULT '',created_by text NOT NULL REFERENCES "user"(id),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE knowledge_documents (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,knowledge_base_id uuid NOT NULL,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),source_type text NOT NULL CHECK(source_type IN ('text','markdown','html','pdf')),mime_type text NOT NULL,storage_key uuid NOT NULL UNIQUE,checksum text NOT NULL CHECK(length(checksum)=64),status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed','deleted')),current_version_id uuid,created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,knowledge_base_id,id),FOREIGN KEY(tenant_id,knowledge_base_id) REFERENCES knowledge_bases(tenant_id,id)
);
CREATE TABLE knowledge_document_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,created_by text NOT NULL REFERENCES "user"(id),document_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),checksum text NOT NULL CHECK(length(checksum)=64),raw_content bytea NOT NULL CHECK(octet_length(raw_content)<=2097152),parser_version text NOT NULL DEFAULT 'safe-v1',chunker_version text NOT NULL DEFAULT 'unicode-v1',chunk_config jsonb NOT NULL,embedding_model text NOT NULL,embedding_dimensions integer NOT NULL CHECK(embedding_dimensions BETWEEN 8 AND 3072),status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed')),error_code text,attempt integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3,available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id,id),UNIQUE(document_id,version),UNIQUE(document_id,checksum,embedding_model),FOREIGN KEY(tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,id)
);
ALTER TABLE knowledge_documents ADD FOREIGN KEY(tenant_id,id,current_version_id) REFERENCES knowledge_document_versions(tenant_id,document_id,id);
CREATE TABLE knowledge_chunks (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,document_version_id uuid NOT NULL,chunk_index integer NOT NULL CHECK(chunk_index>=0),content text NOT NULL CHECK(length(content) BETWEEN 1 AND 16000),content_hash text NOT NULL CHECK(length(content_hash)=64),metadata jsonb NOT NULL,embedding public.vector NOT NULL,embedding_model text NOT NULL,embedding_dimensions integer NOT NULL,token_count integer NOT NULL CHECK(token_count>0),search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple',content)) STORED,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(document_version_id,chunk_index),FOREIGN KEY(tenant_id,document_version_id) REFERENCES knowledge_document_versions(tenant_id,id),CHECK(public.vector_dims(embedding)=embedding_dimensions),CHECK(content_hash=encode(sha256(convert_to(content,'UTF8')),'hex'))
);
CREATE INDEX knowledge_fts ON knowledge_chunks USING gin(search_vector);
CREATE INDEX ON knowledge_chunks(tenant_id,embedding_model,document_version_id);
CREATE TABLE knowledge_groups(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL,UNIQUE(tenant_id,id));
CREATE TABLE knowledge_group_members(tenant_id uuid NOT NULL,group_id uuid NOT NULL,user_id text NOT NULL REFERENCES "user"(id),PRIMARY KEY(tenant_id,group_id,user_id),FOREIGN KEY(tenant_id,group_id) REFERENCES knowledge_groups(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES tenant_memberships(tenant_id,user_id));
CREATE TABLE knowledge_acl (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),knowledge_base_id uuid,document_id uuid,subject_type text NOT NULL CHECK(subject_type IN ('user','role','group','tenant')),subject_id text NOT NULL,permission text NOT NULL CHECK(permission IN ('read','write','manage')),created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,knowledge_base_id) REFERENCES knowledge_bases(tenant_id,id),FOREIGN KEY(tenant_id,knowledge_base_id,document_id) REFERENCES knowledge_documents(tenant_id,knowledge_base_id,id),CHECK(document_id IS NULL OR knowledge_base_id IS NOT NULL),UNIQUE NULLS NOT DISTINCT(tenant_id,knowledge_base_id,document_id,subject_type,subject_id,permission)
);
CREATE TABLE agent_memories (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),owner_user_id text NOT NULL REFERENCES "user"(id),agent_id text NOT NULL DEFAULT 'risk-agent' CHECK(length(agent_id) BETWEEN 1 AND 80),scope text NOT NULL CHECK(scope IN ('tenant','user','agent','session')),session_id uuid,memory_type text NOT NULL CHECK(memory_type IN ('fact','preference','session_summary')),content text NOT NULL CHECK(length(content)<=8000),content_hash text NOT NULL,source_reference jsonb NOT NULL,confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),expires_at timestamptz NOT NULL CHECK(expires_at<=created_at+interval '90 days'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,session_id) REFERENCES conversations(tenant_id,id),CHECK((scope='session')=(session_id IS NOT NULL)),CHECK(memory_type<>'session_summary' OR scope='session')
);
CREATE UNIQUE INDEX memory_active_dedupe ON agent_memories(tenant_id,owner_user_id,agent_id,scope,COALESCE(session_id,'00000000-0000-0000-0000-000000000000'::uuid),content_hash) WHERE status='active';
CREATE INDEX ON agent_memories(tenant_id,owner_user_id,scope,expires_at);
CREATE TABLE retrieval_snapshots (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,tool_call_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('knowledge','memory')),query_hash text NOT NULL,retrieval_config_version text NOT NULL,document_version_ids uuid[] NOT NULL DEFAULT '{}',chunk_ids uuid[] NOT NULL DEFAULT '{}',memory_ids uuid[] NOT NULL DEFAULT '{}',citation_metadata jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,tool_call_id),UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id)
);
CREATE FUNCTION eap_knowledge_access(k uuid,d uuid,p text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM knowledge_bases b WHERE b.id=k AND b.tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND b.status='active'
 AND eap_member(b.tenant_id,current_setting('eap.actor_id',true))
 AND (b.created_by=current_setting('eap.actor_id',true) OR EXISTS(SELECT 1 FROM knowledge_acl a WHERE a.tenant_id=b.tenant_id AND (a.knowledge_base_id IS NULL OR a.knowledge_base_id=k) AND (a.document_id IS NULL OR a.document_id=d)
 AND (a.permission='manage' OR a.permission=p OR p='read' AND a.permission='write')
 AND (a.subject_type='tenant' OR a.subject_type='user' AND a.subject_id=current_setting('eap.actor_id',true) OR a.subject_type='role' AND a.subject_id=eap_role(a.tenant_id,current_setting('eap.actor_id',true)) OR a.subject_type='group' AND EXISTS(SELECT 1 FROM knowledge_group_members m WHERE m.tenant_id=a.tenant_id AND m.group_id::text=a.subject_id AND m.user_id=current_setting('eap.actor_id',true))))) )
$$;
CREATE FUNCTION eap_memory_access(t uuid,u text,s text,sid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT t=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(t,current_setting('eap.actor_id',true)) AND (s='tenant' OR u=current_setting('eap.actor_id',true))
$$;
CREATE FUNCTION eap_knowledge_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
 BEGIN INSERT INTO audit_logs(event_id,tenant_id,actor_user_id,action,resource_type,resource_id,decision,reason_code) VALUES(gen_random_uuid(),COALESCE(NEW.tenant_id,OLD.tenant_id),NULLIF(current_setting('eap.actor_id',true),''),'knowledge.'||TG_TABLE_NAME||'.'||lower(TG_OP),TG_TABLE_NAME,COALESCE(NEW.id,OLD.id)::text,'allow','MUTATED');RETURN COALESCE(NEW,OLD);END $$;
CREATE FUNCTION eap_knowledge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_TABLE_NAME='knowledge_document_versions' AND OLD.status='ready' THEN RAISE EXCEPTION 'Ready version immutable';END IF;
 IF TG_TABLE_NAME='knowledge_chunks' THEN RAISE EXCEPTION 'Indexed chunks immutable';END IF;
 IF TG_TABLE_NAME='retrieval_snapshots' THEN RAISE EXCEPTION 'Snapshot immutable';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER ready_version_guard BEFORE UPDATE OR DELETE ON knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION eap_knowledge_guard();
CREATE TRIGGER chunk_guard BEFORE UPDATE OR DELETE ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION eap_knowledge_guard();
CREATE TRIGGER snapshot_guard BEFORE UPDATE OR DELETE ON retrieval_snapshots FOR EACH ROW EXECUTE FUNCTION eap_knowledge_guard();
CREATE FUNCTION eap_claim_ingestion(tok uuid,seconds integer) RETURNS SETOF knowledge_document_versions LANGUAGE plpgsql SECURITY DEFINER AS $$
 BEGIN
 IF seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 UPDATE knowledge_document_versions SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'queued' END,lease_token=NULL,lease_expires_at=NULL,error_code='LEASE_EXPIRED' WHERE status='processing' AND lease_expires_at<clock_timestamp();
 RETURN QUERY WITH candidate AS(SELECT v.id FROM knowledge_document_versions v JOIN knowledge_documents d ON d.id=v.document_id JOIN knowledge_bases b ON b.id=d.knowledge_base_id WHERE v.status='queued' AND v.available_at<=clock_timestamp() AND v.attempt<v.max_attempts AND d.status<>'deleted' AND b.status='active' ORDER BY v.created_at FOR UPDATE OF v SKIP LOCKED LIMIT 1)
 UPDATE knowledge_document_versions v SET status='processing',attempt=v.attempt+1,lease_token=tok,lease_expires_at=clock_timestamp()+seconds*interval '1 second' FROM candidate c WHERE v.id=c.id RETURNING v.*;
 END $$;
DO $$ DECLARE t text;s text:=current_schema();f text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_bases','knowledge_documents','knowledge_document_versions','knowledge_chunks','knowledge_acl','knowledge_groups','knowledge_group_members','agent_memories','retrieval_snapshots'] LOOP
 EXECUTE format('ALTER TABLE %I OWNER TO eap_owner',t);
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY maintenance ON %I TO eap_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH f IN ARRAY ARRAY['eap_knowledge_access(uuid,uuid,text)','eap_knowledge_audit()','eap_claim_ingestion(uuid,integer)'] LOOP
 EXECUTE format('ALTER FUNCTION %s SET search_path=%I,public,pg_temp',f,s);EXECUTE format('ALTER FUNCTION %s OWNER TO eap_owner',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
 GRANT EXECUTE ON FUNCTION eap_knowledge_access(uuid,uuid,text) TO eap_app,eap_worker;
 GRANT EXECUTE ON FUNCTION eap_claim_ingestion(uuid,integer) TO eap_worker;
 FOREACH t IN ARRAY ARRAY['knowledge_bases','knowledge_documents','knowledge_acl','agent_memories','knowledge_groups'] LOOP
 EXECUTE format('CREATE TRIGGER knowledge_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION eap_knowledge_audit()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON knowledge_bases,knowledge_documents,knowledge_document_versions,agent_memories TO eap_app;
GRANT SELECT,INSERT,DELETE ON knowledge_acl,knowledge_groups,knowledge_group_members TO eap_app;
GRANT SELECT ON knowledge_chunks,retrieval_snapshots TO eap_app;
GRANT SELECT,UPDATE ON knowledge_documents,knowledge_document_versions TO eap_worker;
GRANT SELECT ON knowledge_bases,knowledge_acl,knowledge_groups,knowledge_group_members,agent_memories TO eap_worker;
GRANT SELECT,INSERT ON knowledge_chunks,retrieval_snapshots TO eap_worker;
GRANT SELECT,INSERT,UPDATE ON agent_memories TO eap_worker;
CREATE POLICY kb_read ON knowledge_bases FOR SELECT TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(tenant_id,current_setting('eap.actor_id',true)) AND (created_by=current_setting('eap.actor_id',true) OR eap_knowledge_access(id,NULL,'read') OR eap_knowledge_access(id,NULL,'manage')));
CREATE POLICY kb_create ON knowledge_bases FOR INSERT TO eap_app WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND created_by=current_setting('eap.actor_id',true) AND eap_role(tenant_id,created_by) IN ('owner','admin','member'));
CREATE POLICY kb_write ON knowledge_bases FOR UPDATE TO eap_app USING(eap_knowledge_access(id,NULL,'manage')) WITH CHECK(eap_knowledge_access(id,NULL,'manage'));
CREATE POLICY doc_read ON knowledge_documents FOR SELECT TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_knowledge_access(knowledge_base_id,id,'read'));
CREATE POLICY doc_write ON knowledge_documents FOR INSERT TO eap_app WITH CHECK(eap_knowledge_access(knowledge_base_id,NULL,'write') AND created_by=current_setting('eap.actor_id',true));
CREATE POLICY doc_update ON knowledge_documents FOR UPDATE TO eap_app,eap_worker USING(eap_knowledge_access(knowledge_base_id,id,'write')) WITH CHECK(eap_knowledge_access(knowledge_base_id,id,'write'));
CREATE POLICY version_read ON knowledge_document_versions FOR SELECT TO eap_app,eap_worker USING(EXISTS(SELECT 1 FROM knowledge_documents d WHERE d.id=document_id AND d.tenant_id=knowledge_document_versions.tenant_id AND d.status<>'deleted'));
CREATE POLICY version_insert ON knowledge_document_versions FOR INSERT TO eap_app WITH CHECK(EXISTS(SELECT 1 FROM knowledge_documents d WHERE d.id=document_id AND eap_knowledge_access(d.knowledge_base_id,d.id,'write')));
CREATE POLICY version_update ON knowledge_document_versions FOR UPDATE TO eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid);
CREATE POLICY chunk_read ON knowledge_chunks FOR SELECT TO eap_app,eap_worker USING(EXISTS(SELECT 1 FROM knowledge_document_versions v JOIN knowledge_documents d ON d.id=v.document_id WHERE v.id=document_version_id AND v.status='ready' AND d.status<>'deleted' AND eap_knowledge_access(d.knowledge_base_id,d.id,'read')));
CREATE POLICY chunk_insert ON knowledge_chunks FOR INSERT TO eap_worker WITH CHECK(EXISTS(SELECT 1 FROM knowledge_document_versions v WHERE v.id=document_version_id AND v.tenant_id=knowledge_chunks.tenant_id AND v.status='processing' AND v.embedding_model=knowledge_chunks.embedding_model AND v.embedding_dimensions=knowledge_chunks.embedding_dimensions));
CREATE POLICY acl_read ON knowledge_acl FOR SELECT TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(tenant_id,current_setting('eap.actor_id',true)) AND (knowledge_base_id IS NOT NULL AND eap_knowledge_access(knowledge_base_id,document_id,'manage') OR eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin')));
CREATE POLICY acl_write ON knowledge_acl FOR ALL TO eap_app USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND (knowledge_base_id IS NOT NULL AND eap_knowledge_access(knowledge_base_id,document_id,'manage') OR eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'))) WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND (knowledge_base_id IS NOT NULL AND eap_knowledge_access(knowledge_base_id,document_id,'manage') OR eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin')));
CREATE POLICY groups_read ON knowledge_groups FOR SELECT TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(tenant_id,current_setting('eap.actor_id',true)));
CREATE POLICY groups_manage ON knowledge_groups FOR ALL TO eap_app USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin')) WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'));
CREATE POLICY group_members_read ON knowledge_group_members FOR SELECT TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(tenant_id,current_setting('eap.actor_id',true)));
CREATE POLICY group_members_manage ON knowledge_group_members FOR ALL TO eap_app USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin')) WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'));
CREATE POLICY memory_read ON agent_memories FOR SELECT TO eap_app,eap_worker USING(eap_memory_access(tenant_id,owner_user_id,scope,session_id) AND ((status='active' AND expires_at>clock_timestamp()) OR (status='deleted' AND content='')));
CREATE POLICY memory_write ON agent_memories FOR INSERT TO eap_app,eap_worker WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND owner_user_id=current_setting('eap.actor_id',true) AND eap_role(tenant_id,owner_user_id) IN ('owner','admin','member') AND (scope<>'tenant' OR eap_role(tenant_id,owner_user_id) IN ('owner','admin')) AND (scope<>'session' OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=session_id AND c.tenant_id=agent_memories.tenant_id AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.conversation_id=c.id AND r.actor_user_id=owner_user_id))));
CREATE POLICY memory_update ON agent_memories FOR UPDATE TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND owner_user_id=current_setting('eap.actor_id',true)) WITH CHECK(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND owner_user_id=current_setting('eap.actor_id',true));
CREATE POLICY snapshot_read ON retrieval_snapshots FOR SELECT TO eap_app,eap_worker USING(EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=run_id AND r.tenant_id=retrieval_snapshots.tenant_id AND r.actor_user_id=current_setting('eap.actor_id',true)));
CREATE POLICY snapshot_insert ON retrieval_snapshots FOR INSERT TO eap_worker WITH CHECK(EXISTS(SELECT 1 FROM agent_runs r JOIN agent_jobs j ON j.run_id=r.id WHERE r.id=run_id AND r.tenant_id=retrieval_snapshots.tenant_id AND r.actor_user_id=current_setting('eap.actor_id',true) AND j.status='running' AND j.lease_expires_at>clock_timestamp()));
CREATE FUNCTION eap_knowledge_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'Identity immutable';END IF;
 IF TG_TABLE_NAME IN ('knowledge_bases','knowledge_documents') THEN IF NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Owner immutable';END IF;END IF;
 IF TG_TABLE_NAME='agent_memories' THEN IF NEW.owner_user_id<>OLD.owner_user_id OR NEW.scope<>OLD.scope OR NEW.agent_id<>OLD.agent_id OR NEW.session_id IS DISTINCT FROM OLD.session_id THEN RAISE EXCEPTION 'Memory scope immutable';END IF;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER kb_identity BEFORE UPDATE ON knowledge_bases FOR EACH ROW EXECUTE FUNCTION eap_knowledge_identity_guard();
CREATE TRIGGER doc_identity BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION eap_knowledge_identity_guard();
CREATE TRIGGER memory_identity BEFORE UPDATE ON agent_memories FOR EACH ROW EXECUTE FUNCTION eap_knowledge_identity_guard();
ALTER TABLE retrieval_snapshots ADD COLUMN memory_hashes jsonb NOT NULL DEFAULT '{}';

ALTER TABLE agent_memories ADD CHECK(status<>'deleted' OR content='');
CREATE FUNCTION eap_retrieval_valid(rid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=rid AND r.tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND r.actor_user_id=current_setting('eap.actor_id',true) AND eap_member(r.tenant_id,r.actor_user_id))
 AND NOT EXISTS(SELECT 1 FROM retrieval_snapshots s CROSS JOIN LATERAL unnest(s.chunk_ids) cid WHERE s.run_id=rid AND NOT EXISTS(SELECT 1 FROM knowledge_chunks c JOIN knowledge_document_versions v ON v.id=c.document_version_id JOIN knowledge_documents d ON d.id=v.document_id WHERE c.id=cid AND c.tenant_id=s.tenant_id AND d.status<>'deleted' AND v.status='ready' AND eap_knowledge_access(d.knowledge_base_id,d.id,'read')))
 AND NOT EXISTS(SELECT 1 FROM retrieval_snapshots s CROSS JOIN LATERAL unnest(s.memory_ids) mid WHERE s.run_id=rid AND NOT EXISTS(SELECT 1 FROM agent_memories m WHERE m.id=mid AND m.tenant_id=s.tenant_id AND m.status='active' AND m.expires_at>clock_timestamp() AND eap_memory_access(m.tenant_id,m.owner_user_id,m.scope,m.session_id) AND m.content_hash=s.memory_hashes->>m.id::text))
$$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION eap_retrieval_valid(uuid) SET search_path=%I,public,pg_temp',current_schema());
 ALTER FUNCTION eap_retrieval_valid(uuid) OWNER TO eap_owner;
 REVOKE ALL ON FUNCTION eap_retrieval_valid(uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION eap_retrieval_valid(uuid) TO eap_app,eap_worker;
END $$;
ALTER TABLE agent_memories ADD CHECK(content_hash=encode(sha256(convert_to(content,'UTF8')),'hex'));
ALTER TABLE knowledge_document_versions ADD CHECK(checksum=encode(sha256(raw_content),'hex'));
INSERT INTO tenant_tool_policies(tenant_id,tool_name,enabled,allowed_roles,risk_level,requires_approval)
SELECT t.id,n.name,false,ARRAY['owner','admin','member'],CASE WHEN n.name IN ('memory_write','memory_delete') THEN 'high' ELSE 'low' END,n.name IN ('memory_write','memory_delete')
FROM tenants t CROSS JOIN (VALUES('search_knowledge'),('memory_search'),('memory_list'),('memory_write'),('memory_delete')) n(name) ON CONFLICT DO NOTHING;
-- TTL is enforced on every read immediately; bounded maintenance erases expired content.
CREATE FUNCTION eap_expire_memories(batch_size integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n integer;BEGIN
 IF batch_size NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid retention batch';END IF;
 WITH expired AS(SELECT id FROM agent_memories WHERE status='active' AND expires_at<=clock_timestamp() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT batch_size)
 UPDATE agent_memories m SET status='deleted',content='',content_hash=encode(sha256(convert_to('','UTF8')),'hex'),updated_at=clock_timestamp() FROM expired e WHERE m.id=e.id;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END $$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION eap_expire_memories(integer) SET search_path=%I,public,pg_temp',current_schema());
 ALTER FUNCTION eap_expire_memories(integer) OWNER TO eap_owner;
 REVOKE ALL ON FUNCTION eap_expire_memories(integer) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION eap_expire_memories(integer) TO eap_worker;
END $$;
