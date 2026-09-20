# Telegram Transport

Webot can use an authorized Telegram user account through Telethon. The Node.js
service supervises `scripts/telegram_bridge.py`, receives normalized JSON-lines
events, and sends replies through the same process.

## Requirements

- Python 3 with `telethon` installed.
- `TG_API_ID` and `TG_API_HASH`, or protected files/settings containing them.
- A previously authorized Telethon session. The service bridge never prompts
  for a phone number, login code, or two-factor password.

## Configuration

Add `telegram` to `channels` and configure one or more sources:

```json
{
  "channels": ["pad", "telegram"],
  "telegram": {
    "sources": [{
      "id": "telegram",
      "displayName": "Telegram",
      "enabled": true,
      "pythonBin": "/usr/local/bin/python3",
      "sessionPath": "~/.webot/telegram",
      "apiIdEnv": "TG_API_ID",
      "apiHashEnv": "TG_API_HASH",
      "allowSelf": true,
      "trustSelfAsOwner": false,
      "listenSelf": true,
      "ignoreAllowlist": false,
      "allowedChatIds": [],
      "allowedSenderIds": [],
      "blockedChatIds": [],
      "blockedSenderIds": [],
      "triggerKeywords": ["webot"],
      "botNames": ["Webot"]
    }]
  }
}
```

Credentials may also use `apiIdFile` and `apiHashFile`, or inline `apiId` and
`apiHash` in the mode-0600 Webot settings file. Secret fields are redacted by
the admin API.

## Policy

The safe default accepts Saved Messages only. Set `trustSelfAsOwner` only for a
session controlled by the configured owner. Other private chats require their
`tg:<user-id>` in `allowedSenderIds`; groups require their `tg:<chat-id>` in
`allowedChatIds` and still require a configured trigger or bot mention.
Messages from groups outside that allowlist are discarded before database
persistence.

Outbound delivery follows Webot's global `outboundMode`. `dry-run` records the
result without sending. `live` sends text and file attachments through the
originating Telegram session.

## Inbound media and replies

Telegram image messages are first persisted as lightweight attachment metadata
with their chat and message locator. The worker downloads the original image
only when the current case or a referenced/history message needs it, caches it
under Webot's private data directory, and does not store the binary in SQLite.
Telegram reply messages carry their original text and media locator into the
same context. WeChat quoted messages use the persisted original message when it
is available, including its image download context.
