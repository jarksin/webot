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


def image_descriptor(message: Any) -> dict[str, Any] | None:
    file = getattr(message, "file", None)
    mime = str(getattr(file, "mime_type", "") or "").strip().lower()
    if not getattr(message, "photo", None) and not mime.startswith("image/"):
        return None
    name = str(getattr(file, "name", "") or "").strip()
    extension = str(getattr(file, "ext", "") or "").strip()
    if not name:
        name = f"telegram-image{extension or '.jpg'}"
    return {
        "kind": "image",
        "filename": name,
        "size": int(getattr(file, "size", 0) or 0),
        "mime": mime or "image/jpeg",
    }


def reference_descriptor(
    message: Any,
    chat_id: int,
    sender: Any = None,
) -> dict[str, Any]:
    image = image_descriptor(message)
    raw_text = str(message.raw_text or "").strip()
    message_id = int(message.id)
    return {
        "message_id": message_id,
        "telegram_message_id": message_id,
        "sender_id": peer_id(int(message.sender_id or 0)) if message.sender_id else "",
        "sender_name": display_name(sender or getattr(message, "sender", None)),
        "text": raw_text or ("[图片]" if image else ""),
        "attachments": [
            {
                **image,
                "download_context": {
                    "type": "telegram",
                    "chat_id": peer_id(chat_id),
                    "message_id": message_id,
                },
            }
        ] if image else [],
    }


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
        image = image_descriptor(event.message)
        if not chat_id or (not text and not image):
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
        reply = None
        reply_sender = None
        if getattr(event.message, "reply_to", None):
            try:
                reply = await event.message.get_reply_message()
                reply_sender = await reply.get_sender() if reply else None
            except Exception:
                reply = None
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
            "text": text or "[图片]",
            "attachments": [
                {
                    **image,
                    "download_context": {
                        "type": "telegram",
                        "chat_id": peer_id(chat_id),
                        "message_id": raw_message_id,
                    },
                }
            ] if image else [],
            "mentions": mentions,
            "self_conversation": exact_self,
            "exact_self_chat": exact_self,
            "reply_target": peer_id(chat_id),
            "reference": reference_descriptor(reply, chat_id, reply_sender) if reply else None,
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
        elif action == "download_media":
            output = Path(str(command.get("path", ""))).expanduser()
            message_id = int(command.get("message_id") or 0)
            if not message_id or not str(output):
                raise ValueError("message_id and path are required")
            message = await self.client.get_messages(entity, ids=message_id)
            if not message:
                raise ValueError("Telegram message was not found")
            if not image_descriptor(message):
                raise ValueError("Telegram message does not contain an image")
            output.parent.mkdir(parents=True, exist_ok=True)
            downloaded = await message.download_media(file=str(output))
            if not downloaded or not output.is_file():
                raise ValueError("Telegram image download returned no file")
            file = getattr(message, "file", None)
            emit({
                "type": "response",
                "id": command_id,
                "ok": True,
                "path": str(output),
                "filename": output.name,
                "mime": str(getattr(file, "mime_type", "") or "image/jpeg"),
                "size": output.stat().st_size,
                "message_id": message_id,
                "sent_at": int(time.time() * 1000),
            })
            return
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
