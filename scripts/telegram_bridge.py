#!/usr/bin/env python3
"""Telethon JSON-lines bridge used by Webot's optional Telegram transport."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from telethon import TelegramClient, events


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def display_name(entity: Any) -> str:
    title = str(getattr(entity, "title", "") or "").strip()
    if title:
        return title
    first = str(getattr(entity, "first_name", "") or "").strip()
    last = str(getattr(entity, "last_name", "") or "").strip()
    name = " ".join(part for part in (first, last) if part)
    return name or str(getattr(entity, "username", "") or "").strip()


def peer_id(value: Any) -> str:
    return f"tg:{int(value)}"


def raw_peer_id(value: str) -> int | str:
    candidate = str(value or "").strip()
    if candidate.startswith("tg:"):
        candidate = candidate[3:]
    if re.fullmatch(r"-?\d+", candidate):
        return int(candidate)
    return candidate


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        api_id = os.getenv("TG_API_ID", "").strip()
        api_hash = os.getenv("TG_API_HASH", "").strip()
        if not api_id or not api_hash:
            raise RuntimeError("TG_API_ID and TG_API_HASH are required")
        self.args = args
        self.client = TelegramClient(args.session, int(api_id), api_hash)
        self.self_id = 0
        self.self_username = ""
        self.pending_outbound: Counter[tuple[str, str]] = Counter()

    async def start(self) -> None:
        await self.client.connect()
        if not await self.client.is_user_authorized():
            raise RuntimeError(
                "Telegram session is not authorized; authorize it interactively first"
            )
        me = await self.client.get_me()
        self.self_id = int(me.id)
        self.self_username = str(getattr(me, "username", "") or "").lower()
        emit({
            "type": "ready",
            "self_id": peer_id(self.self_id),
            "account_type": "bot" if getattr(me, "bot", False) else "user",
        })
        if self.args.check:
            await self.client.disconnect()
            return
        self.client.add_event_handler(self.on_message, events.NewMessage())
        await asyncio.gather(
            self.command_loop(),
            self.client.run_until_disconnected(),
        )

    async def on_message(self, event: Any) -> None:
        chat_id = int(event.chat_id or 0)
        text = str(event.raw_text or "").strip()
        if not chat_id or not text:
            return
        key = (str(chat_id), text)
        if event.out:
            if self.pending_outbound[key] > 0:
                self.pending_outbound[key] -= 1
                if self.pending_outbound[key] <= 0:
                    self.pending_outbound.pop(key, None)
                return
            if not self.args.listen_self or chat_id != self.self_id:
                return

        sender = await event.get_sender()
        chat = await event.get_chat()
        sender_id = int(event.sender_id or self.self_id)
        is_group = bool(event.is_group or event.is_channel)
        mentions: list[str] = []
        if (
            self.self_username
            and re.search(
                rf"(?<![A-Za-z0-9_])@{re.escape(self.self_username)}\b",
                text,
                re.IGNORECASE,
            )
        ):
            mentions.append(peer_id(self.self_id))
        exact_self = chat_id == self.self_id and sender_id == self.self_id
        raw_message_id = int(event.message.id)
        emit({
            "type": "message",
            "message_id": f"{chat_id}:{raw_message_id}",
            "telegram_message_id": raw_message_id,
            "timestamp": int(event.message.date.timestamp() * 1000),
            "direction": "outgoing" if event.out else "incoming",
            "chat_type": "group" if is_group else "private",
            "chat_id": peer_id(chat_id),
            "chat_name": display_name(chat),
            "sender_id": peer_id(sender_id),
            "sender_name": display_name(sender),
            "self_id": peer_id(self.self_id),
            "text": text,
            "mentions": mentions,
            "self_conversation": exact_self,
            "exact_self_chat": exact_self,
            "reply_target": peer_id(chat_id),
        })

    async def command_loop(self) -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                await self.client.disconnect()
                return
            try:
                command = json.loads(line)
                await self.handle_command(command)
            except Exception as error:
                command_id = ""
                try:
                    command_id = str(json.loads(line).get("id", ""))
                except Exception:
                    pass
                emit({
                    "type": "response",
                    "id": command_id,
                    "ok": False,
                    "error": str(error),
                })

    async def handle_command(self, command: dict[str, Any]) -> None:
        command_id = str(command.get("id", ""))
        action = str(command.get("action", ""))
        chat_id = raw_peer_id(str(command.get("chat_id", "")))
        if not command_id or not chat_id:
            raise ValueError("command id and chat_id are required")
        entity: Any = "me" if chat_id == self.self_id else chat_id
        if action == "send_message":
            text = str(command.get("text", ""))
            if not text:
                raise ValueError("text is required")
            key = (str(chat_id), text.strip())
            self.pending_outbound[key] += 1
            try:
                message = await self.client.send_message(
                    entity,
                    text,
                    reply_to=command.get("reply_to") or None,
                )
            except Exception:
                self.pending_outbound[key] -= 1
                if self.pending_outbound[key] <= 0:
                    self.pending_outbound.pop(key, None)
                raise
        elif action == "send_file":
            file_path = Path(str(command.get("path", ""))).expanduser()
            if not file_path.is_file():
                raise ValueError("file does not exist")
            message = await self.client.send_file(
                entity,
                str(file_path),
                caption=str(command.get("caption", "")) or None,
                reply_to=command.get("reply_to") or None,
            )
        else:
            raise ValueError(f"unsupported action: {action}")
        emit({
            "type": "response",
            "id": command_id,
            "ok": True,
            "message_id": int(message.id),
            "sent_at": int(time.time() * 1000),
        })


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--session",
        default=os.getenv("TG_SESSION_PATH", "~/.webot/telegram"),
    )
    parser.add_argument(
        "--listen-self",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    args.session = str(Path(args.session).expanduser())
    return args


async def main() -> None:
    bridge = Bridge(parse_args())
    await bridge.start()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        raise
