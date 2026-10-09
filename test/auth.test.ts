import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, basic } from './helpers';

// This project runs the worker WITHOUT a USERS binding. The env-mode config
// must fail closed: the placeholder "user"/"password" credentials shipped in
// the default config must never make the server reachable.
describe('env config without USERS binding', () => {
	it('serves pre-auth routes', async () => {
		const res = await SELF.fetch(ORIGIN + '/robots.txt');
		expect(res.status).toBe(200);
	});

	it('refuses to serve the webdav root with a 500, not the placeholder creds', async () => {
		const res = await SELF.fetch(ORIGIN + '/dav/');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('USERS');
	});

	it('rejects even the default placeholder credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/dav/', {
			headers: { Authorization: basic('user', 'password') },
		});
		expect(res.status).toBe(500);
	});
});