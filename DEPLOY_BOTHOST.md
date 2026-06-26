# Bothost deploy

Use this repository as the bot root.

Recommended Bothost settings:

- Language/image: `node:20 Debian Slim`
- Custom Dockerfile: enabled
- Branch: `main`
- Start command: leave default when using Dockerfile

Required environment variables:

- `BOT_TOKEN` - Telegram bot token. Bothost can set this automatically.
- `OWNER_ID` - Telegram ID of the bot owner.
- `ADMIN_IDS` - comma-separated admin Telegram IDs, optional.
- `MAIN_CHAT_ID` - allowed group chat ID, optional.
- `DEVELOPER_ID` - developer Telegram ID, optional.
- `DEVELOPER_USERNAME` - support username without secrets, optional.

Database:

- The Dockerfile sets `DATABASE_URL=file:/app/data/flood_games.sqlite`.
- Do not commit SQLite files.
- Bothost keeps `/app/data` between deploys, so balances, promos and purchases survive updates.

Why custom Dockerfile:

- The bot uses `better-sqlite3`, a native Node.js module.
- Debian Slim is safer than Alpine for native modules.
- The Dockerfile builds TypeScript in `/usr/src/app`, not `/app`, because Bothost can mount Git sources over `/app` at runtime.
