import { mkdir, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
// ac_time_value is the web refresh_token (browser localStorage); without it cookies cannot be renewed.
const refreshTokenSchema = z.string().regex(/^[0-9A-Za-z]{16,128}$/);
const credentialsSchema = z.object({ sessdata: z.string().min(1), bili_jct: z.string().min(1), dedeuserid: z.string().regex(/^\d+$/), buvid3: z.string(), ac_time_value: refreshTokenSchema.optional() });
export function parseCookie(cookie: string, refreshToken = '') {
  const entries: Record<string,string> = {};
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) entries[part.slice(0,separator).trim().toLowerCase()] = part.slice(separator+1).trim();
  }
  const token = refreshToken.trim() || entries.ac_time_value;
  return credentialsSchema.parse({ sessdata: entries.sessdata, bili_jct: entries.bili_jct, dedeuserid: entries.dedeuserid, buvid3: entries.buvid3 ?? '', ...(token ? { ac_time_value: token } : {}) });
}
export async function saveCookie(path: string, cookie: string, refreshToken = '') {
  const credentials = parseCookie(cookie,refreshToken);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 });
  await chmod(temporary,0o600);
  await rename(temporary,path);
  await chmod(path,0o600);
}
export async function clearCookie(path: string) { await rm(path,{ force: true }); }
