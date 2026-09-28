import { BOT } from '../config.ts';
import { escapeHtml } from '../core/format.ts';
import type { Services } from '../services.ts';

/**
 * Системное сообщение админу (ADMIN_USERNAME) с анти-флудом: одинаковый `key` — не чаще раза в cooldown.
 * Админ должен хотя бы раз нажать /start, иначе пишем только в лог.
 */
export async function notifyAdmin(svc: Services, key: string, text: string, cooldownMin: number = BOT.ADMIN_ALERT_COOLDOWN_MIN): Promise<boolean> {
  const { cfg, repo, log } = svc;
  const now = svc.now();
  log.warn('admin alert', { key, text });
  if (!cfg.adminUsername) return false;
  try {
    const kvKey = `admin_alert:${key}`;
    const kv = await repo.getKv([kvKey]);
    const last = kv.get(kvKey);
    if (last && now.getTime() - Date.parse(last) < cooldownMin * 60_000) return false;
    const admin = await repo.getUserByUsername(cfg.adminUsername);
    if (!admin || admin.isBlocked) return false;
    const res = await svc.messenger.send(admin.chatId, `🛠 <b>FareWatch</b>\n${escapeHtml(text)}`);
    await repo.setKv(kvKey, now.toISOString(), now.toISOString());
    return res.ok;
  } catch (e) {
    log.error('admin alert failed', { key, error: String(e) });
    return false;
  }
}
