-- Run only with the migration identity. Runtime identities must never own tables.
SELECT pg_advisory_xact_lock(714009);
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='eap_owner') THEN CREATE ROLE eap_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='eap_app') THEN CREATE ROLE eap_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='eap_worker') THEN CREATE ROLE eap_worker NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='eap_auth') THEN CREATE ROLE eap_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "session" (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 token text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON "session"("userId");
CREATE TABLE account (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "accountId" text NOT NULL, "providerId" text NOT NULL, "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON account("userId");
CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON verification(identifier);
CREATE TABLE "rateLimit" (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL);
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','quarantined')),
 created_by text REFERENCES "user"(id), created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO tenants(id,name,status) VALUES ('00000000-0000-0000-0000-000000000009','Day 1–8 quarantine','quarantined');
CREATE TABLE tenant_memberships (tenant_id uuid NOT NULL REFERENCES tenants(id), user_id text NOT NULL REFERENCES "user"(id),
 role text NOT NULL CHECK(role IN ('owner','admin','member','viewer')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id));
CREATE INDEX ON tenant_memberships(user_id);
CREATE TABLE tenant_tool_policies (tenant_id uuid NOT NULL REFERENCES tenants(id), tool_name text NOT NULL CHECK(tool_name ~ '^[a-z][a-z0-9_]{0,79}$'),
 enabled boolean NOT NULL DEFAULT false, allowed_roles text[] NOT NULL DEFAULT '{}',
 risk_level text NOT NULL CHECK(risk_level IN ('low','high')), requires_approval boolean NOT NULL DEFAULT true,
 policy_version integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,tool_name),
 CHECK(allowed_roles <@ ARRAY['owner','admin','member','viewer']::text[]));
CREATE TABLE audit_logs (event_id uuid PRIMARY KEY, tenant_id uuid, actor_user_id text,
 action text NOT NULL, resource_type text NOT NULL, resource_id text, decision text NOT NULL CHECK(decision IN ('allow','deny')),
 reason_code text NOT NULL, timestamp timestamptz NOT NULL DEFAULT now(), trace_id text);
CREATE INDEX ON audit_logs(tenant_id,timestamp DESC);
CREATE TABLE security_rate_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
-- Every business row carries its tenant; triggers derive children, composite FKs reject mismatched parents.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conversations','agent_runs','agent_jobs','messages','tool_executions','trace_spans','agent_events','agent_usage'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL DEFAULT COALESCE(NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid,''00000000-0000-0000-0000-000000000009''::uuid) REFERENCES tenants(id)',t);
  EXECUTE format('CREATE INDEX ON %I(tenant_id)',t);
 END LOOP;
END $$;
ALTER TABLE conversations ADD UNIQUE(tenant_id,id);
ALTER TABLE agent_runs ADD UNIQUE(tenant_id,id), ADD UNIQUE(tenant_id,id,conversation_id),
 ADD FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
 ADD COLUMN actor_user_id text REFERENCES "user"(id), ADD COLUMN authorization_context jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN policy_version integer NOT NULL DEFAULT 1;
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_request_key_key;
CREATE UNIQUE INDEX ON agent_runs(tenant_id,request_key);
ALTER TABLE agent_jobs ADD FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id),
 ADD COLUMN actor_user_id text REFERENCES "user"(id), ADD COLUMN authorization_context jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN policy_version integer NOT NULL DEFAULT 1;
ALTER TABLE messages ADD FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,run_id,conversation_id) REFERENCES agent_runs(tenant_id,id,conversation_id);
ALTER TABLE tool_executions ADD FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
ALTER TABLE trace_spans ADD FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
ALTER TABLE agent_events ADD FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
ALTER TABLE agent_usage ADD FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
CREATE FUNCTION eap_bind_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent uuid; actor text; auth jsonb; version integer;
BEGIN
 IF TG_TABLE_NAME='agent_runs' THEN
  SELECT tenant_id INTO parent FROM conversations WHERE id=NEW.conversation_id;
  NEW.actor_user_id := NULLIF(current_setting('eap.actor_id',true),'');
  NEW.authorization_context := jsonb_build_object('version',1,'tenant_id',parent,'actor_user_id',NEW.actor_user_id);
 ELSE
  IF TG_TABLE_NAME='messages' THEN
   IF NEW.run_id IS NULL THEN
    SELECT tenant_id INTO parent FROM conversations WHERE id=NEW.conversation_id;
   ELSE
    SELECT tenant_id INTO parent FROM agent_runs WHERE id=NEW.run_id;
   END IF;
  ELSE
   SELECT tenant_id,actor_user_id,authorization_context,policy_version INTO parent,actor,auth,version FROM agent_runs WHERE id=NEW.run_id;
  END IF;
 END IF;
 IF parent IS NULL THEN RAISE EXCEPTION 'Parent unavailable' USING ERRCODE='23503'; END IF;
 IF NEW.tenant_id <> parent THEN RAISE EXCEPTION 'Tenant mismatch' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME='agent_jobs' THEN NEW.actor_user_id:=actor; NEW.authorization_context:=auth; NEW.policy_version:=version; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_run BEFORE INSERT ON agent_runs FOR EACH ROW EXECUTE FUNCTION eap_bind_resource();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agent_jobs','messages','tool_executions','trace_spans','agent_events','agent_usage'] LOOP
 EXECUTE format('CREATE TRIGGER bind_resource BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION eap_bind_resource()',t);
 END LOOP;
END $$;
CREATE FUNCTION eap_member(t uuid,u text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM tenant_memberships m JOIN tenants n ON n.id=m.tenant_id
 WHERE m.tenant_id=t AND m.user_id=u AND m.status='active' AND n.status='active') $$;
CREATE FUNCTION eap_role(t uuid,u text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT m.role FROM tenant_memberships m JOIN tenants n ON n.id=m.tenant_id
 WHERE m.tenant_id=t AND m.user_id=u AND m.status='active' AND n.status='active' $$;
CREATE FUNCTION eap_bootstrap_owner(t uuid,u text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM tenants WHERE id=t AND created_by=u AND status='active')
 AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=t) $$;
-- Append-only audit: no runtime UPDATE/DELETE grants, even for admins.
CREATE FUNCTION eap_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit is append-only'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION eap_audit_guard();
-- Cross-tenant maintenance is exposed only through these narrow worker functions.
CREATE FUNCTION eap_claim_job(w text,tok uuid,seconds double precision) RETURNS SETOF agent_jobs LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j agent_jobs;
BEGIN
 IF length(w)=0 OR seconds<=0 THEN RAISE EXCEPTION 'Invalid lease'; END IF;
 WITH c AS (SELECT id FROM agent_jobs WHERE status='queued' AND available_at<=now() AND cancel_requested_at IS NULL
 AND attempt<max_attempts AND actor_user_id IS NOT NULL ORDER BY priority DESC,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE agent_jobs SET status='running',worker_id=w,lease_token=tok,lease_expires_at=now()+seconds*interval '1 second',
 attempt=attempt+1,started_at=now() FROM c WHERE agent_jobs.id=c.id RETURNING agent_jobs.* INTO j;
 IF j.id IS NOT NULL THEN
 UPDATE agent_runs SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now() WHERE id=j.run_id AND status='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'Run not pending'; END IF;
 RETURN NEXT j;
 END IF;
END $$;
CREATE FUNCTION eap_reap_jobs() RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j agent_jobs; seq bigint;
BEGIN
 FOR j IN SELECT * FROM agent_jobs WHERE status='running' AND lease_expires_at<now() FOR UPDATE SKIP LOCKED LOOP
 UPDATE agent_runs SET status='interrupted',finished_at=now(),event_sequence=event_sequence+1 WHERE id=j.run_id AND status='running' RETURNING event_sequence INTO seq;
 UPDATE tool_executions SET status='unknown' WHERE run_id=j.run_id AND status IN ('reserved','running');
 IF seq IS NOT NULL THEN INSERT INTO agent_events(run_id,tenant_id,sequence,event_type,payload)
 VALUES(j.run_id,j.tenant_id,seq,'error','{"type":"error","code":"LEASE_EXPIRED","message":"Worker interrupted; automatic replay disabled"}'); END IF;
 UPDATE agent_jobs SET status='blocked',finished_at=now(),last_error='{"code":"LEASE_EXPIRED"}' WHERE id=j.id;
 RETURN NEXT j.run_id;
 END LOOP;
END $$;
-- Security definer functions get a fixed schema path; never resolve attacker-controlled objects.
DO $$ DECLARE s text:=current_schema(); f text; t text; BEGIN
 EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO eap_owner',s);
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO eap_app,eap_worker,eap_auth',s);
 FOREACH f IN ARRAY ARRAY['eap_member(uuid,text)','eap_role(uuid,text)','eap_bootstrap_owner(uuid,text)','eap_claim_job(text,uuid,double precision)','eap_reap_jobs()'] LOOP
 EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp',f,s);
 EXECUTE format('ALTER FUNCTION %s OWNER TO eap_owner',f);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
 GRANT EXECUTE ON FUNCTION eap_member(uuid,text),eap_role(uuid,text),eap_bootstrap_owner(uuid,text) TO eap_app,eap_worker;
 GRANT EXECUTE ON FUNCTION eap_claim_job(text,uuid,double precision),eap_reap_jobs() TO eap_worker;
 FOREACH t IN ARRAY ARRAY['tenants','tenant_memberships','tenant_tool_policies','audit_logs','conversations','agent_runs','agent_jobs','messages','tool_executions','trace_spans','agent_events','agent_usage'] LOOP
 EXECUTE format('ALTER TABLE %I OWNER TO eap_owner',t);
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY maintenance ON %I TO eap_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON conversations,agent_runs,agent_jobs,messages,tool_executions,trace_spans,agent_events,agent_usage TO eap_app,eap_worker;
DO $$ BEGIN EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA %I TO eap_app,eap_worker,eap_owner',current_schema()); END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conversations','agent_runs','agent_jobs','messages','tool_executions','trace_spans','agent_events','agent_usage'] LOOP
 EXECUTE format('CREATE POLICY tenant_app ON %I TO eap_app USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_member(tenant_id,NULLIF(current_setting(''eap.actor_id'',true),''''))) WITH CHECK(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid AND eap_member(tenant_id,NULLIF(current_setting(''eap.actor_id'',true),'''')))',t);
 EXECUTE format('CREATE POLICY tenant_worker ON %I TO eap_worker USING(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''eap.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenants,tenant_memberships,tenant_tool_policies TO eap_app;
GRANT SELECT ON tenants,tenant_memberships,tenant_tool_policies TO eap_worker;
GRANT SELECT,INSERT ON audit_logs TO eap_app,eap_worker,eap_auth;
GRANT SELECT,INSERT,UPDATE ON security_rate_limits TO eap_app,eap_auth;
GRANT SELECT ON "user" TO eap_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON "user","session",account,verification,"rateLimit" TO eap_auth;
CREATE POLICY tenants_read ON tenants FOR SELECT TO eap_app,eap_worker USING(eap_member(id,current_setting('eap.actor_id',true)) OR created_by=current_setting('eap.actor_id',true));
CREATE POLICY tenants_create ON tenants FOR INSERT TO eap_app WITH CHECK(created_by=current_setting('eap.actor_id',true) AND status='active');
CREATE POLICY tenants_update ON tenants FOR UPDATE TO eap_app USING(eap_role(id,current_setting('eap.actor_id',true)) IN ('owner','admin'));
CREATE POLICY membership_read ON tenant_memberships FOR SELECT TO eap_app,eap_worker USING(user_id=current_setting('eap.actor_id',true) OR (tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(tenant_id,current_setting('eap.actor_id',true))));
CREATE POLICY membership_write ON tenant_memberships FOR ALL TO eap_app USING(eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'))
 WITH CHECK(eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin') OR (user_id=current_setting('eap.actor_id',true) AND role='owner' AND eap_bootstrap_owner(tenant_id,user_id)));
CREATE POLICY policy_read ON tenant_tool_policies FOR SELECT TO eap_app,eap_worker USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_member(tenant_id,current_setting('eap.actor_id',true)));
CREATE POLICY policy_write ON tenant_tool_policies FOR ALL TO eap_app USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'));
CREATE POLICY audit_read ON audit_logs FOR SELECT TO eap_app USING(tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid AND eap_role(tenant_id,current_setting('eap.actor_id',true)) IN ('owner','admin'));
CREATE POLICY audit_append ON audit_logs FOR INSERT TO eap_app,eap_worker WITH CHECK(actor_user_id=current_setting('eap.actor_id',true) AND tenant_id=NULLIF(current_setting('eap.tenant_id',true),'')::uuid);
CREATE POLICY audit_auth ON audit_logs FOR INSERT TO eap_auth WITH CHECK(tenant_id IS NULL AND action LIKE 'auth.%');
