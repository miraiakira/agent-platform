-- Fleet-wide admission is serialized separately from tenant membership locks.
CREATE FUNCTION eap_admit_job(global_limit integer,tenant_limit integer,queue_limit integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t uuid:=NULLIF(current_setting('eap.tenant_id',true),'')::uuid;actor text:=current_setting('eap.actor_id',true);
BEGIN
 IF eap_role(t,actor) NOT IN ('owner','admin','member') OR eap_role(t,actor) IS NULL THEN RAISE EXCEPTION 'Admission forbidden';END IF;
 IF global_limit NOT BETWEEN 1 AND 4096 OR tenant_limit NOT BETWEEN 1 AND 64 OR queue_limit NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'Invalid admission limits';END IF;
 PERFORM pg_advisory_xact_lock(714014);
 IF (SELECT count(*) FROM agent_runs WHERE status IN ('pending','running','waiting_approval'))>=global_limit THEN RETURN 'GLOBAL_CAPACITY_LIMIT';END IF;
 IF (SELECT count(*) FROM agent_runs WHERE tenant_id=t AND status IN ('pending','running','waiting_approval'))>=tenant_limit THEN RETURN 'CONCURRENT_RUN_LIMIT';END IF;
 IF (SELECT count(*) FROM agent_jobs WHERE tenant_id=t AND status='queued')>=queue_limit THEN RETURN 'TENANT_QUEUE_LIMIT';END IF;
 RETURN 'ACCEPT';
END $$;
CREATE INDEX ON agent_jobs(tenant_id,status,started_at DESC);
CREATE OR REPLACE FUNCTION eap_claim_job(w text,tok uuid,seconds double precision) RETURNS SETOF agent_jobs LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j agent_jobs;
BEGIN
 IF length(w)=0 OR seconds<0.1 OR seconds>300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 -- Short global dispatch transaction enforces a fleet ceiling. Tenant ordering is
 -- least-recently-dispatched; priority applies within an eligible tenant.
 PERFORM pg_advisory_xact_lock(714015);
 IF (SELECT count(*) FROM agent_jobs WHERE status='running' AND lease_expires_at>clock_timestamp())>=64 THEN RETURN;END IF;
 WITH c AS (SELECT q.id FROM agent_jobs q WHERE q.status='queued' AND q.available_at<=clock_timestamp() AND q.cancel_requested_at IS NULL AND q.attempt<q.max_attempts AND q.actor_user_id IS NOT NULL
  AND (SELECT count(*) FROM agent_jobs r WHERE r.tenant_id=q.tenant_id AND r.status='running' AND r.lease_expires_at>clock_timestamp())<2
  ORDER BY COALESCE((SELECT max(d.started_at) FROM agent_jobs d WHERE d.tenant_id=q.tenant_id),'-infinity'::timestamptz),q.priority DESC,q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1)
 UPDATE agent_jobs SET status='running',worker_id=w,lease_token=tok,lease_expires_at=clock_timestamp()+seconds*interval '1 second',attempt=attempt+1,started_at=clock_timestamp()
 FROM c WHERE agent_jobs.id=c.id RETURNING agent_jobs.* INTO j;
 IF j.id IS NOT NULL THEN
  UPDATE agent_runs SET status='running',started_at=COALESCE(started_at,clock_timestamp()),heartbeat_at=clock_timestamp() WHERE id=j.run_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not pending';END IF;
  RETURN NEXT j;
 END IF;
END $$;
CREATE TABLE worker_heartbeats(worker_id text PRIMARY KEY CHECK(length(worker_id) BETWEEN 1 AND 160),seen_at timestamptz NOT NULL,capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 8));
ALTER TABLE worker_heartbeats OWNER TO eap_owner;
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON worker_heartbeats TO eap_owner USING(true) WITH CHECK(true);
CREATE FUNCTION eap_worker_snapshot(w text,slots integer) RETURNS TABLE(queued bigint,running bigint,oldest_seconds double precision,live_workers bigint) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
 IF slots NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'Invalid capacity';END IF;
 INSERT INTO worker_heartbeats VALUES(w,clock_timestamp(),slots) ON CONFLICT(worker_id) DO UPDATE SET seen_at=EXCLUDED.seen_at,capacity=EXCLUDED.capacity;
 DELETE FROM worker_heartbeats WHERE seen_at<clock_timestamp()-interval '7 days';
 RETURN QUERY SELECT (SELECT count(*) FROM agent_jobs WHERE status='queued'),(SELECT count(*) FROM agent_jobs WHERE status='running'),COALESCE((SELECT extract(epoch FROM clock_timestamp()-min(available_at))::double precision FROM agent_jobs WHERE status='queued'),0),(SELECT count(*) FROM worker_heartbeats WHERE seen_at>clock_timestamp()-interval '30 seconds');
END $$;
DO $$ DECLARE s text:=current_schema();f text;BEGIN
 FOREACH f IN ARRAY ARRAY['eap_admit_job(integer,integer,integer)','eap_claim_job(text,uuid,double precision)','eap_worker_snapshot(text,integer)'] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO eap_owner',f);EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_temp',f,s);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
 GRANT EXECUTE ON FUNCTION eap_admit_job(integer,integer,integer) TO eap_app;
 GRANT EXECUTE ON FUNCTION eap_claim_job(text,uuid,double precision),eap_worker_snapshot(text,integer) TO eap_worker;
END $$;
