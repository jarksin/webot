# Webot

Webot is a self-hosted personal assistant and digital twin with WeChat and
optional Telegram message ingress and egress.

It provides:

- Isolated cases and persistent Codex sessions for each chat.
- Named, isolated owner sessions controlled with `/session` commands.
- Multi-account WeChat gateway connections.
- Optional Telegram user-account connectivity through an authorized Telethon
  session.
- Automatic or reviewed draft replies.
- Image cards, audio delivery, and confirmed file-card delivery when supported
  by the configured gateway.
- A local knowledge base with public and owner-only audiences.
- A loopback-only administration console.

## Run

Webot requires Node.js 22 or newer.

```bash
npm install
npm run verify
npm start
```

The administration console is available at `http://127.0.0.1:18120`.

For a local service that follows repository changes without rebuilding or
codesigning a standalone executable:

```bash
./scripts/install-launchd.sh
```

The LaunchAgent uses the stable Node.js executable to load `bin/webot.js`
directly. After an owner-authorized worker verifies and commits a source
change, Webot requests guarded activation from the configured external broker.
Set `WEBOT_ACTIVATION_BROKER_URL` to override the local broker endpoint.

Runtime settings, messages, sessions, credentials, and knowledge are stored
outside the source tree in the local Webot data directory. Configure gateway
accounts, assistant providers, reply policy, and knowledge from the console.
New installations start in dry-run mode so outbound messages are not sent until
live mode is explicitly enabled.

In source mode, Codex runs from the Webot repository by default. The private
instance `AGENTS.md`, sessions, database, credentials, and knowledge remain
under the local Webot data directory and are injected without being committed.

Owner control commands include `/session`, `/session list`,
`/session new <name>`, `/session <name>`, `/session delete <name>`,
`/models` (`/modes` alias), `/model`, `/effort`, `/status`, `/clear`, and `/stop`. Named
session metadata and conversation state remain in the local data directory.
New owner messages can steer an active Codex turn. Control commands stay
responsive independently, while `/clear` and `/stop` serialize with the active
worker because they change or terminate its state.

## WeChat Gateway

Webot connects to a separately operated WeChatPad-compatible HTTP and WebSocket
gateway. Each account requires its own account ID and credential. See
[docs/wechatpad-gateway.md](docs/wechatpad-gateway.md).

The gateway is an external component and is not included in this repository.
Webot normalizes inbound events before they reach an assistant provider and
uses the originating account for outbound replies.

## Telegram

Telegram support uses the included Python JSON-lines bridge and an existing,
authorized Telethon session. Install Telethon in the configured Python
environment, configure a Telegram source, and add `telegram` to `channels`.
Saved Messages can be trusted as the owner channel when
`trustSelfAsOwner` is explicitly enabled. Other private chats and groups are
rejected unless their stable Telegram IDs are placed in the source allowlists.
See [docs/telegram.md](docs/telegram.md).

## Architecture

See [docs/architecture.md](docs/architecture.md) for the message, case, worker,
draft, and outbound flow.

## Release

```bash
npm run release
```

Release archives are written to `dist/`. The archive contains the executable,
generic configuration templates, and public documentation only.

## Privacy

This public repository does not include instance databases, message history,
credentials, voice profiles, speech synthesis assets, personal identity data,
or organization-specific integrations. Run `npm run privacy-check` before
publishing changes.
