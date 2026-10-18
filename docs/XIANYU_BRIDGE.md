# Xianyu Bridge Contract

This optional channel connects an independent Xianyu bridge to Webot. It does
not implement native login, signing, verification, or platform APIs. The bridge
owns native IPA login and account verification and must refuse unverified sends.
No browser or web-login dependency is required by this channel. Native network
operations must remain disabled until the independent adapter has original-backed
login wire evidence. This integration alone, including passing offline tests,
is not evidence of a logged-in Xianyu account or live message delivery.

## Configuration

The default is disabled: `channels` does not contain `xianyu`, and
`xianyu.sources` is empty. Enabling requires both `channels: ["xianyu"]` (alongside
any existing channels) and an explicitly enabled source:

```json
{
  "xianyu": {
    "sources": [{
      "id": "shop",
      "enabled": true,
      "bridgeUrl": "http://127.0.0.1:19090",
      "accountId": "seller",
      "secretEnv": "XIANYU_BRIDGE_SECRET"
    }]
  }
}
```

Use `secretEnv` or `secretFile`, never an inline `secret`. A file must be a
regular, nonsymlink file owned by the process user with no group/other access
(for example mode 0600). A nonempty environment value takes precedence over
the file. Runtime `config.xianyu.sources[].secret` is resolved in memory;
serialization persists references, not resolved credentials. Every configured
source requires a nonempty resolved secret, including disabled sources.
Source IDs are unique case-insensitively. `bridgeUrl` must be an HTTPS origin,
or loopback HTTP origin, without credentials, path, query, or fragment.
No event-supplied callback URL is accepted; redirects are forbidden.

## Ingress

`POST /webhooks/xianyu/:sourceId`, UTF-8 JSON. Header
`x-webot-signature: sha256=<hex HMAC-SHA256 of exact raw body with source secret>`.
The verifier also accepts bare hexadecimal and case-insensitive hex.
The exact event fields are:

```json
{
  "messageId": "incoming-1",
  "chatId": "conversation-1",
  "senderId": "buyer",
  "accountId": "seller",
  "text": "Hello",
  "timestamp": 1792278000000,
  "direction": "incoming",
  "type": "text"
}
```

The timestamp above is illustrative; send current Unix time in **milliseconds**,
as a JSON safe integer. Accepted age is at most 300 seconds, future skew at most
30 seconds. IDs are strings of 1-160 ASCII letters, digits, `.`, `_`, `:`, `@`,
or `-`; numeric IDs must not be JSON numbers. Text must be nonempty and at most
8000 JavaScript UTF-16 code units (`text.length`). Outgoing text is limited to
4000 code units. A surrogate pair counts as two units. These are local bridge
admission limits, not claims about the native Xianyu protocol. Source IDs allow
1-160 ASCII letters, digits, `.`, `_`, or `-`. HTTP ingress bodies are limited
to 128 KiB. Unknown fields are rejected.

The account must match the configured source exactly. Outgoing, self, nontext,
and system events are rejected; the bridge must not turn system events into
ordinary user text. `system`, `notification`, and `service` sender IDs are
reserved. Sender IDs are always public requesters, even when they match owner
IDs. Attachments are unsupported. Customer text is not stripped of bot prefixes.

`202 {"ok":true,"results":[{"accepted":true}]}` means ingested, **not replied**.
A repeated event returns `202` with
`{"ok":true,"results":[{"accepted":false,"reason":"duplicate"}]}`.
CaseManager dedupe is persisted across restarts. Invalid signatures return 401,
invalid/expired events 400, unknown sources 404, disabled source/channel 503.

Internal IDs are percent-encoded, colon-joined namespaces including source,
account, chat, and message as appropriate. Cases are isolated by channel,
source, account, and chat. Native IDs are retained only as bridge routing
metadata, never interpreted as WeChat or Telegram identities.

## Outbound

`POST <bridgeUrl>/v1/messages/send`, UTF-8 JSON, with the same signature scheme:

```json
{
  "requestId": "xianyu-<64 lowercase SHA256 hex characters>",
  "sourceId": "shop",
  "accountId": "seller",
  "chatId": "conversation-1",
  "inReplyTo": "incoming-1",
  "text": "Reply"
}
```

`requestId` is `xianyu-` plus SHA256 of UTF-8 `JSON.stringify` of the object
`{sourceId,accountId,chatId,inReplyTo,text}` in that field order, without spaces.
Retries of the same triggering message and exact reply reuse the ID, including
after a restart; changed text or routing yields a different ID. The bridge must
deduplicate by requestId and return the original sent receipt when known.
Webot revalidates the original IDs and requires a positive safe-integer
millisecond timestamp. Timestamps more than 30 seconds in the future are rejected.
The bridge only replies to a persistently received fresh incoming message,
with a 5-minute message TTL and at most one reply per incoming message.
An ambiguous native send must remain durably `unknown`, never retried.
Request timeout is 30 seconds.

Only an HTTP success response with
`{"ok":true,"status":"sent","messageId":"native-id"}` confirms delivery.
`messageId` follows the string ID rules above. A queued, missing, failed, or
malformed receipt leaves the draft unconfirmed. Bridge bodies/errors
are not logged or persisted; only allowlisted receipt fields are retained.
There is no automatic resend after an ambiguous bridge response. A manual
submission of the same requestId must not cause the bridge to retry an unknown
native send. Changed draft text must not bypass its one-reply restriction.
Webot serializes outbound requests per source without retrying a failed request.
Channel/source enablement, credentials, routing, and event age are checked at
dispatch, after waiting for preceding requests.

### Stale Receipt Lookup

When an incoming message is more than 300 seconds old, Webot sends the exact
same canonical payload and HMAC to `POST <bridgeUrl>/v1/messages/receipt`,
**never** to `/v1/messages/send`. This signed endpoint is read-only: it returns
only the existing matching `{"ok":true,"status":"sent","messageId":"native-id"}`
receipt, including after logout, auto-reply disablement, or TTL expiry.
The Webot channel/source must still be enabled and authenticated.

No record returns HTTP 409 `receipt_not_found`; a durable unknown result returns
409 `send_outcome_unknown`; a mismatched payload returns a conflict. Errors,
missing receipts, and unconfirmed responses leave the draft unconfirmed.
Webot never falls back from lookup to sending and does not automatically retry.
The same payload keeps the same requestId across transport/process recreation.
Successful lookup can reconcile an unsent local draft after a lost acknowledgement,
but does not update the observed recent-send time.

Dry-run performs neither send nor receipt requests and leaves the draft unsent. Changing to
live mode does not automatically send existing dry-run drafts.
Health reports webhook readiness and observed inbound/sent times separately;
`connected:null` and `loginState:"unverified"` intentionally make no claim about
native login, bridge connectivity, or current account liveness.
