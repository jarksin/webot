# Architecture

## Message Flow

```text
gateway WebSocket -> normalize -> identity directory -> policy -> SQLite message
                                      |
                         owner named-session routing
                                      |
                                      v
                                    Case
                                      |
                                      v
                              worker/session queue
                                      |
                                      v
                                    draft
                                      |
                         manual send or automatic send
                                      |
                                      v
                              gateway outbound
```

Adapters convert protocol-specific events into this internal shape:

```json
{
  "transport": "pad",
  "sourceId": "main",
  "messageId": "123",
  "timestamp": 1770000000000,
  "chatType": "private",
  "chatId": "wxid_peer",
  "senderId": "wxid_peer",
  "senderName": "Peer",
  "selfId": "wxid_bot",
  "text": "hello",
  "mentions": []
}
```

Raw envelopes are not sent to the assistant backend. Normalized messages,
Cases, worker sessions, progress events, drafts, and send results are persisted
in `webot.sqlite`. Bounded assistant history remains in the session directory.
The indexed identity directory records observed user and group IDs before
trigger filtering. An explicit read-only gateway sync can enrich those entries
with contact remarks, nicknames, aliases, and group names.

Source deployments run Codex from the Webot repository so engineering tasks see
the same code, Git state, and repository instructions as the service itself.
Instance-specific identity and permissions remain in the private Webot data
directory and are injected into every Codex turn; they are not committed to the
source repository.

## Runtime Controls

- `WEBOT_CHANNELS` selects which connectors start.
- `WEBOT_OUTBOUND_MODE` gates all sends; only `live` performs network writes.
- Per-account chat and sender allowlists narrow accepted traffic. Per-account
  sender and group blacklists always take precedence, including when allowlist
  checks are bypassed.
- A Case never runs two workers concurrently; new inbound during a run schedules
  one follow-up pass over the latest persisted context.
- Every accepted message updates a stable account-scoped Case. Owner-created
  named sessions route subsequent messages into independent child Cases.
- Named sessions isolate bounded history, Codex continuation, model selection,
  and reasoning effort while keeping all metadata in local SQLite state.
- Worker execution and draft sending are separate persisted stages.
- Workers can be paused globally, rerun per Case, or stopped while active.
- Drafts can be sent automatically or reviewed and sent from the Case console.
- The Case console uses independently scrolling list and detail panes. Case
  summaries are paginated, while messages, drafts, and progress are loaded in a
  bounded window and expanded only on demand.
- Gateway queues and history keys include the source-defined conversation id.
- Multi-account replies resolve credentials from the originating source.
- Self-account pairs have explicit per-direction ingress permission.
- The AI echo marker is emitted only for same-account private self replies.
- A SQLite unique constraint suppresses repeated delivery of the same source
  event.

## Connector Boundary

Webot intentionally does not package a client hook or WeChatPad gateway. These
components are version-sensitive and may have separate licensing and account
risk. They connect to Webot through explicit HTTP/WebSocket contracts.

## Production Checklist

1. Bind Webot and upstream APIs to loopback or a trusted private network.
2. Set callback secrets and upstream Access Codes.
3. Set explicit chat or sender allowlists.
4. Validate inbound events with `WEBOT_OUTBOUND_MODE=dry-run`.
5. Back up the state directory.
6. Enable `live` outbound only after account-side verification.
