# GDrive WebDAV Worker

A Cloudflare Workers script that transforms Google Drive into a fully functional WebDAV server. 

## Features

- **WebDAV Support**: Mount your Google Drive in Windows Explorer, macOS Finder, Infuse, and other DAV clients.
- **High Performance**: Leverages Cloudflare Workers and optional KV caching for minimal latency.
- **Resumable Uploads**: Supports the Google Drive Resumable API for reliable file transfers.
- **Multi-Status Support**: Full implementation of WebDAV protocols (PROPFIND, MKCOL, MOVE, COPY, etc.).

## Quick Start

1. **Get Google Credentials**:
   - By default, this project uses **rclone's built-in credentials**. You only need to apply for a personal Google Client ID if specifically required.
   - If using personal credentials: Enable "Google Drive API" in [Google Cloud Console](https://console.cloud.google.com/), create OAuth 2.0 Client IDs, and obtain your `client_id` and `client_secret`.
   - Obtain your `refresh_token` (this is always required).

2. **Deploy to Cloudflare**:
   - Create a new Worker.
   - Paste the `worker.js` code.
   - Fill in your credentials in the `config` object at the top.

3. **(Optional) KV Caching**:
   - Create a KV Namespace named `KV`.
   - Bind it to your Worker in "Settings -> Variables".

## Authentication

- **WebDAV**: Access via the `/dav/` path. Requires the username and password defined in `config.users`.
