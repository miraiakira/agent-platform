import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 // Better Auth/Kysely validates all schemas visible to its role. Serial fixture
 // lifetimes prevent one file dropping a schema while another introspects it.
 // Concurrent tenant, pool and quota behavior is tested inside the DB suites.
 test:{fileParallelism:false},resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}}});
