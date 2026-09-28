import { describe, expect, it } from 'vitest';
import { consoleLogger, redact, silentLogger } from '../src/platform/log.ts';
import { TelegramMessenger } from '../src/platform/telegram.ts';

function tg(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const [status, body] = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

describe('TelegramMessenger', () => {
  it('sendMessage: HTML, без превью, клавиатура, тихий режим', async () => {
    const { fetch, calls } = tg([[200, { ok: true, result: { message_id: 7 } }]]);
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: silentLogger, dryRun: false });
    const r = await m.send(42, '<b>hi</b>', { keyboard: [[{ text: 'x', callback_data: 'y' }]], silent: true });
    expect(r).toEqual({ ok: true, messageId: 7 });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body).toEqual({
      chat_id: 42,
      text: '<b>hi</b>',
      parse_mode: 'HTML',
      disable_notification: true,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] },
    });
  });

  it('429 с коротким retry_after — ждём и повторяем', async () => {
    const { fetch, calls } = tg([
      [429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } }],
      [200, { ok: true, result: { message_id: 8 } }],
    ]);
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: silentLogger, dryRun: false });
    expect(await m.send(1, 'x')).toEqual({ ok: true, messageId: 8 });
    expect(calls).toHaveLength(2);
  });

  it('429 с длинным retry_after — отдаём наверх', async () => {
    const { fetch } = tg([[429, { ok: false, parameters: { retry_after: 30 } }]]);
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: silentLogger, dryRun: false });
    expect(await m.send(1, 'x')).toEqual({ ok: false, kind: 'retry_after', retryAfterSec: 30 });
  });

  it.each([
    [403, 'Forbidden: bot was blocked by the user', 'blocked'],
    [400, 'Bad Request: chat not found', 'blocked'],
    [400, "Bad Request: can't parse entities", 'bad_request'],
    [502, 'Bad Gateway', 'transient'],
  ])('HTTP %i «%s» → %s', async (status, description, kind) => {
    const { fetch } = tg([[status, { ok: false, description }]]);
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: silentLogger, dryRun: false });
    expect(await m.send(1, 'x')).toMatchObject({ ok: false, kind });
  });

  it('сетевая ошибка → transient, токен не утекает в описание', async () => {
    const fetch = (async () => {
      throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as typeof globalThis.fetch;
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: silentLogger, dryRun: false });
    const r = await m.send(1, 'x');
    expect(r).toMatchObject({ ok: false, kind: 'transient' });
    expect(JSON.stringify(r)).not.toContain('ABCDEFGHIJ');
  });

  it('длинный текст обрезается до лимита Telegram', async () => {
    const { fetch, calls } = tg([[200, { ok: true, result: { message_id: 1 } }]]);
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: silentLogger, dryRun: false });
    await m.send(1, 'я'.repeat(5000));
    expect(String(calls[0]!.body.text).length).toBeLessThanOrEqual(4096);
  });

  it('DRY_RUN — ничего не отправляет', async () => {
    const { fetch, calls } = tg([[200, { ok: true }]]);
    const logs: string[] = [];
    const m = new TelegramMessenger({ token: TOKEN, fetch, log: { ...silentLogger, info: (msg) => void logs.push(msg) }, dryRun: true });
    expect(await m.send(1, 'x')).toEqual({ ok: true, messageId: null });
    expect(calls).toHaveLength(0);
    expect(logs).toEqual(['DRY_RUN sendMessage']);
  });
});

describe('логи', () => {
  it('маскируют токены', () => {
    expect(redact(`bot${TOKEN}/getMe`)).toBe('bot***/getMe');
    expect(redact('token 0123456789abcdef0123456789abcdef ok')).toBe('token *** ok');
    expect(typeof consoleLogger.info).toBe('function');
  });
});
