import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { getEnv, type Env } from '@burtplace/config';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import auditPlugin from './plugins/audit.js';
import { registerErrorHandler } from './plugins/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { employeeRoutes } from './modules/employees/routes.js';
import { organizationRoutes } from './modules/organization/routes.js';
import { deviceRoutes } from './modules/devices/routes.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { shiftRoutes } from './modules/shifts/routes.js';
import { timesheetRoutes } from './modules/timesheets/routes.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { overtimeRoutes } from './modules/overtime/routes.js';
import { payrollRoutes } from './modules/payroll/routes.js';
import { workflowRoutes } from './modules/workflows/routes.js';
import { dashboardRoutes } from './modules/dashboards/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { integrationRoutes } from './modules/integrations/routes.js';
import { migrationRoutes } from './modules/migration/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { letterRoutes } from './modules/letters/routes.js';
import { peopleRoutes } from './modules/people/routes.js';
import { hrRequestRoutes } from './modules/hr-requests/routes.js';
import { compensationRoutes } from './modules/compensation/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { commandCenterRoutes } from './modules/employees/command-center.js';
import { JobQueues } from './jobs/queues.js';

export interface BuildAppOptions {
  env?: Env;
  databaseUrl?: string;
  logger?: boolean | object;
  /** When false, no Redis connection is made (tests). Jobs are executed inline. */
  enableQueues?: boolean;
}

export type App = FastifyInstance;

export async function buildApp(opts: BuildAppOptions = {}): Promise<App> {
  const env = opts.env ?? getEnv();
  const app = Fastify({
    logger: opts.logger ?? (env.NODE_ENV === 'development' ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty', options: { colorize: true } } } : { level: env.LOG_LEVEL }),
    requestIdHeader: 'x-request-id',
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true, allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key', 'X-Request-Id'] });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', allowList: (req) => !!req.headers['x-api-key'] });
  await app.register(sensible);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Burtplace Workforce API', version: '0.1.0', description: 'HR, Attendance, Timesheet & Payroll platform for Burtplace General Contracting.' },
      servers: [{ url: env.API_PUBLIC_URL }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      security: [{ bearerAuth: [] }, { apiKey: [] }],
      tags: [
        { name: 'auth' }, { name: 'employees' }, { name: 'organization' }, { name: 'devices' }, { name: 'attendance' }, { name: 'shifts' }, { name: 'timesheets' },
        { name: 'leave' }, { name: 'overtime' }, { name: 'payroll' }, { name: 'workflows' }, { name: 'dashboards' }, { name: 'reports' }, { name: 'search' }, { name: 'audit' }, { name: 'integrations' },
        { name: 'hr-requests' }, { name: 'jobs' }, { name: 'compensation' }, { name: 'letters' }, { name: 'people' }, { name: 'analytics' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(dbPlugin, { connectionString: opts.databaseUrl ?? env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  await app.register(auditPlugin);
  await app.register(authPlugin, { env });

  const queues = new JobQueues({ redisUrl: env.REDIS_URL, enabled: opts.enableQueues ?? env.NODE_ENV !== 'test', app });
  app.decorate('queues', queues);
  app.addHook('onClose', async () => { await queues.close(); });

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok', time: new Date().toISOString() }));
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    try { await app.db.selectFrom('roles').select('id').limit(1).execute(); return { status: 'ready' }; }
    catch { return reply.status(503).send({ status: 'db-unavailable' }); }
  });

  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth', env });
    await api.register(employeeRoutes, { prefix: '/employees' });
    await api.register(commandCenterRoutes, { prefix: '/employees' });
    await api.register(organizationRoutes, { prefix: '/org' });
    await api.register(deviceRoutes, { prefix: '/devices' });
    await api.register(attendanceRoutes, { prefix: '/attendance' });
    await api.register(shiftRoutes, { prefix: '/shifts' });
    await api.register(timesheetRoutes, { prefix: '/timesheets' });
    await api.register(leaveRoutes, { prefix: '/leave' });
    await api.register(overtimeRoutes, { prefix: '/overtime' });
    await api.register(payrollRoutes, { prefix: '/payroll' });
    await api.register(workflowRoutes, { prefix: '/workflows' });
    await api.register(dashboardRoutes, { prefix: '/dashboards' });
    await api.register(reportRoutes, { prefix: '/reports' });
    await api.register(searchRoutes, { prefix: '/search' });
    await api.register(auditRoutes, { prefix: '/audit' });
    await api.register(integrationRoutes, { prefix: '/integrations' });
    await api.register(migrationRoutes, { prefix: '/migration' });
    await api.register(hrRequestRoutes, { prefix: '/hr-requests' });
    await api.register(jobRoutes, { prefix: '/jobs' });
    await api.register(compensationRoutes, { prefix: '/compensation' });
    await api.register(letterRoutes, { prefix: '/letters' });
    await api.register(peopleRoutes, { prefix: '/people' });
    await api.register(analyticsRoutes, { prefix: '/analytics' });
  }, { prefix: '/api/v1' });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { queues: JobQueues }
}
