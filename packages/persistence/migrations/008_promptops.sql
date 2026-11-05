CREATE TABLE prompt_definitions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),key text NOT NULL CHECK(key ~ '^[a-z][a-z0-9_-]{0,79}$'),name text NOT NULL,description text NOT NULL DEFAULT '',
 created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,key),UNIQUE(tenant_id,id)
);
CREATE TABLE prompt_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,prompt_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 document jsonb NOT NULL,canonical_document text NOT NULL,content_hash text NOT NULL,
 template text GENERATED ALWAYS AS (document->>'template') STORED,variables_schema jsonb GENERATED ALWAYS AS (document->'variables_schema') STORED,model_config jsonb GENERATED ALWAYS AS (document->'model_config') STORED,
 created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,
 FOREIGN KEY(tenant_id,prompt_id) REFERENCES prompt_definitions(tenant_id,id),UNIQUE(prompt_id,version),UNIQUE(tenant_id,id),UNIQUE(tenant_id,prompt_id,id),
 CHECK(document=canonical_document::jsonb),CHECK(content_hash=encode(sha256(convert_to(canonical_document,'UTF8')),'hex')),CHECK(length(document->>'template') BETWEEN 1 AND 16000)
);
CREATE TABLE prompt_revocations (
 version_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,version_id) REFERENCES prompt_versions(tenant_id,id)
);
ALTER TABLE eval_runs ADD COLUMN prompt_version_id uuid,ADD COLUMN prompt_content_hash text,ADD COLUMN tool_policy_document jsonb;
ALTER TABLE eval_runs ADD FOREIGN KEY(tenant_id,prompt_version_id) REFERENCES prompt_versions(tenant_id,id);
CREATE TABLE prompt_releases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,prompt_id uuid NOT NULL,stable_version_id uuid NOT NULL,canary_version_id uuid NOT NULL,predecessor_id uuid,
 canary_percentage integer NOT NULL DEFAULT 0 CHECK(canary_percentage IN (0,5,25,50,100)),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','rolled_back','completed','superseded')),
 evaluation_run_id uuid NOT NULL,dataset_version_id uuid NOT NULL,code_revision text NOT NULL,revision integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES "user"(id),approved_by text REFERENCES "user"(id),reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,prompt_id) REFERENCES prompt_definitions(tenant_id,id),FOREIGN KEY(tenant_id,prompt_id,stable_version_id) REFERENCES prompt_versions(tenant_id,prompt_id,id),FOREIGN KEY(tenant_id,prompt_id,canary_version_id) REFERENCES prompt_versions(tenant_id,prompt_id,id),
 FOREIGN KEY(tenant_id,evaluation_run_id) REFERENCES eval_runs(tenant_id,id),FOREIGN KEY(tenant_id,dataset_version_id) REFERENCES eval_dataset_versions(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,prompt_id,id),FOREIGN KEY(tenant_id,prompt_id,predecessor_id) REFERENCES prompt_releases(tenant_id,prompt_id,id)
);
CREATE UNIQUE INDEX prompt_one_live_release ON prompt_releases(prompt_id) WHERE status IN ('active','paused','completed','rolled_back');
CREATE TABLE prompt_experiments (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,prompt_id uuid NOT NULL,release_id uuid NOT NULL,name text NOT NULL,control_version_id uuid NOT NULL,treatment_version_id uuid NOT NULL,
 allocation_percentage integer NOT NULL CHECK(allocation_percentage BETWEEN 0 AND 100),assignment_unit text NOT NULL CHECK(assignment_unit IN ('user','conversation')),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','ended')),revision integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES "user"(id),started_at timestamptz,ended_at timestamptz,
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,prompt_id,release_id) REFERENCES prompt_releases(tenant_id,prompt_id,id),FOREIGN KEY(tenant_id,prompt_id,control_version_id) REFERENCES prompt_versions(tenant_id,prompt_id,id),FOREIGN KEY(tenant_id,prompt_id,treatment_version_id) REFERENCES prompt_versions(tenant_id,prompt_id,id)
);
CREATE UNIQUE INDEX prompt_one_experiment ON prompt_experiments(prompt_id) WHERE status IN ('running','paused');
CREATE TABLE prompt_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,experiment_id uuid NOT NULL,assignment_key_hash text NOT NULL CHECK(assignment_key_hash ~ '^[0-9a-f]{64}$'),variant text NOT NULL CHECK(variant IN ('control','treatment')),assigned_version_id uuid NOT NULL,assigned_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(experiment_id,assignment_key_hash),FOREIGN KEY(tenant_id,experiment_id) REFERENCES prompt_experiments(tenant_id,id),FOREIGN KEY(tenant_id,assigned_version_id) REFERENCES prompt_versions(tenant_id,id)
);
ALTER TABLE agent_runs ADD COLUMN prompt_binding jsonb;
ALTER TABLE agent_runs ADD COLUMN prompt_id uuid GENERATED ALWAYS AS ((prompt_binding->>'prompt_id')::uuid) STORED,
 ADD COLUMN prompt_version_id uuid GENERATED ALWAYS AS ((prompt_binding->>'prompt_version_id')::uuid) STORED,
 ADD COLUMN prompt_content_hash text GENERATED ALWAYS AS (prompt_binding->>'prompt_content_hash') STORED,
 ADD COLUMN release_id uuid GENERATED ALWAYS AS ((prompt_binding->>'release_id')::uuid) STORED,
 ADD COLUMN experiment_id uuid GENERATED ALWAYS AS ((prompt_binding->>'experiment_id')::uuid) STORED,
 ADD COLUMN prompt_variant text GENERATED ALWAYS AS (prompt_binding->>'variant') STORED;
ALTER TABLE agent_runs ADD FOREIGN KEY(tenant_id,prompt_id,prompt_version_id) REFERENCES prompt_versions(tenant_id,prompt_id,id),ADD FOREIGN KEY(tenant_id,prompt_id,release_id) REFERENCES prompt_releases(tenant_id,prompt_id,id),ADD FOREIGN KEY(tenant_id,experiment_id) REFERENCES prompt_experiments(tenant_id,id);
CREATE INDEX ON prompt_versions(tenant_id,prompt_id,version DESC);
CREATE INDEX ON prompt_releases(tenant_id,prompt_id,created_at DESC);
CREATE INDEX ON agent_runs(tenant_id,experiment_id,prompt_variant);
CREATE INDEX ON prompt_assignments(tenant_id,experiment_id,variant);
CREATE FUNCTION eap_prompt_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN IF NEW.created_by IS DISTINCT FROM current_setting('eap.actor_id',true) THEN RAISE EXCEPTION 'Invalid prompt author';END IF;
 ELSIF ROW(NEW.id,NEW.tenant_id,NEW.key,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.key,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'Prompt definition identity immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prompt_definition_guard BEFORE INSERT OR UPDATE ON prompt_definitions FOR EACH ROW EXECUTE FUNCTION eap_prompt_definition_guard();
CREATE FUNCTION eap_prompt_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_version integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Prompt versions immutable';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM 1 FROM prompt_definitions WHERE id=NEW.prompt_id FOR UPDATE;
  SELECT COALESCE(max(version),0)+1 INTO next_version FROM prompt_versions WHERE prompt_id=NEW.prompt_id;
  IF NEW.created_by IS DISTINCT FROM current_setting('eap.actor_id',true) OR NEW.status<>'draft' OR NEW.published_at IS NOT NULL OR NEW.version<>next_version OR NEW.revision<>1 THEN RAISE EXCEPTION 'Invalid draft version';END IF;
 ELSE
  IF OLD.status='published' AND NEW.status='archived' AND NEW.revision=OLD.revision+1 THEN
   IF ROW(NEW.id,NEW.tenant_id,NEW.prompt_id,NEW.version,NEW.document,NEW.canonical_document,NEW.content_hash,NEW.created_by,NEW.created_at,NEW.published_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.prompt_id,OLD.version,OLD.document,OLD.canonical_document,OLD.content_hash,OLD.created_by,OLD.created_at,OLD.published_at) OR EXISTS(SELECT 1 FROM prompt_releases WHERE status IN ('active','paused','completed','rolled_back') AND (stable_version_id=OLD.id OR canary_version_id=OLD.id)) THEN RAISE EXCEPTION 'Published prompt immutable or live';END IF;
   RETURN NEW;
  END IF;
  IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Published prompt immutable';END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.prompt_id<>OLD.prompt_id OR NEW.version<>OLD.version OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid prompt revision';END IF;
  IF NEW.status='published' THEN NEW.published_at=clock_timestamp();ELSIF NEW.status<>'draft' OR NEW.published_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid prompt transition';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prompt_version_guard BEFORE INSERT OR UPDATE OR DELETE ON prompt_versions FOR EACH ROW EXECUTE FUNCTION eap_prompt_version_guard();
CREATE TRIGGER prompt_revocation_immutable BEFORE UPDATE OR DELETE ON prompt_revocations FOR EACH ROW EXECUTE FUNCTION eap_eval_result_guard();
CREATE TRIGGER prompt_assignment_immutable BEFORE UPDATE OR DELETE ON prompt_assignments FOR EACH ROW EXECUTE FUNCTION eap_eval_result_guard();
CREATE FUNCTION eap_prompt_eval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v prompt_versions;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.prompt_version_id,NEW.prompt_content_hash,NEW.tool_policy_document,NEW.dataset_version_id,NEW.baseline_run_id,NEW.config_snapshot,NEW.gate_config,NEW.code_revision) IS DISTINCT FROM ROW(OLD.prompt_version_id,OLD.prompt_content_hash,OLD.tool_policy_document,OLD.dataset_version_id,OLD.baseline_run_id,OLD.config_snapshot,OLD.gate_config,OLD.code_revision) THEN RAISE EXCEPTION 'Evaluation binding immutable';END IF;
 ELSE
  IF NEW.status<>'queued' OR NEW.report IS NOT NULL OR NEW.gate_result IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.worker_id IS NOT NULL OR NEW.lease_token IS NOT NULL THEN RAISE EXCEPTION 'Evaluation must be enqueued before worker execution';END IF;
  IF NEW.prompt_version_id IS NOT NULL THEN
  SELECT * INTO v FROM prompt_versions WHERE id=NEW.prompt_version_id;
  IF v.status<>'published' OR v.content_hash<>NEW.prompt_content_hash OR v.model_config->>'provider'<>NEW.model_provider OR v.model_config->>'model'<>NEW.model_name OR NEW.config_snapshot->>'prompt_version_id'<>v.id::text OR NEW.config_snapshot->>'prompt_content_hash'<>v.content_hash THEN RAISE EXCEPTION 'Invalid evaluation binding';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER prompt_eval_binding BEFORE INSERT OR UPDATE ON eval_runs FOR EACH ROW EXECUTE FUNCTION eap_prompt_eval_guard();
CREATE FUNCTION eap_prompt_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v prompt_versions;e eval_runs;b eval_runs;previous prompt_releases;policy jsonb;actor text:=current_setting('eap.actor_id',true);
BEGIN
 IF eap_role(NEW.tenant_id,actor) NOT IN ('owner','admin') OR eap_role(NEW.tenant_id,actor) IS NULL THEN RAISE EXCEPTION 'Release permission required';END IF;
 PERFORM 1 FROM prompt_definitions WHERE id=NEW.prompt_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.approved_by IS NOT NULL OR NEW.created_by<>actor OR NEW.revision<>1 OR NEW.canary_percentage<>0 THEN RAISE EXCEPTION 'Invalid release draft';END IF;
  SELECT * INTO previous FROM prompt_releases WHERE prompt_id=NEW.prompt_id AND status IN ('active','paused','completed','rolled_back');
  IF previous.id IS NULL THEN IF NEW.stable_version_id<>NEW.canary_version_id OR NEW.predecessor_id IS NOT NULL THEN RAISE EXCEPTION 'Bootstrap stable must be evaluated candidate';END IF;
  ELSIF NEW.predecessor_id IS DISTINCT FROM previous.id OR NEW.stable_version_id IS DISTINCT FROM (CASE WHEN previous.status='completed' THEN previous.canary_version_id ELSE previous.stable_version_id END) THEN RAISE EXCEPTION 'Stable release mismatch';END IF;
 ELSE
  IF NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['status','canary_percentage','approved_by','reason','revision','updated_at','stable_version_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','canary_percentage','approved_by','reason','revision','updated_at','stable_version_id']) THEN RAISE EXCEPTION 'Release identity immutable';END IF;
  IF NEW.status='superseded' THEN
   IF OLD.status NOT IN ('completed','rolled_back') THEN RAISE EXCEPTION 'Finish or rollback previous release first';END IF;
   RETURN NEW;
  END IF;
  IF OLD.status='draft' AND NEW.status='active' THEN
   SELECT * INTO v FROM prompt_versions WHERE id=NEW.canary_version_id;
   IF actor=NEW.created_by OR actor=v.created_by OR NEW.approved_by IS DISTINCT FROM actor OR NEW.canary_percentage<>0 THEN RAISE EXCEPTION 'Independent approval required';END IF;
  ELSIF NEW.status='rolled_back' AND OLD.status IN ('active','paused','completed') THEN
   IF length(NEW.reason)=0 OR NEW.canary_percentage<>0 THEN RAISE EXCEPTION 'Rollback reason required';END IF;
  ELSIF OLD.status='active' AND NEW.status IN ('active','paused','completed') OR OLD.status='paused' AND NEW.status='active' THEN
   IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN RAISE EXCEPTION 'Approval immutable';END IF;
   IF NEW.status='completed' AND (NEW.canary_percentage<>100 OR OLD.canary_percentage<>100) THEN RAISE EXCEPTION 'Completion requires full rollout';END IF;
   IF NEW.canary_percentage<OLD.canary_percentage THEN RAISE EXCEPTION 'Use rollback to reduce rollout';END IF;
   IF NEW.status='active' AND NEW.canary_percentage<>OLD.canary_percentage AND NEW.canary_percentage<>(CASE OLD.canary_percentage WHEN 0 THEN 5 WHEN 5 THEN 25 WHEN 25 THEN 50 WHEN 50 THEN 100 ELSE 100 END) THEN RAISE EXCEPTION 'Invalid rollout stage';END IF;
  ELSE RAISE EXCEPTION 'Invalid release transition';END IF;
  IF NEW.stable_version_id<>OLD.stable_version_id THEN RAISE EXCEPTION 'Stable immutable';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM prompt_versions pv WHERE pv.id IN (NEW.stable_version_id,NEW.canary_version_id) AND pv.status<>'published') THEN RAISE EXCEPTION 'Published versions required';END IF;
 IF EXISTS(SELECT 1 FROM prompt_revocations WHERE version_id=NEW.stable_version_id OR version_id=NEW.canary_version_id AND NEW.status<>'rolled_back') THEN RAISE EXCEPTION 'Prompt revoked';END IF;
 IF NEW.status NOT IN ('draft','rolled_back','paused') THEN
  IF NEW.canary_percentage>0 AND EXISTS(SELECT 1 FROM prompt_experiments WHERE prompt_id=NEW.prompt_id AND status IN ('running','paused')) THEN RAISE EXCEPTION 'Experiment conflicts with rollout';END IF;
  SELECT * INTO e FROM eval_runs WHERE id=NEW.evaluation_run_id;
  SELECT jsonb_agg(jsonb_build_object('tool_name',tool_name,'enabled',enabled,'allowed_roles',allowed_roles,'risk_level',risk_level,'requires_approval',requires_approval,'policy_version',policy_version) ORDER BY tool_name) INTO policy FROM tenant_tool_policies WHERE tenant_id=NEW.tenant_id;
  IF e.status<>'completed' OR e.completed_at IS NULL OR e.completed_at<clock_timestamp()-interval '24 hours' OR e.prompt_version_id IS DISTINCT FROM NEW.canary_version_id OR e.prompt_content_hash IS DISTINCT FROM (SELECT content_hash FROM prompt_versions WHERE id=NEW.canary_version_id) OR e.dataset_version_id<>NEW.dataset_version_id OR e.code_revision<>NEW.code_revision OR e.tool_policy_document IS DISTINCT FROM COALESCE(policy,'[]'::jsonb)
   OR e.gate_result->>'passed' IS DISTINCT FROM 'true' OR e.report->'summary'->>'overall_score' IS DISTINCT FROM '1' OR e.report->'summary'->>'pass_rate' IS DISTINCT FROM '1' OR e.report->'summary'->>'hard_failures' IS DISTINCT FROM '0' OR e.report->'summary'->>'missing' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'Prompt evaluation gate rejected';END IF;
  IF TG_OP='UPDATE' AND OLD.stable_version_id<>NEW.canary_version_id THEN
   SELECT * INTO b FROM eval_runs WHERE id=e.baseline_run_id;
   IF b.id IS NULL OR b.status<>'completed' OR b.prompt_version_id IS DISTINCT FROM OLD.stable_version_id OR b.dataset_version_id<>e.dataset_version_id OR b.code_revision<>e.code_revision OR b.model_provider<>e.model_provider OR b.model_name<>e.model_name OR b.tool_policy_document IS DISTINCT FROM e.tool_policy_document THEN RAISE EXCEPTION 'Compatible stable baseline required';END IF;
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER prompt_release_guard BEFORE INSERT OR UPDATE ON prompt_releases FOR EACH ROW EXECUTE FUNCTION eap_prompt_release_guard();
CREATE FUNCTION eap_prompt_experiment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r prompt_releases;actor text:=current_setting('eap.actor_id',true);
BEGIN
 IF eap_role(NEW.tenant_id,actor) NOT IN ('owner','admin') OR eap_role(NEW.tenant_id,actor) IS NULL THEN RAISE EXCEPTION 'Experiment permission required';END IF;
 SELECT * INTO r FROM prompt_releases WHERE id=NEW.release_id;
 IF NEW.control_version_id<>r.stable_version_id OR NEW.treatment_version_id<>r.canary_version_id THEN RAISE EXCEPTION 'Experiment release mismatch';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','revision','allocation_percentage','started_at','ended_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','allocation_percentage','started_at','ended_at']) OR NEW.revision<>OLD.revision+1 OR OLD.status='ended' THEN RAISE EXCEPTION 'Experiment immutable';END IF;
  IF NEW.status<>OLD.status AND NOT (OLD.status='draft' AND NEW.status='running' OR OLD.status='running' AND NEW.status IN ('paused','ended') OR OLD.status='paused' AND NEW.status IN ('running','ended')) THEN RAISE EXCEPTION 'Invalid experiment transition';END IF;
 ELSIF NEW.status<>'draft' OR NEW.created_by<>actor THEN RAISE EXCEPTION 'Invalid experiment draft';END IF;
 IF NEW.status IN ('running','paused') AND (r.status<>'active' OR r.canary_percentage<>0 OR r.approved_by IS NULL OR r.stable_version_id=r.canary_version_id) THEN RAISE EXCEPTION 'Approved zero-percent release required';END IF;
 IF NEW.status='running' AND NEW.started_at IS NULL THEN NEW.started_at=clock_timestamp();END IF;
 IF NEW.status='ended' THEN NEW.ended_at=clock_timestamp();END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prompt_experiment_guard BEFORE INSERT OR UPDATE ON prompt_experiments FOR EACH ROW EXECUTE FUNCTION eap_prompt_experiment_guard();
CREATE FUNCTION eap_prompt_assign(eid uuid,key_hash text,bucket double precision) RETURNS SETOF prompt_assignments LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE e prompt_experiments;t uuid:=NULLIF(current_setting('eap.tenant_id',true),'')::uuid;
BEGIN
 IF eap_role(t,current_setting('eap.actor_id',true)) IS NULL OR eap_role(t,current_setting('eap.actor_id',true))='viewer' OR bucket<0 OR bucket>=100 OR bucket::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Assignment forbidden';END IF;
 SELECT * INTO e FROM prompt_experiments WHERE id=eid AND tenant_id=t FOR SHARE;
 IF NOT FOUND OR e.status NOT IN ('running','paused') THEN RETURN;END IF;
 IF e.status='running' AND EXISTS(SELECT 1 FROM prompt_releases WHERE id=e.release_id AND status='active') THEN
  INSERT INTO prompt_assignments(tenant_id,experiment_id,assignment_key_hash,variant,assigned_version_id) VALUES(t,eid,key_hash,CASE WHEN bucket<e.allocation_percentage THEN 'treatment' ELSE 'control' END,CASE WHEN bucket<e.allocation_percentage THEN e.treatment_version_id ELSE e.control_version_id END) ON CONFLICT(experiment_id,assignment_key_hash) DO NOTHING;
 END IF;
 RETURN QUERY SELECT * FROM prompt_assignments WHERE experiment_id=eid AND assignment_key_hash=key_hash;
END $$;
CREATE FUNCTION eap_prompt_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v prompt_versions;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.prompt_binding IS DISTINCT FROM OLD.prompt_binding OR OLD.prompt_binding IS NOT NULL AND NEW.input IS DISTINCT FROM OLD.input THEN RAISE EXCEPTION 'Runtime prompt pin immutable';END IF;
 ELSIF NEW.prompt_binding IS NOT NULL THEN
  SELECT * INTO v FROM prompt_versions WHERE id=(NEW.prompt_binding->>'prompt_version_id')::uuid AND tenant_id=NEW.tenant_id AND prompt_id=(NEW.prompt_binding->>'prompt_id')::uuid;
  IF v.id IS NULL OR v.status<>'published' OR v.content_hash IS DISTINCT FROM NEW.prompt_binding->>'prompt_content_hash' OR EXISTS(SELECT 1 FROM prompt_revocations WHERE version_id=v.id) THEN RAISE EXCEPTION 'Invalid runtime prompt pin';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER prompt_run_guard BEFORE INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION eap_prompt_run_guard();
CREATE FUNCTION eap_prompt_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 INSERT INTO audit_logs(event_id,tenant_id,actor_user_id,action,resource_type,resource_id,decision,reason_code) VALUES(gen_random_uuid(),NEW.tenant_id,current_setting('eap.actor_id',true),'prompt.'||TG_TABLE_NAME||'.'||lower(TG_OP),TG_TABLE_NAME,COALESCE(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'version_id'),'allow',COALESCE(to_jsonb(NEW)->>'status','CHANGED'));
 RETURN NEW;
END $$;
DO $$ DECLARE s text:=current_schema();t text;f text;BEGIN
 FOREACH t IN ARRAY ARRAY['prompt_definitions','prompt_versions','prompt_releases','prompt_experiments','prompt_assignments','prompt_revocations'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO eap_owner',t);EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY maintenance ON %I TO eap_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY prompt_read ON %I FOR SELECT TO eap_app USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_role(tenant_id,current_setting(''eap.actor_id'',true)) IN (''owner'',''admin'',''member''))',t);
  EXECUTE format('CREATE POLICY prompt_worker ON %I FOR SELECT TO eap_worker USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid)',t);
  IF t NOT IN ('prompt_assignments') THEN
   EXECUTE format('CREATE POLICY prompt_write ON %I FOR ALL TO eap_app USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_role(tenant_id,current_setting(''eap.actor_id'',true)) IN (%s)) WITH CHECK(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_role(tenant_id,current_setting(''eap.actor_id'',true)) IN (%s))',t,CASE WHEN t IN ('prompt_definitions','prompt_versions') THEN '''owner'',''admin'',''member''' ELSE '''owner'',''admin''' END,CASE WHEN t IN ('prompt_definitions','prompt_versions') THEN '''owner'',''admin'',''member''' ELSE '''owner'',''admin''' END);
   EXECUTE format('CREATE TRIGGER prompt_audit AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION eap_prompt_audit()',t);
  END IF;
  EXECUTE format('GRANT SELECT ON %I TO eap_app,eap_worker',t);
 END LOOP;
 GRANT INSERT,UPDATE ON prompt_definitions,prompt_versions,prompt_releases,prompt_experiments TO eap_app;
 GRANT INSERT ON prompt_revocations TO eap_app;
 FOREACH f IN ARRAY ARRAY['eap_prompt_assign(uuid,text,double precision)','eap_prompt_audit()'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO eap_owner',f);EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_temp',f,s);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
 GRANT EXECUTE ON FUNCTION eap_prompt_assign(uuid,text,double precision) TO eap_app;
END $$;
