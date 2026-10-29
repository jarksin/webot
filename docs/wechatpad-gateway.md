# WeChatPad Gateway

Webot connects to a separately operated WeChatPad-compatible gateway. The
gateway handles the WeChat protocol connection; Webot handles message policy,
cases, assistant sessions, knowledge, drafts, and replies.

## Required Settings

Configure each account with:

- A stable account ID such as a `wxid`.
- The gateway HTTP API URL.
- The gateway WebSocket URL.
- An account-scoped access token or a path to a protected token file.
- Optional private-chat, group-chat, mention, and keyword allowlists.

Credentials, gateway sessions, protocol state, and logs are runtime data. Keep
them outside this repository and restrict their filesystem permissions.

## Channel Policy

Each account can be enabled or paused from Settings without deleting its
credentials or account session. Connector changes and controlled reloads wait
until both running tasks and the task queue are empty. New tasks retain priority
while a reload is waiting. Only the final switch briefly reserves scheduling;
an abandoned switch releases that reservation automatically.

`allowlistOnly` prevents private bot-name commands from bypassing the private
allowlist. `keywordOnly` additionally requires a configured summon word in
private and group messages; a mention alone does not trigger a reply.
Both settings are optional and leave existing account behavior unchanged when
disabled. Group allowlists, blacklists and self-chat controls still apply.

`selfChatWithoutPrefix` is an opt-in exception to `keywordOnly` for an account's
own private self-chat. It requires `allowSelf`; associated accounts, other
private chats and groups keep their existing trigger rules. Blacklists and
assistant-echo filtering still apply.

`mentionDisplayNames` maps trusted member IDs to display aliases. In group
replies, an explicit `@alias` in generated text also adds that member to the
gateway's native mention list, alongside the triggering sender. Private replies
and unknown aliases do not create mentions.

## Automatic Friend Acceptance and Red Packets

Each Pad source can opt into `autoAcceptFriends` and `autoReceiveRedPackets`
in Settings JSON. Both default to false. These actions process incoming gateway
events independently of ordinary chat trigger words and allowlists; blocked
senders and blocked chats remain excluded. The source must be enabled and
outbound mode must be live. Other accounts retain their own policies.

Friend acceptance requires a gateway type-37 event with an accept-ready,
persisted `friend_request_id`. Red packets require type-49 app subtype 2001
and the original XML; the receive response supplies the context for opening.
The fixed account-scoped v1 APIs are used through the shared per-source request
queue, including its ten-second minimum interval. The administration console
exposes the two account switches. After successful acceptance or opening,
the assistant receives a confirmed platform event and composes its reply using
the current local AGENTS.md and relevant approved public knowledge. Put tone
and introduction/thanks preferences there; reply text is not a fixed template
or a per-account text setting.

Replies require an explicit successful operation acknowledgement from the
gateway. Friend acceptance must confirm `accepted` for the exact request ID;
red packets must complete opening, not merely return receive parameters.
An empty response, negative acknowledgement, timeout or uncertain result does
not trigger reply generation or sending.

Event composition uses public access, no resumed user session, no chat history,
and no raw friend tickets or packet XML. Only generated text can be sent.
Introductions go privately to the applicant; thanks go to the original
conversation, mentioning the packet sender in a group. The assistant may choose
silence. Generation failure never falls back to a fixed reply, and activation
waits for in-progress reply generation.

Attempts and outcomes are retained in private runtime state and the captured
message decision. Replayed events cannot repeat an attempted operation,
including replies and after reload. Reply delivery is recorded separately from
the successful acceptance or receipt. Failures or uncertain outcomes require inspection of
the gateway operation record before a manual retry. Enabling the policy does
not process old pending friend requests or historical red packets.

## Local Example

A local gateway may expose endpoints similar to:

```text
HTTP: http://127.0.0.1:18102/api
WS:   ws://127.0.0.1:18102/ws/<account-id>
```

Authentication and route details depend on the gateway implementation. Use its
own documentation to obtain credentials and establish the account session.

## Validation

1. Add the account in the Webot administration console.
2. Save the HTTP, WebSocket, account ID, and credential settings.
3. Run the connection check.
4. Keep outbound mode set to dry-run while validating inbound events.
5. Enable live outbound only after verifying the correct account and chat.

Webot sends normalized messages to assistant providers. Raw gateway envelopes
and credentials are not included in assistant prompts.

## Group Support Configuration

An installation can add `groupPolicies` to a Pad source, keyed by exact group
ID. The ordinary source allowlist and blocklist still apply. Each policy supports:

- `listenAll`: accept group questions without a keyword or mention.
- `ignoredSenderIds`: never trigger a reply for these stable sender IDs.
- `mentionOnlySenderIds`: require a mention of the source account from these senders.
- `ignoreAcknowledgements`: ignore standalone closings such as “好的” or “谢谢”; questions and attachments still trigger.
- `humanReplyGraceMs` and `humanReplySenderIds`: wait for a quiet period before
  creating a customer case. A reply from a configured human sender in the same
  source/group cancels the pending messages. Owner requests bypass this wait.
  This grace period replaces the initial batch delay; messages remain in the
  retained stream even when no case is created.
- `batchWindowMs`: collect messages for a fixed window after the first trigger,
  then process all pending messages after the case cursor in one run. Messages
  arriving during a run form the next batch. The deadline survives reloads.
- `supportInstructions`: an owner-authored, limited support delegation. In that
  group Codex receives `support` access, without owner commands, private knowledge
  or local artifact delivery. State exact source/log/account boundaries in the
  installation's private AGENTS.md and policy. Group messages cannot extend them.

`assistant.additionalWorkingDirectories` lists additional repository paths for
workers while preserving the primary working directory. Paths and group/account
identities belong in private settings, not the repository. Directory availability
does not grant a requester permission to read it.
