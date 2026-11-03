CREATE TABLE eval_datasets (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL,description text NOT NULL,created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE eval_dataset_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,dataset_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),content_hash text NOT NULL,
 document jsonb NOT NULL,canonical_document text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,
 FOREIGN KEY(tenant_id,dataset_id) REFERENCES eval_datasets(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(dataset_id,version),
 CHECK(document=canonical_document::jsonb),CHECK(content_hash=encode(sha256(convert_to(canonical_document,'UTF8')),'hex'))
);
CREATE TABLE eval_cases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,dataset_version_id uuid NOT NULL,case_id text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),document jsonb NOT NULL,
 content_hash text NOT NULL,canonical_document text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,dataset_version_id) REFERENCES eval_dataset_versions(tenant_id,id),UNIQUE(dataset_version_id,case_id),UNIQUE(dataset_version_id,ordinal),UNIQUE(tenant_id,dataset_version_id,id),
 CHECK(case_id=document->>'case_id'),CHECK(document=canonical_document::jsonb),CHECK(content_hash=encode(sha256(convert_to(canonical_document,'UTF8')),'hex'))
);
CREATE TABLE eval_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,dataset_version_id uuid NOT NULL,baseline_run_id uuid,model_provider text NOT NULL CHECK(model_provider IN ('mock','deepseek')),model_name text NOT NULL,model_version text NOT NULL,prompt_version text NOT NULL,code_revision text NOT NULL,config_snapshot jsonb NOT NULL,gate_config jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),created_by text NOT NULL REFERENCES "user"(id),
 worker_id text,lease_token uuid,lease_expires_at timestamptz,cancel_requested_at timestamptz,started_at timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 report jsonb,report_hash text,canonical_report text,gate_result jsonb,error_code text,
 FOREIGN KEY(tenant_id,dataset_version_id) REFERENCES eval_dataset_versions(tenant_id,id),FOREIGN KEY(tenant_id,baseline_run_id) REFERENCES eval_runs(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,dataset_version_id),
 CHECK(report IS NULL OR (report=canonical_report::jsonb AND report_hash=encode(sha256(convert_to(canonical_report,'UTF8')),'hex'))),CHECK(status<>'running' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE eval_case_results (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,eval_run_id uuid NOT NULL,dataset_version_id uuid NOT NULL,eval_case_id uuid NOT NULL,
 status text NOT NULL,score double precision NOT NULL CHECK(score>=0 AND score<=1),document jsonb NOT NULL,canonical_document text NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,eval_run_id,dataset_version_id) REFERENCES eval_runs(tenant_id,id,dataset_version_id),FOREIGN KEY(tenant_id,dataset_version_id,eval_case_id) REFERENCES eval_cases(tenant_id,dataset_version_id,id),
 UNIQUE(eval_run_id,eval_case_id),CHECK(document=canonical_document::jsonb),CHECK(content_hash=encode(sha256(convert_to(canonical_document,'UTF8')),'hex'))
);
CREATE INDEX ON eval_runs(tenant_id,created_at DESC);
CREATE INDEX ON eval_runs(created_at) WHERE status='queued';
CREATE INDEX ON eval_case_results(tenant_id,eval_run_id);
CREATE FUNCTION eap_eval_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE published timestamptz; v eval_dataset_versions; documents jsonb;
BEGIN
 IF TG_TABLE_NAME='eval_dataset_versions' THEN
  IF TG_OP='INSERT' THEN IF NEW.published_at IS NOT NULL THEN RAISE EXCEPTION 'Publish after inserting cases';END IF;RETURN NEW;END IF;
  IF OLD.published_at IS NOT NULL THEN RAISE EXCEPTION 'Published evaluation version immutable'; END IF;
  IF TG_OP='UPDATE' AND NEW.published_at IS NOT NULL THEN
   SELECT COALESCE(jsonb_agg(document ORDER BY ordinal),'[]'::jsonb) INTO documents FROM eval_cases WHERE dataset_version_id=NEW.id;
   IF documents IS DISTINCT FROM NEW.document->'cases' OR jsonb_array_length(documents)=0 THEN RAISE EXCEPTION 'Evaluation case manifest mismatch';END IF;
  END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN SELECT * INTO v FROM eval_dataset_versions WHERE id=OLD.dataset_version_id FOR UPDATE;IF v.published_at IS NOT NULL THEN RAISE EXCEPTION 'Published evaluation cases immutable';END IF;END IF;
  SELECT * INTO v FROM eval_dataset_versions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.dataset_version_id ELSE NEW.dataset_version_id END FOR UPDATE;
  IF v.published_at IS NOT NULL THEN RAISE EXCEPTION 'Published evaluation cases immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER eval_version_guard BEFORE INSERT OR UPDATE OR DELETE ON eval_dataset_versions FOR EACH ROW EXECUTE FUNCTION eap_eval_version_guard();
CREATE TRIGGER eval_cases_guard BEFORE INSERT OR UPDATE OR DELETE ON eval_cases FOR EACH ROW EXECUTE FUNCTION eap_eval_version_guard();
CREATE FUNCTION eap_eval_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Evaluation results immutable';END $$;
CREATE TRIGGER eval_result_guard BEFORE UPDATE OR DELETE ON eval_case_results FOR EACH ROW EXECUTE FUNCTION eap_eval_result_guard();
CREATE FUNCTION eap_claim_eval(w text,t uuid,seconds double precision) RETURNS SETOF eval_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 UPDATE eval_runs SET status='cancelled',error_code='CANCELLED',completed_at=clock_timestamp() WHERE status='queued' AND cancel_requested_at IS NOT NULL;
 UPDATE eval_runs SET status='interrupted',error_code='LEASE_EXPIRED',completed_at=clock_timestamp(),lease_expires_at=NULL WHERE status='running' AND lease_expires_at<=clock_timestamp();
 RETURN QUERY WITH candidate AS (SELECT id FROM eval_runs WHERE status='queued' AND cancel_requested_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE eval_runs r SET status='running',worker_id=w,lease_token=t,lease_expires_at=clock_timestamp()+seconds*interval '1 second',started_at=clock_timestamp() FROM candidate WHERE r.id=candidate.id RETURNING r.*;
END $$;
DO $$ DECLARE s text:=current_schema();t text;BEGIN
 FOREACH t IN ARRAY ARRAY['eval_datasets','eval_dataset_versions','eval_cases','eval_runs','eval_case_results'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO eap_owner',t);EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY maintenance ON %I TO eap_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY eval_app ON %I TO eap_app USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_role(tenant_id,current_setting(''eap.actor_id'',true)) IN (''owner'',''admin'')) WITH CHECK(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_role(tenant_id,current_setting(''eap.actor_id'',true)) IN (''owner'',''admin''))',t);
  EXECUTE format('CREATE POLICY eval_worker ON %I TO eap_worker USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
 GRANT SELECT ON eval_datasets,eval_dataset_versions,eval_cases,eval_runs,eval_case_results TO eap_app,eap_worker;
 GRANT INSERT ON eval_datasets,eval_dataset_versions,eval_cases,eval_runs TO eap_app;
 GRANT UPDATE ON eval_dataset_versions TO eap_app;
 GRANT UPDATE(cancel_requested_at) ON eval_runs TO eap_app;
 GRANT INSERT ON eval_case_results TO eap_worker;
 GRANT UPDATE ON eval_runs TO eap_worker;
 ALTER FUNCTION eap_claim_eval(text,uuid,double precision) OWNER TO eap_owner;
 EXECUTE format('ALTER FUNCTION eap_claim_eval(text,uuid,double precision) SET search_path=%I,pg_temp',s);
 REVOKE ALL ON FUNCTION eap_claim_eval(text,uuid,double precision) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION eap_claim_eval(text,uuid,double precision) TO eap_worker;
END $$;
