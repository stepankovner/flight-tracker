/** Структурированные логи (Workers Logs / stdout). Никогда не логируем токены и полные URL с ними. */
export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const SECRET_RE = /\d{6,}:[\w-]{30,}|[a-f0-9]{32}/gi;

export function redact(s: string): string {
  return s.replace(SECRET_RE, '***');
}

function emit(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ level, msg: redact(msg), ...(data ? JSON.parse(redact(JSON.stringify(data))) : {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  info: (m, d) => emit('info', m, d),
  warn: (m, d) => emit('warn', m, d),
  error: (m, d) => emit('error', m, d),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return redact(e.message);
  return redact(String(e));
}
