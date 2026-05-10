interface KVNamespace {
    get(
        key: string,
        options?: {
            type?: 'text' | 'json' | 'arrayBuffer' | 'stream';
            cacheTtl?: number;
        }
    ): Promise<any>;
    put(
        key: string,
        value: any,
        options?: {
            expiration?: number;
            expirationTtl?: number;
            metadata?: any;
        }
    ): Promise<void>;
    delete(key: string): Promise<void>;
}

interface Env {
    KV: KVNamespace;
}

interface Ctx {
    waitUntil(promise: Promise<any>): void;
}

interface QueryParams {
    includeItemsFromAllDrives: boolean;
    supportsAllDrives: boolean;
    q: string;
    fields: string;
    pageSize?: number;
    orderBy?: string;
}

interface VFile {
    name: string;
    dir: boolean;
    size: number;
    lastmodified?: string | null;
    quota?: {
        used: number;
        available: number;
    } | null;
}