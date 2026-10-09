import { vi } from 'vitest';

export const ORIGIN = 'https://example.com';
export const FOLDER = 'application/vnd.google-apps.folder';

export const basic = (username: string, password: string): string =>
	'Basic ' + btoa(`${username}:${password}`);

export const AUTH = { Authorization: basic('test', 'pass') };

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: number;
	parents: string[];
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const pickFields = (f: DriveFile): Record<string, unknown> => ({
	id: f.id,
	name: f.name,
	mimeType: f.mimeType,
	size: f.size,
	modifiedTime: '2024-01-01T00:00:00.000Z',
	parents: f.parents,
});

async function bodyText(input: FetchInput, init?: FetchInit): Promise<string> {
	const req = input instanceof Request ? input : null;
	if (req && req.body) {
		try {
			const text = await req.clone().text();
			// Drain the original too so nothing is left unconsumed.
			await new Response(req.body).arrayBuffer().catch(() => {});
			return text;
		} catch {
			return '';
		}
	}
	const body = init?.body;
	if (typeof body === 'string') return body;
	if (body) {
		try {
			return await new Response(body as unknown as BodyInit).text();
		} catch {
			return '';
		}
	}
	return '';
}

async function bodyJson(input: FetchInput, init?: FetchInit): Promise<{ name?: string; mimeType?: string; parents?: string[] }> {
	const text = await bodyText(input, init);
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function multipartMeta(text: string, boundary: string): { name?: string; mimeType?: string; parents?: string[] } {
	for (const part of text.split('--' + boundary)) {
		const sep = part.search(/\r?\n\r?\n/);
		if (sep === -1) continue;
		const head = part.slice(0, sep);
		const content = part.slice(sep).replace(/^\r?\n\r?\n/, '');
		if (head.includes('application/json')) {
			try {
				return JSON.parse(content.trim());
			} catch {
				return {};
			}
		}
	}
	return {};
}

// In-memory stand-in for the Google Drive API. Only the endpoints the worker
// actually calls are implemented: token exchange, metadata/list queries,
// create/rename/move/delete, resumable session creation and media uploads.
export class MockDrive {
	files: DriveFile[] = [];

	add(f: DriveFile): DriveFile {
		this.files.push(f);
		return f;
	}

	remove(id: string): void {
		this.files = this.files.filter((f) => f.id !== id);
	}

	findById(id: string): DriveFile | undefined {
		return this.files.find((f) => f.id === id);
	}

	children(parentId: string): DriveFile[] {
		return this.files.filter((f) => f.parents.includes(parentId));
	}

	private parentFromQuery(q: string): string | null {
		const m = q.match(/^'([^']+)' in parents/);
		return m ? m[1] : null;
	}

	private nameFromQuery(q: string): string | null {
		const m = q.match(/name = '((?:\\.|[^'])*)'/);
		return m ? m[1].replace(/\\(.)/g, '$1') : null;
	}

	async handle(input: FetchInput, init?: FetchInit): Promise<Response> {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const { pathname } = url;
		const req = input instanceof Request ? input : null;
		const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();

		if (url.host === 'www.googleapis.com' && pathname === '/oauth2/v4/token') {
			return json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600 });
		}

		if (url.host === 'www.googleapis.com' && pathname === '/drive/v3/about') {
			return json({ storageQuota: { limit: 1073741824, usage: 4096 } });
		}

		// Chunked PUT bodies for an active resumable session.
		if (url.host === 'example.com' && pathname.startsWith('/resumable/')) {
			await bodyText(input, init);
			return new Response(null, { status: 200 });
		}

		if (url.host === 'www.googleapis.com' && pathname.startsWith('/upload/drive/v3/files')) {
			const uploadType = url.searchParams.get('uploadType');
			if (uploadType === 'resumable') {
				await bodyText(input, init);
				// Session creation returns the upload URL in `Location`.
				return json({ id: 'session-file' }, 200, { Location: 'https://example.com/resumable/mock-session' });
			}
			// Multipart (create) reports success; register the file so the
			// listing reflects the write. Media (overwrite) only drains.
			const text = await bodyText(input, init);
			if (uploadType === 'multipart') {
				const meta = multipartMeta(text, '-------webdav_boundary') || { name: 'uploaded' };
				this.add({
					id: crypto.randomUUID(),
					name: meta.name ?? 'uploaded',
					mimeType: meta.mimeType ?? 'application/octet-stream',
					parents: ['root'],
				});
			}
			return json({ id: 'uploaded' });
		}

		const copyMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
		if (url.host === 'www.googleapis.com' && copyMatch && method === 'POST') {
			const src = this.findById(copyMatch[1]);
			const meta = await bodyJson(input, init);
			const created = this.add({
				id: crypto.randomUUID(),
				name: meta.name ?? src?.name ?? 'copy',
				mimeType: src?.mimeType ?? 'application/octet-stream',
				parents: meta.parents ?? src?.parents ?? ['root'],
			});
			return json(pickFields(created));
		}

		if (url.host === 'www.googleapis.com' && pathname === '/drive/v3/files') {
			if (method === 'GET') {
				const q = url.searchParams.get('q') || '';
				const parentId = this.parentFromQuery(q);
				if (parentId === null) return json({ files: [] });
				const name = this.nameFromQuery(q);
				let list = this.children(parentId);
				if (name !== null) list = list.filter((f) => f.name === name);
				return json({ files: list.map(pickFields) });
			}
			if (method === 'POST') {
				const meta = await bodyJson(input, init);
				const created = this.add({
					id: crypto.randomUUID(),
					name: meta.name ?? 'untitled',
					mimeType: meta.mimeType ?? 'application/octet-stream',
					parents: meta.parents ?? ['root'],
				});
				return json(pickFields(created));
			}
		}

		const idMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
		if (url.host === 'www.googleapis.com' && idMatch) {
			const id = idMatch[1];
			if (method === 'DELETE') {
				this.remove(id);
				return new Response(null, { status: 204 });
			}
			if (method === 'PATCH') {
				const file = this.findById(id);
				const meta = await bodyJson(input, init);
				if (file) {
					if (meta.name) file.name = meta.name;
					const removeParents = url.searchParams.get('removeParents');
					const addParents = url.searchParams.get('addParents');
					if (removeParents) file.parents = file.parents.filter((p) => p !== removeParents);
					if (addParents && file.parents.includes(addParents)) {
						// no-op
					} else if (addParents) {
						file.parents.push(addParents);
					}
				}
				return json(pickFields(file ?? { id, name: 'file', mimeType: 'application/octet-stream', parents: ['root'] }));
			}
		}

		return json({ error: { message: `unhandled ${method} ${pathname}` } }, 501);
	}
}

export function installDriveMock(drive: MockDrive): void {
	vi.stubGlobal(
		'fetch',
		(input: FetchInput, init?: FetchInit): Promise<Response> => drive.handle(input, init)
	);
}