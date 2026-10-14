import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, MockDrive, ORIGIN, installDriveMock } from './helpers';

const MEGA = 1024 * 1024;

let drive: MockDrive;

function seed(d: MockDrive): void {
	d.add({ id: 'folder-docs', name: 'docs', mimeType: FOLDER, parents: ['root'] });
	d.add({ id: 'file-a', name: 'a.txt', mimeType: 'text/plain', size: 123, parents: ['root'] });
	d.add({ id: 'file-dest', name: 'dest.txt', mimeType: 'text/plain', size: 456, parents: ['root'] });
	d.add({ id: 'file-hostile', name: 'x & y [#].txt', mimeType: 'text/plain', size: 100, parents: ['root'] });
	d.add({ id: 'file-b', name: 'b & c.txt', mimeType: 'text/plain', size: 999, parents: ['folder-docs'] });
	d.add({ id: 'folder-sub', name: 'sub&dir', mimeType: FOLDER, parents: ['folder-docs'] });
}

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

beforeEach(() => {
	drive = new MockDrive();
	seed(drive);
	installDriveMock(drive);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('auth', () => {
	it('requires credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/dav/');
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toMatch(/^Basic realm=/);
	});

	it('rejects a wrong password', async () => {
		const res = await request('/dav/', { headers: { Authorization: 'Basic ' + btoa('test:wrong') } });
		expect(res.status).toBe(401);
	});

	it('rejects malformed base64 without crashing', async () => {
		const res = await request('/dav/', { headers: { Authorization: 'Basic not-valid@#$' } });
		expect(res.status).toBe(401);
	});
});

describe('server metadata', () => {
	it('answers robots.txt and favicon unauthenticated', async () => {
		const robots = await SELF.fetch(ORIGIN + '/robots.txt');
		expect(robots.status).toBe(200);
		expect(await robots.text()).toContain('Disallow');

		const favicon = await SELF.fetch(ORIGIN + '/favicon.ico');
		expect(favicon.status).toBe(204);
	});

	it('advertises class 1 and 2 in OPTIONS', async () => {
		const res = await request('/dav/', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('DAV')).toBe('1, 2');
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).toContain('MOVE');
	});

	it('returns 404 for paths outside the base path', async () => {
		const res = await request('/other');
		expect(res.status).toBe(404);
	});

	it('rejects invalid percent-encoding with a 400, not a 500', async () => {
		const res = await request('/dav/%zz');
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Invalid path encoding');
	});

	it('returns 404 for a missing resource', async () => {
		const res = await request('/dav/missing.txt');
		expect(res.status).toBe(404);
	});
});

describe('PROPFIND', () => {
	it('lists children with encoded hrefs and numeric sizes (Depth 1)', async () => {
		const res = await request('/dav/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		expect(res.status).toBe(207);
		expect(res.headers.get('Content-Type')).toMatch(/xml/);
		const body = await res.text();

		expect(body).toContain('<D:href>/dav/</D:href>');
		expect(body).toContain('<D:href>/dav/docs/</D:href>');
		expect(body).toContain('<D:href>/dav/a.txt</D:href>');
		expect(body).toContain('<D:href>/dav/dest.txt</D:href>');
		expect(body).toContain('<D:href>/dav/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>123</D:getcontentlength>');
		expect(body).toContain('<D:getcontentlength>100</D:getcontentlength>');
		expect(body).toContain('<D:displayname>x &amp; y [#].txt</D:displayname>');
		expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
	});

	it('lists nested folder children (Depth 1)', async () => {
		const res = await request('/dav/docs/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/docs/sub%26dir/</D:href>');
		expect(body).toContain('<D:href>/dav/docs/b%20%26%20c.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>999</D:getcontentlength>');
	});

	it('only returns the requested resource at Depth 0 (and quota on root)', async () => {
		const res = await request('/dav/', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
		});
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/</D:href>');
		expect(body).not.toContain('/dav/docs/');
		expect(body).not.toContain('getcontentlength');
		expect(body).toContain('<D:quota-used-bytes>4096</D:quota-used-bytes>');
		expect(body).toContain('<D:quota-available-bytes>1073737728</D:quota-available-bytes>');
	});

	it('resolves a hostile file name through its encoded path', async () => {
		const res = await request('/dav/x%20%26%20y%20%5B%23%5D.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>100</D:getcontentlength>');
	});
});

describe('PROPPATCH', () => {
	it('answers with a 207 multistatus', async () => {
		const res = await request('/dav/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml; charset=utf-8' },
			body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"/>',
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/a.txt</D:href>');
		expect(body).toContain('<D:status>HTTP/1.1 200 OK</D:status>');
	});
});

describe('MOVE / COPY overwrite semantics', () => {
	it('COPY to a new destination returns 201', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/cp-new.txt' },
		});
		expect(res.status).toBe(201);
		expect(drive.findById('file-a')).toBeDefined();
		expect(drive.children('root').some((f) => f.name === 'cp-new.txt')).toBe(true);
	});

	it('COPY with Overwrite: F onto an existing target returns 412', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
		expect(drive.findById('file-dest')).toBeDefined();
	});

	it('COPY onto an existing target overwrites and returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/dest.txt' },
		});
		expect(res.status).toBe(204);
		// the old destination file was removed and re-created by the copy
		expect(drive.findById('file-dest')).toBeUndefined();
		const dest = drive.children('root').find((f) => f.name === 'dest.txt');
		expect(dest).toBeDefined();
		expect(dest!.id).not.toBe('file-dest');
	});

	it('COPY onto itself returns 403', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/a.txt' },
		});
		expect(res.status).toBe(403);
	});

	it('MOVE onto itself returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/a.txt' },
		});
		expect(res.status).toBe(204);
		expect(drive.findById('file-a')).toBeDefined();
	});

	it('MOVE to a new destination returns 201 with a Location header', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/mv-new.txt' },
		});
		expect(res.status).toBe(201);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/dav/mv-new.txt');
		expect(drive.findById('file-a')?.name).toBe('mv-new.txt');
		expect(drive.children('root').some((f) => f.name === 'a.txt')).toBe(false);
	});

	it('MOVE with Overwrite: F onto an existing target returns 412', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
		expect(drive.findById('file-dest')).toBeDefined();
		expect(drive.findById('file-a')).toBeDefined();
	});

	it('rejects MOVE/COPY without a Destination header', async () => {
		const move = await request('/dav/a.txt', { method: 'MOVE' });
		expect(move.status).toBe(403);
		const copy = await request('/dav/a.txt', { method: 'COPY' });
		expect(copy.status).toBe(403);
	});

	it('rejects MOVE/COPY of the collection root', async () => {
		const move = await request('/dav/', { method: 'MOVE', headers: { Destination: ORIGIN + '/dav/x/' } });
		expect(move.status).toBe(403);
		const copy = await request('/dav/', { method: 'COPY', headers: { Destination: ORIGIN + '/dav/x/' } });
		expect(copy.status).toBe(403);
	});
it('MOVE with Overwrite: T replaces the target and returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/dest.txt' },
		});
		expect(res.status).toBe(204);
		expect(drive.findById('file-dest')).toBeUndefined();
		expect(drive.findById('file-a')?.name).toBe('dest.txt');
	});
});

describe('PUT and MKCOL', () => {
	it('PUT to a new small file returns 201', async () => {
		const res = await request('/dav/put-new.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'hello world',
		});
		expect(res.status).toBe(201);
		expect(drive.children('root').some((f) => f.name === 'put-new.txt')).toBe(true);
	});

	it('PUT over an existing file returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'hello world',
		});
		expect(res.status).toBe(204);
	});

	it('PUT larger than 5 MiB uses the resumable session and returns 201', async () => {
		const res = await request('/dav/big.dat', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: 'x'.repeat(6 * MEGA),
		});
		expect(res.status).toBe(201);
	});

	it('MKCOL on an existing resource returns 405', async () => {
		const res = await request('/dav/a.txt', { method: 'MKCOL' });
		expect(res.status).toBe(405);
	});

	it('MKCOL creates a folder and returns 201', async () => {
		const res = await request('/dav/new-folder', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		const created = drive.children('root').find((f) => f.name === 'new-folder');
		expect(created?.mimeType).toBe(FOLDER);
	});
});

describe('HEAD and folder redirects', () => {
	it('HEAD reports the file size', async () => {
		const res = await request('/dav/a.txt', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe('123');
		expect(res.headers.get('Content-Type')).toBe('text/plain');
	});

	it('redirects a folder URL to the trailing-slash variant', async () => {
		const res = await request('/dav/docs', { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/dav/docs/');
	});
});