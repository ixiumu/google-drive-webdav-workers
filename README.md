# GDrive WebDAV Worker

A Cloudflare Workers script that transforms Google Drive into a fully functional WebDAV server. 

## Features

- **WebDAV Support**: Mount your Google Drive in Windows Explorer, macOS Finder, Infuse, and other DAV clients.
- **High Performance**: Leverages Cloudflare Workers and optional KV caching for minimal latency.
- **Resumable Uploads**: Supports the Google Drive Resumable API for reliable file transfers.
- **Multi-Status Support**: Full implementation of WebDAV protocols (PROPFIND, MKCOL, MOVE, COPY, etc.).
- **Environment Variables**: Configure your worker securely without modifying the source code.

## Quick Start

1. **Get Google Credentials & Refresh Token**:
   
   - **Method A: Use Default rclone Credentials (Easiest, but unstable)**
     If you use the `rclone` CLI tool to authorize Google Drive without providing a Client ID, it uses rclone's shared credentials by default. 
     *⚠️ Warning:* Because these credentials are shared globally among all rclone users, they frequently trigger Google's API rate limits (429 Too Many Requests). Your WebDAV server might become temporarily unavailable.

   - **Method B: Use Your Own Client ID (Highly Recommended for stability)**
     To avoid rate limits and ensure stable mounting, you should create your own credentials and use the `rclone` desktop app to extract the refresh token:
     1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google Drive API**.
     2. Create an **OAuth 2.0 Client ID** (select "Desktop app" as the application type) to get your `client_id` and `client_secret`.
     3. Download and install [rclone](https://rclone.org/downloads/) on your local computer.
     4. Open your terminal/command prompt and run `rclone config`.
     5. Create a new remote (press `n`), give it a name, and choose `drive` as the storage type.
     6. When prompted, explicitly paste your newly created `client_id` and `client_secret`.
     7. Follow the prompts to authenticate via your web browser.
     8. Once completed, open your `rclone.conf` file (you can find its location by running `rclone config file`) and copy the `refresh_token`.

2. **Deploy to Cloudflare**:
   - Create a new Worker and paste the `dist/worker.js` code.
   - **Recommended:** Configure your credentials and settings using Environment Variables (see section below) instead of modifying the `dist/worker.js` file directly.

3. **(Optional) KV Caching**:
   - Create a KV Namespace named `KV`.
   - Bind it to your Worker in "Settings -> Variables -> KV Namespace Bindings".

## Environment Variables (Recommended)

Instead of hardcoding your sensitive information and configurations in the `worker.js` file, you can set them securely via the Cloudflare Dashboard (**Settings -> Variables -> Environment Variables**). 

The Worker supports the following variables:

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `CLIENT_ID` | **Yes** | Google Cloud OAuth client id. | `*.apps.googleusercontent.com` |
| `CLIENT_SECRET` | **Yes** | Google Cloud OAuth client secret . | `GOCSPX-...` |
| `REFRESH_TOKEN` | **Yes** | Your Google Drive API Refresh Token. | `1//04x...` |
| `USERS` | **Yes** | A JSON formatted string containing your WebDAV usernames and passwords. | `{"admin": "mypassword"}` |
| `ROOT_ID` | No | Specific Google Drive Folder ID to mount as root. Defaults to your entire drive. | `1B2a_xYz...` |
| `NAME` | No | Display name for the web interface. | `My Cloud Drive` |
| `COPYRIGHT` | No | Copyright text displayed in the footer. | `@ixiumu` |
| `COPYRIGHT_LINK` | No | URL link for the copyright text. | `https://github.com/...` |

*Note: If you configure these environment variables, they will automatically override the default values inside the `config` object in the script.*

## Authentication

- **WebDAV**: Access requires the username and password defined in your `USERS` environment variable or the `config.users` object.