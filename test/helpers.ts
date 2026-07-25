// Shared test rig. A human user must exist and be active before a narrow device
// credential can be issued, so every suite builds identities the same way.
import { Store } from '../src/server/store.ts';
import { buildApp } from '../src/server/app.ts';

export const PW = 'password123';

export interface Opts { token?: string; cookie?: string }
export type Req = (method: string, path: string, body?: unknown, opts?: Opts) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const jb = async (r: Response): Promise<any> => r.json();

export const cookieOf = (res: Response): string =>
  (res.headers.get('set-cookie') ?? '').match(/mediation_user=[^;]+/)?.[0] ?? '';

export function ctx(storeOpts: { sessionTtlMs?: number; claimIdleTtlMs?: number } = {}) {
  const store = new Store({ dbPath: ':memory:', ...storeOpts });
  const app = buildApp(store);
  const req: Req = (method, path, body, { token, cookie } = {}) =>
    Promise.resolve(app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  return { store, app, req };
}

/** First registration ever: active admin. Returns its session cookie. */
export async function bootstrap(req: Req, username = 'admin'): Promise<string> {
  await req('POST', '/api/users/register', { username, password: PW });
  return cookieOf(await req('POST', '/api/users/login', { username, password: PW }));
}

/** Register + admin-approve + log in a normal user. */
export async function activeUser(req: Req, adminCookie: string, username: string): Promise<{
  id: string; username: string; cookie: string;
}> {
  const user = (await jb(await req('POST', '/api/users/register', { username, password: PW }))).user;
  await req('PATCH', `/api/users/${user.id}`, { status: 'active' }, { cookie: adminCookie });
  const login = await req('POST', '/api/users/login', { username, password: PW });
  return { id: user.id, username: user.username, cookie: cookieOf(login) };
}

/** Narrow global device bearer; password is exchanged and never persisted. */
export async function pair(req: Req, cookie: string, agent: string, developer?: string): Promise<string> {
  void agent; void developer;
  const username = (await jb(await req('GET', '/api/users/me', undefined, { cookie }))).user.username;
  return (await jb(await req('POST', '/api/auth/device-login', { username, password: PW }))).token;
}
