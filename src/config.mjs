export function config() {
  const local = (process.env.APP_STAGE ?? 'local') === 'local';
  const secret = process.env.APP_JWT_SECRET || (local ? Buffer.from('portal-local-development-secret-change-before-deploy-2026').toString('base64') : '');
  if (!secret) throw new Error('APP_JWT_SECRET is required outside local development');
  return {
    local, secret,
    collectMetrics: Math.random() < Math.max(0,Math.min(1,Number(process.env.PORTAL_DYNAMODB_METRICS_SAMPLE_RATE||0))),
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.APP_DYNAMODB_ENDPOINT || (local ? 'http://localhost:8000' : undefined),
    prefix: process.env.APP_DYNAMODB_TABLE_PREFIX || '',
    expiration: Number(process.env.APP_JWT_EXPIRATION_MILLIS || 86400000),
    bootstrapEmail: (process.env.PORTAL_BOOTSTRAP_OWNER_EMAIL || '').trim().toLowerCase(),
  };
}
