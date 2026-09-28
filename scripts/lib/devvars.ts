import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEV_VARS_PATH = resolve(import.meta.dirname, '../../.dev.vars');

/** Разбор .dev.vars (формат dotenv: KEY=value, # комментарии, значения в кавычках). */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

export function readDevVars(path = DEV_VARS_PATH): Record<string, string> {
  if (!existsSync(path)) {
    console.error(`Нет файла ${path}. Скопируй .dev.vars.example в .dev.vars и заполни.`);
    process.exit(1);
  }
  return { ...parseDevVars(readFileSync(path, 'utf8')) };
}

/** Записать/обновить одну переменную в .dev.vars, сохранив остальное содержимое. */
export function setDevVar(key: string, value: string, path = DEV_VARS_PATH): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const re = new RegExp(`^${key}\\s*=.*$`, 'm');
  const line = `${key}=${value}`;
  writeFileSync(path, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`);
}

export function requireVars(vars: Record<string, string>, keys: string[]): void {
  const missing = keys.filter((k) => !vars[k] || /^<.*>$/.test(vars[k]!));
  if (missing.length) {
    console.error(`В .dev.vars не заполнены: ${missing.join(', ')}`);
    process.exit(1);
  }
}
