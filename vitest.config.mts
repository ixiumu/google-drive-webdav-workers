import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const compat = {
	compatibilityDate: '2026-04-15',
	kvNamespaces: ['KV'],
};

const davBindings = {
	USERS: JSON.stringify({ test: 'pass' }),
	CLIENT_ID: 'test-client-id',
	CLIENT_SECRET: 'test-client-secret',
	REFRESH_TOKEN: 'test-refresh-token-history',
};

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						main: 'src/worker.ts',
						miniflare: { ...compat, bindings: davBindings },
					}),
				],
				test: { name: 'dav', include: ['test/dav.test.ts'] },
			},
			{
				plugins: [
					cloudflareTest({
						main: 'src/worker.ts',
						miniflare: { ...compat },
					}),
				],
				test: { name: 'auth', include: ['test/auth.test.ts'] },
			},
		],
	},
});