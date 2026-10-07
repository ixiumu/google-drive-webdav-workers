var config: AppConfig = {
    client_id: '202264815644.apps.googleusercontent.com', // Google API Client ID
    client_secret: 'X4Z3ca8xfWDb1Voo-F9a7ZxJ', // Google API Client Secret
    refresh_token: '', // Google Drive API Refresh Token

    path: '/dav/',
    name: 'My Cloud Drive', // Display name for the web interface
    copyright: '@ixiumu', // Copyright text displayed in the footer
    copyright_link: 'https://github.com/ixiumu/google-drive-webdav-workers', // URL link for the footer

    users: {
        'user': 'password' // Global Authentication credentials (username: password)
    },

    env: false,
    working_dir: '/', // Root directory path for the drive mapping
    cache: {
        meta: {
            '/': { data: { id: 'root', mimeType: 'application/vnd.google-apps.folder', size: 0, modifiedTime: null }, expire: Infinity }
        },
        putUrl: {},
        config: {}
    }
};

if (typeof CONFIG !== 'undefined') Object.assign(config, CONFIG);

const pathJoin = (...args: string[]): string => args.join('/').replace(/\\/g, '/').replace(/(?<!^)\/+/g, '/').replace(/\/\//g, '/');
const encodeQueryString = (data: Record<string, string>): string => Object.keys(data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&');
const trimString = (string: string, char?: string): string => char ? string.replace(new RegExp('^\\' + char + '+|\\' + char + '+$', 'g'), '') : string.replace(/^\s+|\s+$/g, '');
const formatSize = (n: number | string): string => {
    let num = typeof n === 'string' ? parseFloat(n) : Math.round(n);
    if (num === 0 || isNaN(num)) return '';
    if (num < 1024) return num + 'B'; if (num < 1024 * 1024) return Math.round(num / 1024) + 'K';
    return parseFloat((num / 1024 / 1024).toFixed(1)) + 'M';
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const escapeXml = (value: unknown): string =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Percent-encode each path segment individually so hrefs stay valid for names
// containing spaces, "&", "#" or non-ASCII characters.
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// Collections are addressed with a trailing slash. Strip it so the final
// segment is the resource name and not an empty string.
const splitPath = (path: string): { name: string; parent: string } => {
    const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
    const name = parts.pop()!;
    return { name, parent: parts.join('/') };
};

// Drive query values are single-quoted; a literal backslash or quote inside
// the value has to be escaped with a backslash.
const escapeQuery = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const getUrl = (url: string): { rpath: string; fpath: string } => {
    const rpath = decodeURIComponent(new URL(url, 'http://localhost').pathname);
    let fpath_relative = rpath;
    const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
    if (basePath !== '/' && fpath_relative.startsWith(basePath)) {
        fpath_relative = '/' + fpath_relative.substring(basePath.length);
    }
    return {
        rpath,
        fpath: pathJoin(config.working_dir, fpath_relative)
    };
};

// Constant-time string comparison. `crypto.subtle.timingSafeEqual` throws when
// the buffers differ in length, and returning early would leak the length of
// the stored secret through timing, so compare a value against itself instead.
function timingSafeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    return left.byteLength === right.byteLength
        ? crypto.subtle.timingSafeEqual(left, right)
        : !crypto.subtle.timingSafeEqual(left, left);
}

// Carry an upstream failure's HTTP status through to the client instead of
// collapsing every error into a 500.
function errorStatus(e: unknown): number {
    const status = (e as any)?.status;
    return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

function isValidUser(users: Record<string, string>, creds: { user: string; pass: string }): boolean {
    if (!Object.prototype.hasOwnProperty.call(users, creds.user)) return false;
    return timingSafeEqual(String(users[creds.user]), creds.pass);
}

function basicAuthentication(request: Request): { user: string; pass: string } | null {
    const Authorization = request.headers.get('Authorization');
    if (!Authorization) return null;
    const [scheme, encoded] = Authorization.split(' ');
    if (!encoded || scheme !== 'Basic') return null;
    const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(buffer).normalize();
    const index = decoded.indexOf(':');
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;
    return { user: decoded.substring(0, index), pass: decoded.substring(index + 1) };
}

class KVCache {
    env: Env;
    ctx: ExecutionContext;

    constructor(env: Env, ctx: ExecutionContext) {
        this.env = env;
        this.ctx = ctx;
    }

    async get(k: string, ns: string): Promise<any> {
        const now = Date.now();
        if (config.cache[ns] && config.cache[ns]![k]) {
            if (config.cache[ns]![k].expire > now) {
                return config.cache[ns]![k].data;
            }
        }
        if (this.env && this.env.KV) {
            const v = await this.env.KV.get(ns + '.' + k, { type: 'json' });
            if (v) {
                if (!config.cache[ns]) config.cache[ns] = {};
                config.cache[ns]![k] = { data: v, expire: now + 300000 };
                return v;
            }
        }
        return null;
    }

    async put(k: string, v: any, ns: string, customTtl?: number): Promise<void> {
        if (v) {
            if (!config.cache[ns]) config.cache[ns] = {};
            const ttl = customTtl || 300000;
            config.cache[ns]![k] = { data: v, expire: Date.now() + ttl };
            if (this.env && this.env.KV && this.ctx) {
                const kvPromise = this.env.KV.put(ns + '.' + k, JSON.stringify(v), { expirationTtl: Math.max(60, Math.floor(ttl / 1000)) });
                if (ns === 'tus_session') {
                    await kvPromise;
                } else {
                    this.ctx.waitUntil(kvPromise);
                }
            }
        }
    }

    async delete(k: string, ns: string): Promise<void> {
        if (ns === 'meta' && !k.endsWith('/')) k += '/';
        if (ns === 'meta' && k === '/') return;
        if (config.cache[ns] && config.cache[ns]![k]) {
            delete config.cache[ns]![k];
        }
        if (this.env && this.env.KV && this.ctx) {
            this.ctx.waitUntil(this.env.KV.delete(ns + '.' + k));
        }
    }

    // Drops the path -> id mapping for the written entry, the parent's own
    // mapping, and the parent's child listing. The last one is what PROPFIND
    // and GET read, so skipping it on an overwrite left stale entries in the
    // directory listing for up to five minutes.
    async invalidateFileAndParent(fpath: string, parentId?: string | null): Promise<void> {
        const { parent } = splitPath(fpath);
        await this.delete(fpath, 'meta');
        if (parent !== fpath) await this.delete(parent, 'meta');
        if (parentId) await this.delete(parentId, 'objects');
    }
}

class StatusError extends Error {
    status: number;
    code?: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

// The OAuth access token is deliberately kept out of `config.cache`, which is
// persisted to KV: a bearer token does not belong on durable shared storage.
let tokenCache: { access_token: string; expires: number } | null = null;

class GDrive {
    cache: KVCache;
    static fetchingTokenPromise: Promise<string> | null = null;

    constructor(env: Env, ctx: ExecutionContext<unknown>) {
        this.cache = new KVCache(env, ctx);
    }

    async OPTIONS(request: Request): Promise<Response> {
        let allowed_methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'MKCOL', 'DELETE', 'MOVE', 'COPY'].join(',');
        return new Response(null, { status: 200, headers: { 'Allow': allowed_methods, 'DAV': '1, 2, 3', 'MS-Author-Via': 'DAV', 'Accept-Ranges': 'bytes' } });
    }

    async PROPFIND(request: Request): Promise<Response> {
        let { rpath, fpath } = getUrl(request.url);
        const metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });

        // A missing Depth header means "infinity" (RFC 4918). Serving the
        // immediate children instead keeps a single request useful for clients
        // that never send the header.
        const depth = request.headers.get('Depth');
        const isFolder = metadata.mimeType === FOLDER_MIME;

        const self: Partial<DriveFile> = {
            name: '',
            dir: isFolder,
            lastmodified: metadata.modifiedTime ? new Date(metadata.modifiedTime).toUTCString() : new Date().toUTCString(),
            size: metadata.size,
            type: metadata.mimeType,
            etag: (metadata.id || 'root') + '-' + (metadata.modifiedTime || ''),
            quota: isFolder && depth === '0' && fpath === '/' ? await this.getQuota() : null
        };

        let entries: Partial<DriveFile>[] = [self];
        if (isFolder && depth !== '0') {
            const objects = await this.getObjects(metadata.id);
            entries = entries.concat(objects.map(object => ({
                name: object.name,
                dir: object.mimeType === FOLDER_MIME,
                lastmodified: new Date(object.modifiedTime).toUTCString(),
                size: object.size ? object.size : 0,
                type: object.mimeType,
                etag: object.id + '-' + (object.modifiedTime || '')
            })));
        }

        return new Response(arrayToXml(rpath, entries), { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    }

    async MKCOL(request: Request): Promise<Response> {
        let { rpath, fpath } = getUrl(request.url);

        let metadata = await this.getMetadata(fpath);
        if (metadata) return new Response('<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception><D:message>The resource you tried to create already exists</D:message></D:error>', { status: 405 });

        const { name, parent } = splitPath(fpath);
        const parentMetadata = await this.ensureDir(parent);
        if (!parentMetadata) return new Response(null, { status: 404 });

        let response = await fetch(new Request('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
            body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentMetadata.id] }),
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) }
        }));

        if (response.ok) {
            await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
            return new Response(null, { status: 201 });
        }
        return new Response(await response.text(), { status: response.status });
    }

    async GET(request: Request): Promise<Response> {
        let { rpath, fpath } = getUrl(request.url);
        let url = new URL(request.url);
        let response: Response;
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            try {
                if (metadata.mimeType === FOLDER_MIME) {
                    // The listing below is built from relative links, so a
                    // collection URL without a trailing slash would resolve every
                    // child link against the wrong parent directory.
                    if (!url.pathname.endsWith('/')) {
                        const redirectUrl = new URL(request.url);
                        redirectUrl.pathname += '/';
                        return Response.redirect(redirectUrl.toString(), 301);
                    }
                    const objects = await this.getObjects(metadata.id);
                    let files: Partial<DriveFile>[] = [];
                    for (let i = 0; i < objects.length; i++) {
                        let object = objects[i];
                        files.push({ name: trimString(object.name, '/'), dir: object.mimeType === FOLDER_MIME, lastmodified: new Date(object.modifiedTime).toISOString().split('T')[0], size: object.size ? object.size : 0, iconLink: object.iconLink });
                    }
                    return new Response(arrayToHtml(rpath, files), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
                if (metadata.mimeType.startsWith('image/') && metadata.thumbnailLink) {
                    const tempLink = metadata.thumbnailLink.replace(/=s\d+$/, '');
                    const rawParam = url.searchParams.get('param');
                    // Plain fetch: the client's Authorization header must never be
                    // forwarded to Google's CDN. If the short-lived link has
                    // expired, fall through to the download endpoint below.
                    const thumb = await fetch(tempLink + (rawParam ? `=${rawParam}` : '=s0'));
                    if (thumb.ok) return thumb;
                }
                const abuse = url.searchParams.get('abuse') === 'true';
                const range = request.headers.get('Range');
                response = await this.getRawContent(metadata.id, range, abuse);
                if (response.status >= 400) {
                    // The body is not always JSON, and `errors` is not always
                    // populated; either would otherwise turn into a 500 that
                    // hides Drive's real status.
                    const result: any = await response.json().catch(() => ({}));
                    const reason = result?.error?.errors?.[0]?.reason;
                    if (!abuse && response.status === 403 && reason === 'cannotDownloadAbusiveFile') {
                        return Response.redirect(url.origin + url.pathname + '?abuse=true', 302);
                    }
                    throw new StatusError(result?.error?.message || response.statusText || 'Drive error', response.status);
                }
            } catch (e: any) { return new Response(e.message, { status: errorStatus(e) }); }
        } else { response = new Response(null, { status: 404 }); }
        return response;
    }

    async POST(request: Request): Promise<Response> {
        if (request.headers.has('Tus-Resumable')) {
            let { rpath, fpath } = getUrl(request.url);
            const totalSize = parseInt(request.headers.get('Upload-Length') || '0', 10);
            let mimeType = 'application/octet-stream';
            let targetPath = fpath;

            const metaHeader = request.headers.get('Upload-Metadata');
            if (metaHeader) {
                const typeMatch = metaHeader.match(/filetype\s+([A-Za-z0-9+/=]+)/);
                if (typeMatch) mimeType = atob(typeMatch[1]);
                const nameMatch = metaHeader.match(/filename\s+([A-Za-z0-9+/=]+)/);
                if (nameMatch) {
                    const binString = atob(nameMatch[1]);
                    const bytes = Uint8Array.from(binString, c => c.charCodeAt(0));
                    const filename = new TextDecoder().decode(bytes);
                    targetPath = pathJoin(fpath, filename);
                }
            }

            const { name, parent } = splitPath(targetPath);
            const parentMetadata = await this.ensureDir(parent);
            if (!parentMetadata) return new Response('Parent folder not found', { status: 404 });

            const metadata = await this.getMetadata(targetPath);
            const existingFileId = metadata?.id || null;

            const api = 'https://www.googleapis.com/upload/drive/v3/files';
            const initUrl = existingFileId ? `${api}/${existingFileId}?uploadType=resumable` : `${api}?uploadType=resumable`;
            const initMethod = existingFileId ? 'PATCH' : 'POST';
            const initBody = existingFileId ? '{}' : JSON.stringify({ name, parents: [parentMetadata.id], mimeType });

            const headers: any = {
                'Content-Type': 'application/json',
                'X-Upload-Content-Type': mimeType,
                Authorization: 'Bearer ' + (await this.getAccessToken())
            };
            if (totalSize > 0) headers['X-Upload-Content-Length'] = totalSize.toString();

            const response = await fetch(initUrl, { method: initMethod, headers, body: initBody });
            const uploadUrl = response.headers.get('Location');
            if (!uploadUrl) {
                const errText = await response.text();
                console.error('GDrive TUS init failed. Status:', response.status, 'Response:', errText);
                return new Response(`Failed to get GDrive resumable URL`, { status: response.status });
            }

            const sessionId = crypto.randomUUID();
            const sessionData = { uploadUrl, totalSize, targetPath, parentId: parentMetadata.id, existingFileId };
            await this.cache.put(sessionId, sessionData, 'tus_session', 86400000);

            const reqUrl = new URL(request.url);
            let basePath = config.path.endsWith('/') ? config.path : config.path + '/';
            const tusLocation = `${reqUrl.origin}${basePath}tus_uploads/${sessionId}`;

            return new Response(null, {
                status: 201,
                headers: {
                    'Tus-Resumable': '1.0.0',
                    'Location': tusLocation,
                    'Tus-Extension': 'creation,creation-with-upload',
                    'Access-Control-Expose-Headers': 'Location, Tus-Resumable, Tus-Extension',
                }
            });
        }
        return new Response('Method Not Allowed', { status: 405 });
    }

    async PATCH(request: Request): Promise<Response> {
        let url = new URL(request.url);

        if (url.pathname.includes('/tus_uploads/')) {
            const sessionId = url.pathname.split('/').pop()!;
            const session = await this.cache.get(sessionId, 'tus_session');

            if (!session) return new Response('Session Not Found', { status: 404 });

            const offset = parseInt(request.headers.get('Upload-Offset') || '0', 10);
            const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
            const end = offset + contentLength - 1;
            const rangeTotal = session.totalSize > 0 ? session.totalSize.toString() : '*';

            const res = await fetch(session.uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Length': `${contentLength}`,
                    'Content-Range': `bytes ${offset}-${end}/${rangeTotal}`
                },
                body: request.body,
                // @ts-ignore
                duplex: 'half'
            });

            if (res.status === 308) {
                return new Response(null, {
                    status: 204,
                    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': (offset + contentLength).toString() }
                });
            } else if (res.status === 200 || res.status === 201) {
                await this.cache.delete(sessionId, 'tus_session');
                await this.cache.invalidateFileAndParent(session.targetPath, session.parentId);

                return new Response(null, {
                    status: 204,
                    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': (offset + contentLength).toString() }
                });
            }
            return new Response(`Chunk upload failed: ${await res.text()}`, { status: 500 });
        }
        return new Response('Method Not Allowed', { status: 405 });
    }

    async PUT(request: Request): Promise<Response> {
        let { fpath } = getUrl(request.url);
        if (fpath.slice(-1) === '/') return new Response(null, { status: 405 });
        const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';

        let contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
        let body: ReadableStream<Uint8Array> | null = request.body;

        // A chunked upload carries no Content-Length header, so the size is
        // unknown and the request would otherwise be treated as a zero byte
        // write. Buffer the body to recover the length.
        if (body && !request.headers.has('Content-Length')) {
            const buffered = await request.arrayBuffer();
            contentLength = buffered.byteLength;
            body = contentLength > 0 ? new Response(buffered).body : null;
        }

        const { name, parent } = splitPath(fpath);
        const parentMetadata = await this.ensureDir(parent);
        if (!parentMetadata) return new Response(null, { status: 404 });
        const metadata = await this.getMetadata(fpath);
        const existingFileId = metadata?.id || null;
        const api = 'https://www.googleapis.com/upload/drive/v3/files';
        if (contentLength === 0 || !body) {
            if (existingFileId) {
                // A JSON PATCH with "{}" only touches metadata and would leave the
                // previous bytes behind, so truncate through the media endpoint.
                const response = await fetch(`${api}/${existingFileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: new Uint8Array(0)
                });
                if (response.ok) {
                    await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                    return new Response(null, { status: 204 });
                }
                return new Response(null, { status: response.status });
            }
            const response = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
                body: JSON.stringify({ name, parents: [parentMetadata.id], mimeType })
            });
            if (response.ok) {
                await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                return new Response(null, { status: 201 });
            }
            return new Response(null, { status: response.status });
        }
        if (contentLength <= 5 * 1024 * 1024) {
            const reader = body.getReader();
            if (existingFileId) {
                // @ts-ignore
                const { readable, writable } = new FixedLengthStream(contentLength);
                const writer = writable.getWriter();
                const uploadPromise = fetch(`${api}/${existingFileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: readable,
                    // @ts-ignore
                    duplex: 'half'
                });
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await writer.write(value);
                    }
                    await writer.close();
                } catch (err) { try { await reader.cancel(); } catch (e) { } await writer.abort(err); } finally { reader.releaseLock(); }
                const res = await uploadPromise;
                if (res.ok) {
                    await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                    return new Response(null, { status: 204 });
                }
                return new Response(await res.text(), { status: res.status });
            } else {
                const boundary = '-------webdav_boundary';
                const fileMetadata = JSON.stringify({ name: name, parents: [parentMetadata.id], mimeType: mimeType });
                const encoder = new TextEncoder();
                const preArray = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${fileMetadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
                const postArray = encoder.encode(`\r\n--${boundary}--`);
                const totalLength = preArray.byteLength + contentLength + postArray.byteLength;
                const { readable, writable } = new FixedLengthStream(totalLength);
                const writer = writable.getWriter();
                const uploadPromise = fetch(`${api}?uploadType=multipart`, {
                    method: 'POST',
                    headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: readable,
                    // @ts-ignore
                    duplex: 'half'
                });

                try {
                    await writer.write(preArray);
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await writer.write(value);
                    }
                    await writer.write(postArray);
                    await writer.close();
                } catch (err) { try { await reader.cancel(); } catch (e) { } await writer.abort(err); } finally { reader.releaseLock(); }

                const res = await uploadPromise;
                if (res.ok) {
                    await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                    return new Response(null, { status: 201 });
                }
                return new Response(await res.text(), { status: res.status });
            }
        }

        const initUrl = existingFileId ? `${api}/${existingFileId}?uploadType=resumable` : `${api}?uploadType=resumable`;
        const initMethod = existingFileId ? 'PATCH' : 'POST';
        const initBody = existingFileId ? '{}' : JSON.stringify({ name, parents: [parentMetadata.id], mimeType });

        const initRes = await fetch(initUrl, {
            method: initMethod,
            headers: {
                'Content-Type': 'application/json',
                'X-Upload-Content-Type': mimeType,
                'X-Upload-Content-Length': contentLength.toString(),
                Authorization: 'Bearer ' + (await this.getAccessToken())
            },
            body: initBody
        });

        const uploadUrl = initRes.headers.get('Location');
        if (!uploadUrl) return new Response('Failed to get Resumable Upload URL', { status: 500 });

        const reader = body.getReader();
        const CHUNK_SIZE = 10 * 1024 * 1024;
        let offset = 0;
        let residualBuffer: Uint8Array | null = null;
        let finalStatus = 200;

        try {
            while (offset < contentLength) {
                const currentChunkSize = Math.min(CHUNK_SIZE, contentLength - offset);
                // @ts-ignore
                const { readable, writable } = new FixedLengthStream(currentChunkSize);
                const writer = writable.getWriter();

                const uploadPromise = fetch(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Length': `${currentChunkSize}`,
                        'Content-Range': `bytes ${offset}-${offset + currentChunkSize - 1}/${contentLength}`
                    },
                    body: readable,
                    // @ts-ignore
                    duplex: 'half'
                });

                let bytesSentInChunk = 0;
                while (bytesSentInChunk < currentChunkSize) {
                    let data: Uint8Array;
                    if (residualBuffer) {
                        data = residualBuffer;
                        residualBuffer = null;
                    } else {
                        const { done, value } = await reader.read();
                        if (done) break;
                        data = value;
                    }

                    const remaining = currentChunkSize - bytesSentInChunk;
                    if (data.length <= remaining) {
                        await writer.write(data);
                        bytesSentInChunk += data.length;
                    } else {
                        await writer.write(data.subarray(0, remaining));
                        residualBuffer = data.subarray(remaining);
                        bytesSentInChunk += remaining;
                    }
                }
                await writer.close();
                const chunkRes = await uploadPromise;

                if (chunkRes.status === 308) {
                } else if (chunkRes.status === 200 || chunkRes.status === 201) {
                    finalStatus = chunkRes.status;
                } else {
                    throw new StatusError(`Google Drive chunk failed: ${await chunkRes.text()}`, chunkRes.status);
                }
                offset += currentChunkSize;
            }

            await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
            return new Response(null, { status: finalStatus <= 201 ? 201 : 204 });

        } catch (err: any) {
            console.error('Upload Failed:', err);
            try { await reader.cancel(); } catch (e) { }
            return new Response(err?.message || 'Upload Failed', { status: errorStatus(err) });
        } finally {
            if (reader) reader.releaseLock();
        }
    }

    async MOVE(request: Request): Promise<Response | undefined> {
        let { fpath } = getUrl(request.url);
        if (fpath === '/') return new Response(null, { status: 403 });
        let destination = request.headers.get('Destination');
        if (!destination) return new Response(null, { status: 403 });
        const { fpath: dest_fpath } = getUrl(destination);
        if (dest_fpath === '/') return new Response(null, { status: 403 });
        const metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });

        const { name, parent } = splitPath(fpath);
        const { name: dest_name, parent: dest_parent } = splitPath(dest_fpath);

        let patchUrl: string | undefined;
        let originalParentId = metadata.parents && metadata.parents.length > 0 ? metadata.parents[0] : null;
        let destParentId = originalParentId;

        if (dest_parent !== parent) {
            const dest_metadata = await this.getMetadata(dest_parent);
            if (!dest_metadata) return new Response(null, { status: 404 });
            destParentId = dest_metadata.id;
            let parentsArray = [...metadata.parents];
            patchUrl = 'removeParents=' + parentsArray.pop() + '&addParents=' + destParentId;
        }

        const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?supportsAllDrives=true&' + (patchUrl || ''), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body: name !== dest_name ? JSON.stringify({ name: dest_name }) : null
        });

        const bodyText = await response.text();
        if (!response.ok) return new Response(bodyText, { status: response.status });

        let result: any = {};
        try { result = JSON.parse(bodyText); } catch { /* not JSON */ }
        if (!result.id) return new Response(bodyText, { status: 500 });

        // The destination path now resolves to a different file, and both
        // the old and the new parent lost a child.
        await this.cache.invalidateFileAndParent(fpath, originalParentId);
        await this.cache.delete(dest_fpath, 'meta');
        if (destParentId && destParentId !== originalParentId) await this.cache.delete(destParentId, 'objects');

        return new Response(null, { status: 201, headers: { 'Location': destination } });
    }

    async COPY(request: Request): Promise<Response> {
        let { fpath } = getUrl(request.url);
        if (fpath === '/') return new Response(null, { status: 403 });
        let destination = request.headers.get('Destination');
        if (!destination) return new Response(null, { status: 403 });
        const { fpath: dest_fpath } = getUrl(destination);
        if (dest_fpath === '/') return new Response(null, { status: 403 });
        const metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });
        const { name, parent } = splitPath(fpath);
        const { name: dest_name, parent: dest_parent } = splitPath(dest_fpath);

        let parents = metadata.parents;
        let destParentId = null;

        if (dest_parent !== parent) {
            const dest_metadata = await this.getMetadata(dest_parent);
            if (!dest_metadata) return new Response(null, { status: 404 });
            destParentId = dest_metadata.id;
            parents = [destParentId];
        } else {
            destParentId = metadata.parents && metadata.parents.length > 0 ? metadata.parents[0] : null;
        }

        const copyResponse = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '/copy?supportsAllDrives=true', {
            method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body: JSON.stringify({ name: dest_name, parents: parents })
        });
        if (!copyResponse.ok) return new Response(await copyResponse.text(), { status: copyResponse.status });

        await this.cache.delete(dest_fpath, 'meta');
        if (destParentId) await this.cache.delete(destParentId, 'objects');

        return new Response(null, { status: 201 });
    }

    async DELETE(request: Request): Promise<Response> {
        let { fpath } = getUrl(request.url);
        if (fpath === '/') return new Response(null, { status: 403 });
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?supportsAllDrives=true', { method: 'DELETE', headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });

            await this.cache.invalidateFileAndParent(fpath, metadata.parents && metadata.parents[0]);
            return new Response(null, { status: response.status });
        }
        return new Response(null, { status: 404 });
    }

    async HEAD(request: Request): Promise<Response> {
        let url = new URL(request.url);
        if (url.pathname.includes('/tus_uploads/')) {
            const sessionId = url.pathname.split('/').pop()!;
            const session = await this.cache.get(sessionId, 'tus_session');
            if (!session) return new Response('Session Not Found', { status: 404 });
            const rangeTotal = session.totalSize > 0 ? session.totalSize.toString() : '*';
            const res = await fetch(session.uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Length': '0',
                    'Content-Range': `bytes */${rangeTotal}`
                }
            });

            let currentOffset = 0;
            if (res.status === 308) {
                const rangeHeader = res.headers.get('Range');
                if (rangeHeader) {
                    const parts = rangeHeader.split('-');
                    currentOffset = parseInt(parts[1], 10) + 1;
                }
            } else if (res.status === 200 || res.status === 201) {
                currentOffset = session.totalSize;
            }

            return new Response(null, {
                status: 200,
                headers: {
                    'Tus-Resumable': '1.0.0',
                    'Upload-Offset': currentOffset.toString(),
                    'Upload-Length': session.totalSize.toString(),
                    'Cache-Control': 'no-store'
                }
            });
        }

        let { fpath } = getUrl(request.url);
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            const size = metadata.size ? metadata.size.toString() : '0';
            const mimeType = metadata.mimeType || 'application/octet-stream';
            const modifiedTime = metadata.modifiedTime ? new Date(metadata.modifiedTime).toUTCString() : new Date().toUTCString();
            return new Response(null, {
                status: 200,
                headers: {
                    'Content-Length': size,
                    'Content-Type': mimeType,
                    'Last-Modified': modifiedTime,
                    'Date': modifiedTime
                }
            });
        }
        return new Response(null, { status: 404 });
    }

    async LOCK(): Promise<Response> { return new Response(null, { status: 200 }); }
    async UNLOCK(): Promise<Response> { return new Response(null, { status: 200 }); }
    async PROPPATCH(): Promise<Response> { return new Response(null, { status: 200 }); }

    // Create any missing folder along the way to `path`, so a client can PUT
    // `/a/b/c.txt` without having to MKCOL `/a` and `/a/b` first.
    async ensureDir(path: string): Promise<any | null> {
        let current = await this.getMetadata('/');
        if (!current) return null;
        const dir = path.endsWith('/') ? path : path + '/';
        if (dir === '/') return current;

        const names = dir.split('/').filter(Boolean);
        for (let i = 0; i < names.length; i++) {
            const sub = '/' + names.slice(0, i + 1).join('/') + '/';
            let meta = await this.getMetadata(sub);
            if (!meta) {
                const created = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: JSON.stringify({ name: names[i], mimeType: FOLDER_MIME, parents: [current.id] })
                });
                if (!created.ok) return null;
                await this.cache.invalidateFileAndParent(sub, current.id);
                meta = await this.getMetadata(sub);
                if (!meta) return null;
            }
            current = meta;
        }
        return current;
    }

    async getMetadata(path: string): Promise<any> {
        path = path.startsWith('/') ? path : '/' + path;
        path = path.endsWith('/') ? path : path + '/';
        let meta = await this.cache.get(path, 'meta');
        if (meta) return meta;

        let fullpath = '/';
        let metadata = (config.cache.meta['/'] && config.cache.meta['/'].data) || null;
        if (!metadata) return null;

        const fragments = trimString(path, '/').split('/');

        for (let name of fragments) {
            if (!name) continue;
            fullpath += name + '/';
            meta = await this.cache.get(fullpath, 'meta');
            if (!meta) {
                // `getUrl` already decoded the path once; decoding again here
                // threw a URIError for any name containing a literal "%".
                const result = await this.queryDrive({
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true,
                    q: `'${metadata.id}' in parents and name = '${escapeQuery(name)}' and trashed = false`,
                    fields: `files(id, name, mimeType, size, modifiedTime, description, iconLink, thumbnailLink, imageMediaMetadata, parents)`,
                });
                if (result.files && result.files.length > 0) {
                    await this.cache.put(fullpath, result.files[0], 'meta');
                    meta = result.files[0];
                } else {
                    return null;
                }
            }
            metadata = meta;
        }
        return metadata;
    }

    async getObjects(id: string): Promise<any[]> {
        let cachedList = await this.cache.get(id, 'objects');
        if (cachedList) return cachedList;

        let pageToken: string | undefined; const list: any[] = [];
        const params: any = {
            pageSize: 1000,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${id}' in parents and trashed = false AND name != '.password'`,
            fields: `nextPageToken, files(id, name, mimeType, size, modifiedTime, description, iconLink, thumbnailLink, imageMediaMetadata)`,
            orderBy: 'folder, name'
        };
        do {
            if (pageToken) params.pageToken = pageToken;
            const result = await this.queryDrive(params);
            pageToken = result.nextPageToken;
            if (result.files) list.push(...result.files);
        } while (pageToken);

        await this.cache.put(id, list, 'objects', 30000);
        return list;
    }

    async getRawContent(id: string, range: string | null, abuse: boolean): Promise<Response> {
        const headers: Record<string, string> = { Authorization: 'Bearer ' + (await this.getAccessToken()) };
        if (range) headers['Range'] = range;
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${id}`);
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('alt', 'media');
        url.searchParams.set('acknowledgeAbuse', abuse ? 'true' : 'false');
        return await fetch(url.toString(), { headers });
    }

    async queryDrive(params: Record<string, any>, retryCount: number = 0): Promise<any> {
        const driveUrl = 'https://www.googleapis.com/drive/v3/files?' + encodeQueryString(params);
        const response = await fetch(driveUrl, { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result: any = await response.json();

        if (result.error) {
            const errMsg = result.error.message || '';
            if ((errMsg.includes('Rate Limit') || errMsg.includes('Quota exceeded') || response.status === 403 || response.status === 429) && retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
                return this.queryDrive(params, retryCount + 1);
            }
            throw new StatusError(errMsg || 'Unknown Google Drive API Error', response.status);
        }
        return result;
    }

    async getQuota(): Promise<{ available: number | string; used: number | string } | undefined> {
        const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result: any = await response.json();
        if (result.storageQuota) return { available: result.storageQuota.limit - result.storageQuota.usage, used: result.storageQuota.usage };
    }

    async getAccessToken(): Promise<string> {
        if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.access_token;
        if (GDrive.fetchingTokenPromise) {
            return await GDrive.fetchingTokenPromise;
        }
        GDrive.fetchingTokenPromise = (async () => {
            try {
                const response = await fetch('https://www.googleapis.com/oauth2/v4/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: encodeQueryString({
                        client_id: config.client_id,
                        client_secret: config.client_secret,
                        refresh_token: config.refresh_token,
                        grant_type: 'refresh_token'
                    })
                });
                const result: any = await response.json();
                if (result.error) {
                    throw new StatusError(result.error_description, response.status);
                }
                tokenCache = { expires: Date.now() + 3500 * 1000, access_token: result.access_token };
                return result.access_token;
            } finally {
                GDrive.fetchingTokenPromise = null;
            }
        })();
        return await GDrive.fetchingTokenPromise;
    }
}

function arrayToXml(rpath: string, files: Partial<DriveFile>[]): string {
    const lock =
        '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>' +
        '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';

    const entries = files.map(file => {
        // The self entry (no name) echoes the requested path.
        let href = file.name ? pathJoin(rpath, file.name) : rpath;
        if (file.dir && !href.endsWith('/')) href += '/';
        const displayname = file.name || rpath.split('/').filter(Boolean).pop() || '';
        const etag = String(file.etag || '0').replace(/[<>&"]/g, '');
        // Numeric fields are serialised as numbers, never as whatever Drive
        // happened to hand back; an unbounded quota is reported as NaN.
        const size = Number(file.size) || 0;
        const quota = file.quota
            ? `<D:quota-used-bytes>${Number(file.quota.used) || 0}</D:quota-used-bytes>` +
              `<D:quota-available-bytes>${Number(file.quota.available) || 0}</D:quota-available-bytes>`
            : '';

        return (
            '<D:response>' +
            `<D:href>${escapeXml(encodePath(href))}</D:href>` +
            '<D:propstat><D:prop>' +
            (file.dir
                ? '<D:resourcetype><D:collection/></D:resourcetype>'
                : '<D:resourcetype></D:resourcetype>') +
            `<D:displayname>${escapeXml(displayname)}</D:displayname>` +
            // Folders deliberately omit getcontentlength: an empty size on a
            // collection upsets several clients.
            (file.dir
                ? ''
                : `<D:getcontentlength>${size}</D:getcontentlength>` +
                  `<D:getcontenttype>${escapeXml(file.type || 'application/octet-stream')}</D:getcontenttype>`) +
            `<D:getetag>"${etag}"</D:getetag>` +
            `<D:getlastmodified>${file.lastmodified || new Date().toUTCString()}</D:getlastmodified>` +
            lock + quota +
            '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
            '</D:response>'
        );
    });

    return `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`;
}

function arrayToHtml(rpath: string, files: Partial<DriveFile>[]): string {
    const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
    const isRoot = rpath === basePath || rpath + '/' === basePath;
    const title = isRoot ? '' : ' - ' + rpath;
    const tpl = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/><link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAApVBMVEUAAAD///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////+4/eNVAAAANnRSTlMA9isRpA3y8NfOoQjl3amJgVcX2sm/cUAw+MO6s5ttOhsU+urfrZB6dWZQRCPSlUsyBeueYCQaPAIhAAABdUlEQVQ4y23S2WKCQAwF0EsRkMWyivvWqrVqF7vc//+0mjhQRM9TkoEZJgENi/l34bp+UB5wx6n0WesmDlrSiFe+XnEl0OoTG6bNTcZUh4eLF81yG5VCC7vZtCp0tdALTdrR1AK4N5UhVR9qT5UCCXH1DktNXI0LCbnFRTiiks+YUx2lfuAKqqrG57Cn0QzKL2CsteyFWGgwcszWHOBiQLVHSVH3bdSrook5Y6Y3bnT0w4SZuamOaGGKD+f4GUYsKxGk/3UH9emkyjxpnz5Q3S2lyhrfaUnbX2Dwws9WK9t2HPTliOD/0He6lmCe592zN58cY0drUU1o4NgiO098OPz8/J2SWzkogvI2uBZ6OsKI3En6SrSMScsB5PeRRnPeWv+QEZnJboDARcszyaUEPxpw2FpPtGfVWMb9bWt9SfLNxCf5JTadThB0xKNak14Gw855h3dEzZnwRrFEU2m11hO0ZHHU2P39iFthGk96rrvux6mN2h80rVPh8HjxPAAAAABJRU5ErkJggg=="/><title>${config.name}{{title}}</title><style>*{box-sizing:border-box}body{font:15px/1.3 Helvetica,Arial;background:#0E1117;color:#CAD1D9}h1,main{background:#0E1117;max-width:960px;margin:10px auto;border-radius:5px}h1{font-size:18px;padding:15px;border:#22262D 1px solid;color:#DDD;background:#171b22}a{color:inherit;text-decoration:none}h1 a,main a{display:flex;align-items:center}main a:first-child{border-top-left-radius:5px;border-top-right-radius:5px}main a:last-child{border-bottom-left-radius:5px;border-bottom-right-radius:5px}svg{margin-right:15px;fill:#F1F6FC}h1:hover{color:#BABBBD}main{border:#22262D 1px solid}main img{margin-right:10px}main a{padding:12px 15px;border-bottom:#22262D 1px solid;transition:all .3s}main a:last-child{border:0}main a:hover{background:#171B22;color:#58a6ff}main a>div{margin-left:10px}main a>div:first-child{flex:1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center}main a>div:not(:first-child){color:#8C949E;font-size:13px}footer{text-align:center;color:#8C949E;font-size:13px}footer a:hover{text-decoration:underline}@media (max-width:640px){main a>div:last-child{display:none}}</style></head><body><h1><a href="${basePath}"><svg width="32" height="32" viewBox="0 0 320 320"><path d="M95 304 c-47 -24 -71 -51 -84 -95 -26 -87 20 -173 107 -199 145 -44 262 135 165 251 -48 56 -128 75 -188 43z m168 -73 c9 -16 17 -32 17 -35 0 -3 -35 -6 -78 -6 -85 0 -78 -4 -110 63 -2 4 32 7 75 7 76 0 79 -1 96 -29z m-149 -46 c38 -65 38 -65 16 -100 -22 -36 -22 -36 -62 32 -40 68 -40 68 -22 101 9 17 20 32 23 32 4 0 24 -29 45 -65z m166 -9 c0 -12 -75 -129 -86 -133 -7 -2 -26 -3 -42 -1 -30 3 -30 3 9 71 39 65 41 67 79 67 22 0 40 -2 40 -4z" /></svg>${config.name}</a></h1><main>{{content}}</main><footer><a target="_blank" href="${config.copyright_link}">${config.copyright}</a></footer></body></html>`;
    let frag: string[] = [];
    if (!isRoot) frag.push(`<a href="../"><div><img src="/_/16/type/application/vnd.google-apps.folder"><b>../</b></div></a>`);
    if (files) {
        for (let i = 0; i < files.length; i++) {
            const entry = files[i];
            const rawName = entry.name || '';
            const iconLink = entry.iconLink ? entry.iconLink.replace('https://drive-thirdparty.googleusercontent.com/', '/_/') : '';
            const modTime = entry.lastmodified ? `<div>${escapeXml(new Date(entry.lastmodified).toISOString().split('T')[0])}</div>` : '';
            // Names come from Drive and are fully attacker controlled: escape them
            // for HTML text and percent-encode them for the href.
            const name = escapeXml(rawName);
            const href = encodeURIComponent(rawName);
            if (entry.dir) {
                frag.push(`<a href="${href}/"><div><img src="${escapeXml(iconLink)}"/><b>${name}</b></div>${modTime}</a>`);
            } else {
                frag.push(`<a href="${href}" target="_blank"><div><img src="${escapeXml(iconLink)}"/>${name}</div><div>${formatSize(entry.size || 0)}</div>${modTime}</a>`);
            }
        }
    }
    const content = frag.join('');
    // Replacer functions: substitution patterns such as `$&` in a file name
    // would otherwise be expanded by `String.prototype.replace`.
    return tpl.trim().replace(/{{content}}/, () => content).replace(/{{title}}/, () => escapeXml(title));
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const { protocol, pathname } = new URL(request.url);
        let method = request.method.toUpperCase();

        if (pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { status: 200 });
        if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
        if (pathname.indexOf('/desktop.ini') !== -1) return new Response(null, { status: 404 });

        try {
            // Static
            if (pathname.startsWith('/_/')) {
                const url = new URL(request.url);
                url.hostname = 'drive-thirdparty.googleusercontent.com';
                url.pathname = url.pathname.slice(2);
                // Plain fetch: do not forward the client's credentials to a
                // third-party host.
                let response = await fetch(url.toString());
                response = new Response(response.body, response);
                response.headers.set('Access-Control-Allow-Origin', '*');
                response.headers.set('Cache-Control', 'public, max-age=16768000');
                return response;
            }

            let basePath = config.path.endsWith('/') ? config.path : config.path + '/';
            if (basePath !== '/') {
                if (pathname + '/' === basePath) {
                    const u = new URL(request.url);
                    u.pathname += '/';
                    return Response.redirect(u.toString(), 301);
                }
                if (!pathname.startsWith(basePath)) {
                    return new Response('404 Not Found', { status: 404 });
                }
            }

            // Env
            if (env && !config.env) {
                if (env.USERS) {
                    if (typeof env.USERS === 'string') {
                        try {
                            const users = JSON.parse(env.USERS);
                            // Silently keeping the placeholder credentials below
                            // would leave the server reachable as user/password.
                            config.users = users && typeof users === 'object' ? users : {};
                        } catch (error) {
                            console.error('USERS is not valid JSON');
                            config.users = {};
                        }
                    } else if (typeof env.USERS === 'object') {
                        config.users = env.USERS as Record<string, string>;
                    }
                }
                if (env.CLIENT_ID) config.client_id = env.CLIENT_ID;
                if (env.CLIENT_SECRET) config.client_secret = env.CLIENT_SECRET;
                if (env.REFRESH_TOKEN) config.refresh_token = env.REFRESH_TOKEN;
                if (env.ROOT_ID) config.cache.meta['/']!.data.id = env.ROOT_ID;
                if (env.PATH) config.path = env.PATH;
                if (env.NAME) config.name = env.NAME;
                if (env.COPYRIGHT) config.copyright = env.COPYRIGHT;
                if (env.COPYRIGHT_LINK) config.copyright_link = env.COPYRIGHT_LINK;
                config.env = true;
            }

            // Global Basic Authentication
            if (Object.keys(config.users).length === 0) {
                return new Response('Server not configured: set the USERS variable', { status: 500 });
            }
            if (!request.headers.has('Authorization')) {
                return new Response('Authentication Required.', {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Basic realm="${config.name}", charset="UTF-8"` }
                });
            }

            const auth = basicAuthentication(request);
            if (!auth || !isValidUser(config.users, auth)) {
                return new Response('Unauthorized', { status: 401 });
            }

            const missing = [
                ['CLIENT_ID', config.client_id],
                ['CLIENT_SECRET', config.client_secret],
                ['REFRESH_TOKEN', config.refresh_token]
            ]
                .filter(([, value]) => !value)
                .map(([key]) => key);
            if (missing.length > 0) {
                return new Response('Server not configured: missing ' + missing.join(', '), { status: 500 });
            }

            const drive = new GDrive(env, ctx);

            // Method Routing
            if (method === 'PATCH' && !pathname.includes('/tus_uploads/')) {
                method = 'COPY';
            }

            if (typeof (drive as any)[method] === 'function') {
                return await (drive as any)[method](request);
            }

            return new Response('Method Not Allowed', { status: 405 });

        } catch (e: any) {
            const status = e.status || e.code || 500;
            return new Response(status + ': ' + e.message, { status });
        }
    }
};
