interface AppConfig {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    name: string;
    copyright: string;
    copyright_link: string;
    users: Record<string, string>;
    env: boolean;
    path: string;
    working_dir: string;
    cache: {
        meta: Record<string, CacheItem>;
        putUrl: Record<string, CacheItem<string>>;
        config: Record<string, CacheItem>;
        [key: string]: Record<string, CacheItem> | undefined;
    };
}

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size?: number | string;
    modifiedTime: string | null;
    description?: string;
    iconLink?: string;
    thumbnailLink?: string;
    imageMediaMetadata?: any;
    parents?: string[];
    dir?: boolean;
    lastmodified?: string | null;
    quota?: { used: number | string; available: number | string } | null;
}

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size?: number | string;
    modifiedTime: string | null;
    description?: string;
    iconLink?: string;
    thumbnailLink?: string;
    imageMediaMetadata?: any;
    parents?: string[];
    dir?: boolean;
    lastmodified?: string | null;
    quota?: { used: number | string; available: number | string } | null;
}
