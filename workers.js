var config = {
    client_id: '202264815644.apps.googleusercontent.com', // Google API Client ID
    client_secret: 'X4Z3ca8xfWDb1Voo-F9a7ZxJ', // Google API Client Secret
    refresh_token: '', // Google Drive API Refresh Token

    name: 'My Cloud Drive', // Display name for the web interface
    link: 'https://github.com/ixiumu/google-drive-webdav-workers', // URL link for the footer
    copyright: '@ixiumu', // Copyright text displayed in the footer

    users: {
        'user': 'password' // Global Authentication credentials (username: password)
    },

    working_dir: '/', // Root directory path for the drive mapping
    cache: {
        meta: {
            '/': { data: { id: 'root', mimeType: 'application/vnd.google-apps.folder', size: 0, modifiedTime: null }, expire: Infinity }
        },
        putUrl: {},
        config: {}
    }
};

const pathJoin = (...args) => args.join('/').replace(/\\/g, '/').replace(/(?<!^)\/+/g, '/').replace(/\/\//g, '/');
const getUrl = (url) => ({ rpath: decodeURIComponent(new URL(url).pathname), fpath: pathJoin(config.working_dir, decodeURIComponent(new URL(url).pathname)) });
const encodeQueryString = (data) => Object.keys(data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&');
const trimString = (string, char) => char ? string.replace(new RegExp('^\\' + char + '+|\\' + char + '+$', 'g'), '') : string.replace(/^\s+|\s+$/g, '');
const formatSize = (n) => {
    n = Math.round(n); if (n === 0) return '';
    if (n < 1024) return n + 'B'; if (n < 1024 * 1024) return Math.round(n / 1024) + 'K';
    return parseFloat((n / 1024 / 1024).toFixed(1)) + 'M';
};
const basicAuthentication = (request) => {
    const Authorization = request.headers.get('Authorization');
    if (!Authorization) return null;
    const [scheme, encoded] = Authorization.split(' ');
    if (!encoded || scheme !== 'Basic') return null;
    const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(buffer).normalize();
    const index = decoded.indexOf(':');
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;
    return { user: decoded.substring(0, index), pass: decoded.substring(index + 1) };
};

const xf = (() => { const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head']; class HTTPError extends Error { constructor(res) { super(res.statusText); this.name = 'HTTPError'; this.response = res; } } class XResponsePromise extends Promise { } const { assign } = Object; function mergeDeep(target, source) { const isObject = obj => obj && typeof obj === 'object'; if (!isObject(target) || !isObject(source)) { return source; } Object.keys(source).forEach(key => { const targetValue = target[key]; const sourceValue = source[key]; if (Array.isArray(targetValue) && Array.isArray(sourceValue)) { target[key] = targetValue.concat(sourceValue); } else if (isObject(targetValue) && isObject(sourceValue)) { target[key] = mergeDeep(Object.assign({}, targetValue), sourceValue); } else { target[key] = sourceValue; } }); return target; } const fromEntries = ent => ent.reduce((acc, [k, v]) => (acc[k] = v, acc), {}); const typeis = (...types) => val => types.some(type => typeof type === 'string' ? typeof val === type : val instanceof type); const isstr = typeis('string'); const isobj = typeis('object'); const isstrorobj = v => isstr(v) || isobj(v); const responseErrorThrower = res => { if (!res.ok) throw new HTTPError(res); return res; }; const extend = (defaultInit = {}) => { const xfetch = (input, init = {}) => { mergeDeep(init, defaultInit); const createQueryString = o => new init.URLSearchParams(o).toString(); const parseQueryString = s => fromEntries([...new init.URLSearchParams(s).entries()]); const url = new init.URL(input, init.baseURI || undefined); if (!init.headers) { init.headers = {}; } else if (typeis(init.Headers)(init.headers)) { init.headers = fromEntries([...init.headers.entries()]); } if (init.json) { init.body = JSON.stringify(init.json); init.headers['Content-Type'] = 'application/json'; } else if (isstrorobj(init.urlencoded)) { init.body = isstr(init.urlencoded) ? init.urlencoded : createQueryString(init.urlencoded); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; } else if (typeis(init.FormData, 'object')(init.formData)) { if (!typeis(init.FormData)(init.formData)) { const fd = new init.FormData(); for (const [k, v] of Object.entries(init.formData)) { fd.append(k, v); } init.formData = fd; } init.body = init.formData; } if (init.qs) { if (isstr(init.qs)) init.qs = parseQueryString(init.qs); url.search = createQueryString(assign(fromEntries([...url.searchParams.entries()]), init.qs)); } return XResponsePromise.resolve(init.fetch(url, init).then(responseErrorThrower)); }; for (const method of METHODS) { xfetch[method] = (input, init = {}) => { init.method = method.toUpperCase(); return xfetch(input, init); }; } xfetch.extend = newDefaultInit => extend(assign({}, defaultInit, newDefaultInit)); xfetch.HTTPError = HTTPError; return xfetch; }; const isWindow = typeof document !== 'undefined'; const isBrowser = typeof self !== 'undefined'; return isBrowser ? extend({ fetch: fetch.bind(self), URL, Response, URLSearchParams, Headers, FormData, baseURI: isWindow ? document.baseURI : '' }) : extend(); })();

class KVCache {
    constructor(env, ctx) {
        this.env = env;
        this.ctx = ctx;
    }

    async get(k, ns) {
        const now = Date.now();
        if (config.cache[ns] && config.cache[ns][k]) {
            if (config.cache[ns][k].expire > now) {
                return config.cache[ns][k].data;
            }
        }
        if (this.env && this.env.KV) {
            const v = await this.env.KV.get(ns + '.' + k, { type: 'json' });
            if (v) {
                if (!config.cache[ns]) config.cache[ns] = {};
                config.cache[ns][k] = { data: v, expire: now + 300000 };
                return v;
            }
        }
        return null;
    }

    async put(k, v, ns, customTtl) {
        if (v) {
            if (!config.cache[ns]) config.cache[ns] = {};
            const ttl = customTtl || 300000;
            config.cache[ns][k] = { data: v, expire: Date.now() + ttl };
            if (this.env && this.env.KV && this.ctx) {
                this.ctx.waitUntil(this.env.KV.put(ns + '.' + k, JSON.stringify(v), { expirationTtl: Math.max(60, Math.floor(ttl / 1000)) }));
            }
        }
    }

    async delete(k, ns) {
        if (ns === 'meta' && !k.endsWith('/')) k += '/';
        if (ns === 'meta' && k === '/') return;
        if (config.cache[ns] && config.cache[ns][k]) {
            delete config.cache[ns][k];
        }
        if (this.env && this.env.KV && this.ctx) {
            this.ctx.waitUntil(this.env.KV.delete(ns + '.' + k));
        }
    }

    async invalidateFileAndParent(fpath) {
        await this.delete(fpath, 'meta');
        const tok = fpath.split('/');
        tok.pop();
        const parent = tok.join('/');
        await this.delete(parent, 'meta');
    }
}

class GDrive {
    constructor(cache) {
        this.cache = cache;
    }

    async OPTIONS(request) {
        let allowed_methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'MKCOL', 'DELETE', 'MOVE', 'COPY'].join(',');
        return new Response(null, { status: 200, headers: { 'Allow': allowed_methods, 'DAV': '1, 2, 3', 'MS-Author-Via': 'DAV', 'Accept-Ranges': 'bytes' } });
    }

    async PROPFIND(request) {
        let { rpath, fpath } = getUrl(request.url);
        const metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });

        let content;
        if (metadata.mimeType === 'application/vnd.google-apps.folder') {
            const depth = request.headers.get('Depth');
            if (depth && depth === '1') {
                const objects = await this.getObjects(metadata.id);
                let files = [];
                for (let i = 0; i < objects.length; i++) {
                    let object = objects[i];
                    files.push({ name: object.name, dir: object.mimeType === 'application/vnd.google-apps.folder', lastmodified: new Date(object.modifiedTime).toUTCString(), size: object.size ? object.size : 0 });
                }
                content = arrayToXml(rpath, [{ name: '', dir: true, lastmodified: null, size: 0 }].concat(files || []), '');
            } else {
                content = arrayToXml(rpath, [{ name: rpath, dir: true, lastmodified: new Date(metadata.modifiedTime).toUTCString(), size: metadata.size, quota: rpath === '/' ? await this.getQuota() : null }]);
            }
        } else {
            content = arrayToXml(rpath, [{ name: '', dir: false, lastmodified: new Date(metadata.modifiedTime).toUTCString(), size: metadata.size }]);
        }
        return new Response(content, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    }

    async MKCOL(request) {
        let { rpath, fpath } = getUrl(request.url);
        if (fpath.slice(-1) === '/') fpath = fpath.slice(0, -1);

        let metadata = await this.getMetadata(fpath);
        if (metadata) return new Response('<d:error xmlns:d="DAV:" xmlns:td="https://www.contoso.com/schema/"><td:exception>MethodNotAllowed</td:exception><td:message>The resource you tried to create already exists</td:message></d:error>', { status: 405 });

        const tok = fpath.split('/'); const name = tok.pop(); const parent = tok.join('/');
        let parentMetadata = await this.getMetadata(parent);
        if (!parentMetadata) return new Response(null, { status: 404 });

        let response = await fetch(new Request('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
            body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentMetadata.id] }),
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) }
        }));

        if (response.ok) {
            await this.cache.invalidateFileAndParent(fpath);
            await this.cache.delete(parentMetadata.id, 'objects');
            return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 422 });
    }

    async GET(request) {
        let { rpath, fpath } = getUrl(request.url);
        let url = new URL(request.url);
        let response;
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            try {
                if (metadata.mimeType === 'application/vnd.google-apps.folder') {
                    const objects = await this.getObjects(metadata.id);
                    let files = [];
                    for (let i = 0; i < objects.length; i++) {
                        let object = objects[i];
                        files.push({ name: trimString(object.name, '/'), dir: object.mimeType === 'application/vnd.google-apps.folder', lastmodified: new Date(object.modifiedTime).toISOString().split('T')[0], size: object.size ? object.size : 0, iconLink: object.iconLink });
                    }
                    return new Response(arrayToHtml(rpath, files), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
                if (metadata.mimeType.startsWith('image/')) {
                    const tempLink = metadata.thumbnailLink.replace(/=s\d+$/, '');
                    url.param = url.param || '=s0';
                    return await fetch(new Request(tempLink + url.param, request));
                }
                const abuse = url.searchParams.get('abuse') === 'true';
                const range = request.headers.get('Range');
                response = await this.getRawContent(metadata.id, range, abuse);
                if (response.status >= 400) {
                    const result = await response.json();
                    if (!abuse && response.status === 403 && result.error.errors[0].reason === 'cannotDownloadAbusiveFile') {
                        return Response.redirect(url.origin + url.pathname + '?abuse=true', 302);
                    }
                    const error = new Error(result.error.message); error.status = response.status; throw error;
                }
            } catch (e) { return new Response(e.message, { status: 500 }); }
        } else { response = new Response(null, { status: 404 }); }
        return response;
    }

    async PUT(request) {
        let { rpath, fpath } = getUrl(request.url);
        if (fpath.slice(-1) === '/') return new Response(null, { status: 405 });
        const contentLength = request.headers.get('Content-Length');

        let putUrl = await this.cache.get(fpath, 'putUrl');
        let parentMetadata;

        if (!putUrl) {
            const tok = fpath.split('/'); const name = tok.pop(); const parent = tok.join('/');
            parentMetadata = await this.getMetadata(parent);
            if (!parentMetadata) return new Response(null, { status: 404 });

            const metadata = await this.getMetadata(fpath);
            if (metadata) {
                await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?supportsAllDrives=true', { method: 'DELETE', headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
            }

            let response = await fetch(new Request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
                method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
                body: JSON.stringify({ name, parents: [parentMetadata.id] })
            }));
            putUrl = response.headers.get('Location');
            if (!putUrl) return new Response(JSON.stringify(response), { status: 403 });
            await this.cache.put(fpath, putUrl, 'putUrl');
        }

        let response = await fetch(putUrl, { body: request.body, method: 'PUT', headers: { Authorization: 'Bearer ' + (await this.getAccessToken()), 'Content-Length': contentLength } });
        if (response.status !== 409) {
            await this.cache.delete(fpath, 'putUrl');
            await this.cache.invalidateFileAndParent(fpath);

            if (!parentMetadata) {
                const tok = fpath.split('/'); tok.pop();
                parentMetadata = await this.getMetadata(tok.join('/'));
            }
            if (parentMetadata) await this.cache.delete(parentMetadata.id, 'objects');
        }
        return new Response(response.status <= 201 ? null : JSON.stringify(response), { status: response.status <= 201 ? 201 : response.status });
    }

    async MOVE(request) {
        let { rpath, fpath } = getUrl(request.url);
        if (rpath === '/') return new Response(null, { status: 403 });
        let destination = request.headers.get('Destination');
        if (!destination) return new Response(null, { status: 403 });
        const dest_fpath = pathJoin(config.working_dir, decodeURIComponent(new URL(destination).pathname));
        const metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });

        const tok = fpath.split('/'); const name = tok.pop(); const parent = tok.join('/');
        const dest_tok = dest_fpath.split('/'); const dest_name = dest_tok.pop(); const dest_parent = dest_tok.join('/');

        let patchUrl;
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

        const result = await response.json();
        if (result.id) {
            await this.cache.invalidateFileAndParent(fpath);
            await this.cache.delete(dest_parent, 'meta');

            if (originalParentId) await this.cache.delete(originalParentId, 'objects');
            if (destParentId && destParentId !== originalParentId) await this.cache.delete(destParentId, 'objects');

            return new Response(null, { status: 201, headers: { 'Location': destination } });
        }
    }

    async COPY(request) {
        let { rpath, fpath } = getUrl(request.url);
        let destination = request.headers.get('Destination');
        if (!destination) return new Response(null, { status: 403 });
        let dest_rpath = decodeURIComponent(new URL(destination).pathname);
        if (dest_rpath === '/') return new Response(null, { status: 403 });
        let dest_fpath = pathJoin(config.working_dir, dest_rpath);
        const metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });
        const tok = fpath.split('/'); const name = tok.pop(); const parent = tok.join('/');
        const dest_tok = dest_fpath.split('/'); const dest_name = dest_tok.pop(); const dest_parent = dest_tok.join('/');

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

        await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '/copy?supportsAllDrives=true', {
            method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body: JSON.stringify({ name: dest_name, parents: parents })
        });

        await this.cache.delete(dest_parent, 'meta');
        if (destParentId) await this.cache.delete(destParentId, 'objects');

        return new Response(null, { status: 201 });
    }

    async DELETE(request) {
        let { rpath, fpath } = getUrl(request.url);
        if (rpath === '/') return new Response(null, { status: 403 });
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?supportsAllDrives=true', { method: 'DELETE', headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });

            await this.cache.invalidateFileAndParent(fpath);
            if (metadata.parents && metadata.parents.length > 0) {
                await this.cache.delete(metadata.parents[0], 'objects');
            }
            return new Response(null, { status: response.status });
        }
        return new Response(null, { status: 404 });
    }

    async HEAD(request) {
        let { rpath, fpath } = getUrl(request.url);
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
            const result = await response.json();
            if (result) return new Response(null, { status: 200, headers: { 'Content-Length': result.mimeType, 'Content-Type': result.size, 'date': new Date(result.modifiedTime).toUTCString() } });
        }
        return new Response(null, { status: 404 });
    }

    async LOCK() { return new Response(null, { status: 200 }); }
    async UNLOCK() { return new Response(null, { status: 200 }); }
    async PROPPATCH() { return new Response(null, { status: 200 }); }

    // API Helper Methods
    async getMetadata(path) {
        path = path.startsWith('/') ? path : '/' + path;
        path = path.endsWith('/') ? path : path + '/';
        let meta = await this.cache.get(path, 'meta');
        if (meta) return meta;

        let fullpath = '/';
        let metadata = (config.cache.meta[fullpath] && config.cache.meta[fullpath].data) || null;
        if (!metadata) return null;

        const fragments = trimString(path, '/').split('/');

        for (let name of fragments) {
            if (!name) continue; // Safe guard for root path fragments
            fullpath += name + '/';
            meta = await this.cache.get(fullpath, 'meta');
            if (!meta) {
                name = decodeURIComponent(name).replace(/\'/g, "\\'");
                const result = await this.queryDrive({
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true,
                    q: `'${metadata.id}' in parents and name = '${name}' and trashed = false`,
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

    async getObjects(id) {
        let cachedList = await this.cache.get(id, 'objects');
        if (cachedList) return cachedList;

        let pageToken; const list = [];
        const params = {
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

    async getRawContent(id, range, abuse) {
        const headers = { Authorization: 'Bearer ' + (await this.getAccessToken()) };
        if (range) headers['Range'] = range;
        return await xf.get(`https://www.googleapis.com/drive/v3/files/${id}`, {
            qs: { supportsAllDrives: true, alt: 'media', acknowledgeAbuse: abuse ? 'true' : 'false' },
            headers: headers
        });
    }

    async queryDrive(params, retryCount = 0) {
        const driveUrl = 'https://www.googleapis.com/drive/v3/files?' + encodeQueryString(params);
        const response = await fetch(driveUrl, { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result = await response.json();

        if (result.error) {
            const errMsg = result.error.message || '';
            if ((errMsg.includes('Rate Limit') || errMsg.includes('Quota exceeded') || response.status === 403 || response.status === 429) && retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
                return this.queryDrive(params, retryCount + 1);
            }
            const error = new Error(errMsg || 'Unknown Google Drive API Error');
            error.status = response.status;
            throw error;
        }
        return result;
    }

    async getQuota() {
        const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result = await response.json();
        if (result.storageQuota) return { available: result.storageQuota.limit - result.storageQuota.usage, used: result.storageQuota.usage };
    }

    async getAccessToken() {
        let token = await this.cache.get('token', 'config');
        if (token && token.expires && token.expires > Date.now()) return token.access_token;
        const response = await fetch('https://www.googleapis.com/oauth2/v4/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: encodeQueryString({ client_id: config.client_id, client_secret: config.client_secret, refresh_token: config.refresh_token, grant_type: 'refresh_token' })
        });
        const result = await response.json();
        if (result.error) { const error = new Error(result.error_description); error.status = response.status; throw error; }
        await this.cache.put('token', { expires: Date.now() + 3500 * 1000, access_token: result.access_token }, 'config', 3500 * 1000);
        return result.access_token;
    }
}

const arrayToXml = function (rpath, files, cursor) {
    let entries = [];
    for (let i = 0; i < files.length; i++) {
        let file = files[i];
        if (!file.lastmodified) file.lastmodified = new Date().toUTCString();
        let sizeTag = !file.dir ? `<d:getcontentlength>${file.size}</d:getcontentlength>` : '<d:getcontentlength />';
        let quotaTag = file.quota ? `<d:quota-used-bytes>${file.quota.used}</d:quota-used-bytes><d:quota-available-bytes>${file.quota.available}</d:quota-available-bytes>` : '';

        let href = pathJoin(rpath, file.name);
        if (file.dir && !href.endsWith('/')) href += '/';

        entries.push(
            '<d:response>', `<d:href>${encodeURI(href)}</d:href>`, '<d:propstat>', '<d:prop>',
            `<d:getlastmodified>${file.lastmodified}</d:getlastmodified>`,
            file.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype />',
            sizeTag, quotaTag,
            '</d:prop>', '<d:status>HTTP/1.1 200 OK</d:status>', '</d:propstat>', '</d:response>'
        );
    }
    let new_cursor = cursor ? `<td:cursor>${cursor}</td:cursor>` : '';
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:R="https://www.contoso.com/schema/">${entries.join('\n')}${new_cursor}</d:multistatus>`;
};

const arrayToHtml = function (rpath, files) {
    const tpl = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/><link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAApVBMVEUAAAD///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////+4/eNVAAAANnRSTlMA9isRpA3y8NfOoQjl3amJgVcX2sm/cUAw+MO6s5ttOhsU+urfrZB6dWZQRCPSlUsyBeueYCQaPAIhAAABdUlEQVQ4y23S2WKCQAwF0EsRkMWyivvWqrVqF7vc//+0mjhQRM9TkoEZJgENi/l34bp+UB5wx6n0WesmDlrSiFe+XnEl0OoTG6bNTcZUh4eLF81yG5VCC7vZtCp0tdALTdrR1AK4N5UhVR9qT5UCCXH1DktNXI0LCbnFRTiiks+YUx2lfuAKqqrG57Cn0QzKL2CsteyFWGgwcszWHOBiQLVHSVH3bdSrook5Y6Y3bnT0w4SZuamOaGGKD+f4GUYsKxGk/3UH9emkyjxpnz5Q3S2lyhrfaUnbX2Dwws9WK9t2HPTliOD/0He6lmCe592zN58cY0drUU1o4NgiO098OPz8/J2SWzkogvI2uBZ6OsKI3En6SrSMScsB5PeRRnPeWv+QEZnJboDARcszyaUEPxpw2FpPtGfVWMb9bWt9SfLNxCf5JTadThB0xKNak14Gw855h3dEzZnwRrFEU2m11hO0ZHHU2P39iFthGk96rrvux6mN2h80rVPh8HjxPAAAAABJRU5ErkJggg=="/><title>${config.name}{{title}}</title><style>*{box-sizing:border-box}body{font:15px/1.3 Helvetica,Arial;background:#0E1117;color:#CAD1D9}h1,main{background:#0E1117;max-width:960px;margin:10px auto;border-radius:5px}h1{font-size:18px;padding:15px;border:#22262D 1px solid;color:#DDD;background:#171b22}a{color:inherit;text-decoration:none}h1 a,main a{display:flex;align-items:center}main a:first-child{border-top-left-radius:5px;border-top-right-radius:5px}main a:last-child{border-bottom-left-radius:5px;border-bottom-right-radius:5px}svg{margin-right:15px;fill:#F1F6FC}h1:hover{color:#BABBBD}main{border:#22262D 1px solid}main img{margin-right:10px}main a{padding:12px 15px;border-bottom:#22262D 1px solid;transition:all .3s}main a:last-child{border:0}main a:hover{background:#171B22;color:#58a6ff}main a>div{margin-left:10px}main a>div:first-child{flex:1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center}main a>div:not(:first-child){color:#8C949E;font-size:13px}footer{text-align:center;color:#8C949E;font-size:13px}footer a:hover{text-decoration:underline}@media (max-width:640px){main a>div:last-child{display:none}}</style></head><body><h1><a href="/"><svg width="32" height="32" viewBox="0 0 320 320"><path d="M95 304 c-47 -24 -71 -51 -84 -95 -26 -87 20 -173 107 -199 145 -44 262 135 165 251 -48 56 -128 75 -188 43z m168 -73 c9 -16 17 -32 17 -35 0 -3 -35 -6 -78 -6 -85 0 -78 -4 -110 63 -2 4 32 7 75 7 76 0 79 -1 96 -29z m-149 -46 c38 -65 38 -65 16 -100 -22 -36 -22 -36 -62 32 -40 68 -40 68 -22 101 9 17 20 32 23 32 4 0 24 -29 45 -65z m166 -9 c0 -12 -75 -129 -86 -133 -7 -2 -26 -3 -42 -1 -30 3 -30 3 9 71 39 65 41 67 79 67 22 0 40 -2 40 -4z" /></svg>${config.name}</a></h1><main>{{content}}</main><footer><a target="_blank" href="${config.link}">${config.copyright}</a></footer></body></html>`;

    let frag = []; const title = rpath === '/' ? '' : ' - ' + rpath;
    if (rpath !== '/') frag.push(`<a href="../"><div><img src="/_/16/type/application/vnd.google-apps.folder"><b>../</b></div></a>`);

    if (files) {
        for (let i = 0; i < files.length; i++) {
            let entry = files[i];
            entry.iconLink = entry.iconLink.replace('https://drive-thirdparty.googleusercontent.com/', '/_/');
            let modTime = entry.lastmodified ? `<div>${new Date(entry.lastmodified).toISOString().split('T')[0]}</div>` : '';
            if (entry.dir) {
                frag.push(`<a href="${entry.name}/"><div><img src="${entry.iconLink}"/><b>${entry.name}</b></div>${modTime}</a>`);
            } else {
                frag.push(`<a href="${entry.name}" target="_blank"><div><img src="${entry.iconLink}"/>${entry.name}</div><div>${formatSize(entry.size)}</div>${modTime}</a>`);
            }
        }
    }
    return tpl.trim().replace(/{{content}}/, frag.join('')).replace(/{{title}}/, title);
};

export default {
    async fetch(request, env, ctx) {
        const { protocol, pathname } = new URL(request.url);
        let method = request.method.toUpperCase();

        if (pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { status: 200 });
        if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
        if (pathname.indexOf('/desktop.ini') !== -1) return new Response(null, { status: 404 });

        try {
            // Google Drive CDN bypass (Unauthenticated intentionally for serving media)
            if (pathname.startsWith('/_/')) {
                let url = new URL(request.url); url.hostname = 'drive-thirdparty.googleusercontent.com'; url.pathname = url.pathname.slice(2);
                let response = await fetch(new Request(url, request));
                response = new Response(response.body, response);
                response.headers.set('Access-Control-Allow-Origin', '*');
                response.headers.set('Cache-Control', 'public, max-age=16768000');
                return response;
            }

            let forwardedProto = request.headers.get('x-forwarded-proto');
            if (protocol !== 'https:' && (!forwardedProto || forwardedProto !== 'https')) {
                return new Response('Please use a HTTPS connection.', { status: 400 });
            }

            // Global Basic Authentication
            if (!request.headers.has('Authorization')) {
                return new Response('Authentication Required.', {
                    status: 401,
                    headers: { 'WWW-Authenticate': 'Basic realm="' + config.name + '", charset="UTF-8"' }
                });
            }

            const auth = basicAuthentication(request);
            if (!auth || !config.users[auth.user] || config.users[auth.user] !== auth.pass) {
                return new Response('Unauthorized', { status: 401 });
            }

            // Initialize Context for this Request
            const cache = new KVCache(env, ctx);
            const drive = new GDrive(cache);

            // Method Routing
            if (method === 'PATCH') method = 'COPY';

            if (typeof drive[method] === 'function') {
                return await drive[method](request);
            }

            return new Response('Method Not Allowed', { status: 405 });

        } catch (e) {
            const status = e.status || e.code || 500;
            return new Response(status + ': ' + e.message, { status });
        }
    }
};
