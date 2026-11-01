ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CHECK(status IN ('pending','running','waiting_approval','completed','failed','cancelled','interrupted'));
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_status_check;
ALTER TABLE agent_jobs ADD CHECK(status IN ('queued','running','waiting_approval','completed','failed','cancelled','blocked'));
ALTER TABLE agent_jobs ADD COLUMN checkpoint_version integer NOT NULL DEFAULT 0;
ALTER TABLE agent_jobs ADD COLUMN active_approval_id uuid;
ALTER TABLE agent_jobs ADD CHECK(status<>'waiting_approval' OR (lease_token IS NULL AND lease_expires_at IS NULL AND worker_id IS NULL AND active_approval_id IS NOT NULL));
DROP INDEX idx_one_active_run;
CREATE UNIQUE INDEX idx_one_active_run ON agent_runs(conversation_id) WHERE status IN ('pending','running','waiting_approval');
ALTER TABLE agent_jobs ADD UNIQUE(tenant_id,run_id,id);
CREATE TABLE agent_checkpoints (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), run_id uuid NOT NULL, job_id uuid NOT NULL,
 approval_id uuid NOT NULL UNIQUE, checkpoint_version integer NOT NULL CHECK(checkpoint_version>0),
 format_version integer NOT NULL DEFAULT 1 CHECK(format_version=1),
 runner_state jsonb NOT NULL, state_hash text NOT NULL CHECK(state_hash ~ '^[0-9a-f]{64}$'),
 pending_tool_call jsonb NOT NULL, pending_tool_call_hash text NOT NULL CHECK(pending_tool_call_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,run_id,job_id) REFERENCES agent_jobs(tenant_id,run_id,id),
 UNIQUE(tenant_id,run_id,job_id,id,checkpoint_version,pending_tool_call_hash), UNIQUE(job_id,checkpoint_version)
);
CREATE TABLE agent_approvals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), run_id uuid NOT NULL, job_id uuid NOT NULL,
 checkpoint_id uuid NOT NULL UNIQUE, checkpoint_version integer NOT NULL,
 tool_call_id text NOT NULL CHECK(length(tool_call_id) BETWEEN 1 AND 200),
 tool_name text NOT NULL CHECK(tool_name ~ '^[a-z][a-z0-9_]{0,79}$'),
 tool_arguments jsonb NOT NULL, tool_arguments_hash text NOT NULL CHECK(tool_arguments_hash ~ '^[0-9a-f]{64}$'),
 display_arguments jsonb NOT NULL, risk_level text NOT NULL CHECK(risk_level IN ('low','high')),
 requested_by_user_id text NOT NULL REFERENCES "user"(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
 requested_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 decided_by_user_id text REFERENCES "user"(id), decided_at timestamptz, decision_reason text CHECK(length(decision_reason)<=500),
 policy_version integer NOT NULL, consumed_by_lease uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,run_id,job_id,checkpoint_id,checkpoint_version,tool_arguments_hash)
 REFERENCES agent_checkpoints(tenant_id,run_id,job_id,id,checkpoint_version,pending_tool_call_hash),
 UNIQUE(tenant_id,id), UNIQUE(run_id,tool_call_id),
 CHECK(expires_at>requested_at), CHECK((status='pending')=(decided_at IS NULL)),
 CHECK(consumed_by_lease IS NULL OR status='approved')
);
ALTER TABLE agent_checkpoints ADD FOREIGN KEY(tenant_id,approval_id) REFERENCES agent_approvals(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE agent_jobs ADD FOREIGN KEY(tenant_id,active_approval_id) REFERENCES agent_approvals(tenant_id,id);
CREATE INDEX ON agent_approvals(tenant_id,status,requested_at DESC);
CREATE INDEX ON agent_approvals(expires_at) WHERE status='pending';
CREATE INDEX ON agent_checkpoints(tenant_id,run_id);
CREATE FUNCTION eap_checkpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Checkpoint immutable'; END $$;
CREATE TRIGGER immutable_checkpoint BEFORE UPDATE OR DELETE ON agent_checkpoints FOR EACH ROW EXECUTE FUNCTION eap_checkpoint_immutable();
CREATE FUNCTION eap_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approval immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','decided_by_user_id','decided_at','decision_reason','updated_at','consumed_by_lease']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','decided_by_user_id','decided_at','decision_reason','updated_at','consumed_by_lease']) THEN RAISE EXCEPTION 'Approval binding immutable'; END IF;
 IF NEW.status<>OLD.status THEN
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected','expired','cancelled') THEN RAISE EXCEPTION 'Approval already decided'; END IF;
  IF NEW.status='approved' AND NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P1002',MESSAGE='Approval expired'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['consumed_by_lease','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_by_lease','updated_at']) THEN RAISE EXCEPTION 'Decision immutable'; END IF;
 END IF;
 IF OLD.consumed_by_lease IS NOT NULL AND NEW.consumed_by_lease IS DISTINCT FROM OLD.consumed_by_lease THEN RAISE EXCEPTION 'Approval consumed'; END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER immutable_approval BEFORE UPDATE OR DELETE ON agent_approvals FOR EACH ROW EXECUTE FUNCTION eap_approval_guard();
-- All event/audit effects participate in the same transaction as the decision.
CREATE FUNCTION eap_approval_event(r uuid,p jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t uuid; seq bigint;
BEGIN
 UPDATE agent_runs SET event_sequence=event_sequence+1 WHERE id=r RETURNING tenant_id,event_sequence INTO t,seq;
 INSERT INTO agent_events(tenant_id,run_id,sequence,event_type,payload) VALUES(t,r,seq,'approval',p);
END $$;
CREATE FUNCTION eap_approval_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE action_name text; actor text; seq bigint; j agent_jobs;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO j FROM agent_jobs WHERE id=NEW.job_id;
  IF NEW.status<>'pending' OR NEW.requested_by_user_id IS DISTINCT FROM j.actor_user_id OR NEW.tenant_id<>j.tenant_id THEN RAISE EXCEPTION 'Invalid approval actor'; END IF;
  action_name='approval.requested'; actor=NEW.requested_by_user_id;
 ELSE
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  SELECT * INTO j FROM agent_jobs WHERE id=NEW.job_id FOR UPDATE;
  PERFORM 1 FROM agent_runs WHERE id=NEW.run_id FOR UPDATE;
  IF j.status<>'waiting_approval' OR j.active_approval_id<>NEW.id OR j.checkpoint_version<>NEW.checkpoint_version THEN RAISE EXCEPTION 'Approval/job mismatch'; END IF;
  action_name='approval.'||NEW.status; actor=NEW.decided_by_user_id;
  PERFORM eap_approval_event(NEW.run_id,jsonb_build_object('type','approval','approvalId',NEW.id,'status',NEW.status,'toolName',NEW.tool_name));
  IF NEW.status='approved' THEN
   UPDATE agent_jobs SET status='queued',available_at=clock_timestamp(),max_attempts=max_attempts+1 WHERE id=NEW.job_id;
   UPDATE agent_runs SET status='pending' WHERE id=NEW.run_id;
  ELSE
   UPDATE agent_jobs SET status=CASE WHEN NEW.status='cancelled' THEN 'cancelled' ELSE 'failed' END,
    finished_at=clock_timestamp(),cancel_requested_at=CASE WHEN NEW.status='cancelled' THEN clock_timestamp() ELSE cancel_requested_at END,
    last_error=jsonb_build_object('code','APPROVAL_'||upper(NEW.status)) WHERE id=NEW.job_id;
   UPDATE agent_runs SET status=CASE WHEN NEW.status='cancelled' THEN 'cancelled' ELSE 'failed' END,finished_at=clock_timestamp(),
    error=jsonb_build_object('code','APPROVAL_'||upper(NEW.status),'message','Approval did not permit execution'),event_sequence=event_sequence+1
    WHERE id=NEW.run_id RETURNING event_sequence INTO seq;
   INSERT INTO agent_events(tenant_id,run_id,sequence,event_type,payload) VALUES(NEW.tenant_id,NEW.run_id,seq,'error',jsonb_build_object('type','error','code','APPROVAL_'||upper(NEW.status),'message','Approval did not permit execution'));
   INSERT INTO agent_usage(run_id,tenant_id,provider,model,input_tokens,output_tokens,usage_source,estimated_cost_usd,price)
    SELECT id,tenant_id,observability->>'provider',observability->>'model',input_tokens,output_tokens,
    observability->>'usageSource',(observability->'cost'->>'usd')::numeric,observability->'cost'->'price'
    FROM agent_runs WHERE id=NEW.run_id AND observability IS NOT NULL ON CONFLICT(run_id) DO NOTHING;
  END IF;
 END IF;
 BEGIN
 INSERT INTO audit_logs(event_id,tenant_id,actor_user_id,action,resource_type,resource_id,decision,reason_code)
 VALUES(gen_random_uuid(),NEW.tenant_id,actor,action_name,'approval',NEW.id::text,CASE WHEN NEW.status IN ('pending','approved') THEN 'allow' ELSE 'deny' END,upper(NEW.status));
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='P1001',MESSAGE='Approval audit unavailable'; END;
 IF TG_OP='INSERT' THEN PERFORM eap_approval_event(NEW.run_id,jsonb_build_object('type','approval','approvalId',NEW.id,'status','waiting_approval','toolName',NEW.tool_name)); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_changed AFTER INSERT OR UPDATE ON agent_approvals FOR EACH ROW EXECUTE FUNCTION eap_approval_changed();
CREATE FUNCTION eap_expire_approvals() RETURNS TABLE(approval_id uuid,wait_seconds double precision) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE a agent_approvals; j agent_jobs;
BEGIN
 FOR a IN SELECT * FROM agent_approvals WHERE status='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 LOOP
  SELECT * INTO j FROM agent_jobs WHERE id=a.job_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE; END IF;
  PERFORM 1 FROM agent_runs WHERE id=a.run_id FOR UPDATE;
  SELECT ap.* INTO a FROM agent_approvals ap WHERE ap.id=a.id FOR UPDATE;
  IF a.status='pending' AND a.expires_at<=clock_timestamp() AND j.status='waiting_approval' THEN
   UPDATE agent_approvals SET status='expired',decided_at=clock_timestamp(),decision_reason='Deadline reached' WHERE id=a.id;
   approval_id=a.id; wait_seconds=extract(epoch FROM clock_timestamp()-a.requested_at); RETURN NEXT;
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION eap_cancel_waiting_approval(r uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j agent_jobs; actor text:=NULLIF(current_setting('eap.actor_id',true),'');t uuid:=NULLIF(current_setting('eap.tenant_id',true),'')::uuid;
BEGIN
 IF eap_role(t,actor) NOT IN ('owner','admin','member') OR eap_role(t,actor) IS NULL THEN RAISE EXCEPTION 'Cancellation forbidden'; END IF;
 SELECT * INTO j FROM agent_jobs WHERE run_id=r AND tenant_id=t FOR UPDATE;
 IF NOT FOUND OR j.status<>'waiting_approval' THEN RETURN false; END IF;
 PERFORM 1 FROM agent_runs WHERE id=r FOR UPDATE;
 UPDATE agent_approvals SET status='cancelled',decided_at=clock_timestamp(),decided_by_user_id=actor,decision_reason='Run cancelled' WHERE id=j.active_approval_id AND status='pending';
 RETURN FOUND;
END $$;
CREATE FUNCTION eap_pending_approval_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT count(*) FROM agent_approvals WHERE status='pending' $$;
DO $$ DECLARE s text:=current_schema(); t text; f text; BEGIN
 FOREACH t IN ARRAY ARRAY['agent_approvals','agent_checkpoints'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO eap_owner',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY maintenance ON %I TO eap_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY worker_access ON %I TO eap_worker USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY approval_read ON %I FOR SELECT TO eap_app USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_role(tenant_id,current_setting(''eap.actor_id'',true)) IN (''owner'',''admin''))',t);
 END LOOP;
 GRANT SELECT,INSERT ON agent_checkpoints TO eap_worker;
 GRANT SELECT,INSERT,UPDATE ON agent_approvals TO eap_worker;
 GRANT SELECT ON agent_checkpoints TO eap_app;
 GRANT SELECT,UPDATE ON agent_approvals TO eap_app;
 CREATE POLICY approval_decide ON agent_approvals FOR UPDATE TO eap_app USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'));
 FOREACH f IN ARRAY ARRAY['eap_approval_event(uuid,jsonb)','eap_approval_changed()','eap_expire_approvals()','eap_pending_approval_count()','eap_cancel_waiting_approval(uuid)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_temp',f,s);
  EXECUTE format('ALTER FUNCTION %s OWNER TO eap_owner',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
 GRANT EXECUTE ON FUNCTION eap_cancel_waiting_approval(uuid) TO eap_app,eap_worker;
 GRANT EXECUTE ON FUNCTION eap_expire_approvals(),eap_pending_approval_count() TO eap_worker;
END $$;
