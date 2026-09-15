import type { FastifyInstance } from 'fastify';
import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '@burtplace/config';

/**
 * Notification fan-out. In-app rows are always written by the caller; this module adds optional channels:
 *   EMAIL  — SMTP via nodemailer when SMTP_HOST is configured (REQUIRES IT CONFIGURATION of the relay).
 *   TEAMS  — Microsoft Teams incoming webhook when TEAMS_WEBHOOK_URL is configured. Only the plain `text`
 *            payload of the incoming-webhook contract is used; richer card formats REQUIRE VENDOR CONFIRMATION.
 * Every attempt is recorded in `notifications` with its channel, sent_at or send_error, so delivery is auditable.
 * Unconfigured channels are skipped silently (no fabricated sends).
 */
export interface Notice { userId: string; type: string; title: string; body?: string | null; link?: string | null; payload?: unknown }

let transporter: Transporter | null | undefined;
function mailer(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const env = getEnv();
  if (!env.SMTP_HOST) return (transporter = null);
  transporter = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined });
  return transporter;
}
/** Test hook: reset the cached transporter (e.g. after env changes). */
export function resetChannels(): void { transporter = undefined; }

export function channelsConfigured(): { email: boolean; teams: boolean } {
  const env = getEnv();
  return { email: !!env.SMTP_HOST, teams: !!env.TEAMS_WEBHOOK_URL };
}

/** Send one notice through every configured external channel; never throws (errors are recorded). */
export async function fanOut(app: FastifyInstance, n: Notice): Promise<{ email: 'sent' | 'failed' | 'skipped'; teams: 'sent' | 'failed' | 'skipped' }> {
  const env = getEnv();
  const result = { email: 'skipped' as 'sent' | 'failed' | 'skipped', teams: 'skipped' as 'sent' | 'failed' | 'skipped' };
  const link = n.link ? `${env.WEB_PUBLIC_URL}${n.link}` : null;
  const user = await app.db.selectFrom('users').select(['email', 'display_name', 'is_active']).where('id', '=', n.userId).executeTakeFirst();
  const m = mailer();
  if (m && user?.email && user.is_active) {
    try {
      await m.sendMail({ from: env.SMTP_FROM, to: user.email, subject: `[${env.COMPANY_NAME}] ${n.title}`, text: `${n.title}\n\n${n.body ?? ''}${link ? `\n\n${link}` : ''}`, html: `<p><b>${n.title}</b></p><p>${(n.body ?? '').replace(/\n/g, '<br>')}</p>${link ? `<p><a href="${link}">Open in Burtplace Workforce</a></p>` : ''}` });
      await app.db.insertInto('notifications').values({ user_id: n.userId, channel: 'EMAIL', type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null, payload: n.payload === undefined ? null : JSON.stringify(n.payload), sent_at: new Date(), read_at: new Date() }).execute();
      result.email = 'sent';
    } catch (e) {
      await app.db.insertInto('notifications').values({ user_id: n.userId, channel: 'EMAIL', type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null, send_error: (e as Error).message.slice(0, 500), read_at: new Date() }).execute();
      app.log.warn({ err: e }, 'email notification failed');
      result.email = 'failed';
    }
  }
  if (env.TEAMS_WEBHOOK_URL && n.type.startsWith('approval.')) {
    try {
      const res = await fetch(env.TEAMS_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `**${n.title}**${user ? ` · ${user.display_name}` : ''}\n\n${n.body ?? ''}${link ? `\n\n${link}` : ''}` }) });
      if (!res.ok) throw new Error(`Teams webhook HTTP ${res.status}`);
      await app.db.insertInto('notifications').values({ user_id: n.userId, channel: 'TEAMS', type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null, sent_at: new Date(), read_at: new Date() }).execute();
      result.teams = 'sent';
    } catch (e) {
      await app.db.insertInto('notifications').values({ user_id: n.userId, channel: 'TEAMS', type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null, send_error: (e as Error).message.slice(0, 500), read_at: new Date() }).execute();
      app.log.warn({ err: e }, 'teams notification failed');
      result.teams = 'failed';
    }
  }
  return result;
}

/** Deliver pending in-app notices created inside DB transactions (workflow steps) to external channels. Idempotent: only rows without sent_at/send_error and not yet fanned out. */
export async function deliverPending(app: FastifyInstance, limit = 200): Promise<number> {
  const { email, teams } = channelsConfigured();
  if (!email && !teams) return 0;
  const rows = await app.db.selectFrom('notifications').selectAll().where('channel', '=', 'IN_APP').where('sent_at', 'is', null).where('send_error', 'is', null).orderBy('created_at').limit(limit).execute();
  let n = 0;
  for (const r of rows) {
    const out = await fanOut(app, { userId: r.user_id, type: r.type, title: r.title, body: r.body, link: r.link, payload: r.payload });
    // Mark the in-app row as fanned out (sent_at) regardless of external outcome; failures are on their own rows.
    await app.db.updateTable('notifications').set({ sent_at: new Date(), ...(out.email === 'failed' || out.teams === 'failed' ? { send_error: 'one or more channels failed (see channel rows)' } : {}) }).where('id', '=', r.id).execute();
    n++;
  }
  return n;
}
