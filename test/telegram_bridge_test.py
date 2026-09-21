"""Offline Telegram ingress tests; no session or Telethon installation needed."""

import asyncio
from collections import Counter
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest

telethon = ModuleType("telethon")
telethon.TelegramClient = object
telethon.events = SimpleNamespace()
sys.modules["telethon"] = telethon
spec = importlib.util.spec_from_file_location(
    "telegram_bridge",
    Path(__file__).resolve().parents[1] / "scripts" / "telegram_bridge.py",
)
bridge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_module)


class SelfSummonTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.emitted = []
        bridge_module.emit = self.emitted.append
        self.bridge = object.__new__(bridge_module.Bridge)
        self.bridge.self_id = 42
        self.bridge.self_username = "owner"
        self.bridge.args = SimpleNamespace(listen_self=True)
        self.bridge.pending_outbound = Counter()
        self.bridge.self_command_prefixes = ["Webot", "助手"]

    def event(self, text="@webot help", chat=99, sender=42, private=True, out=True):
        async def get_sender():
            return SimpleNamespace(first_name="Sender")

        async def get_chat():
            return SimpleNamespace(first_name="Peer")

        return SimpleNamespace(
            chat_id=chat, sender_id=sender, out=out, raw_text=text,
            is_private=private, is_group=not private, is_channel=False,
            message=SimpleNamespace(id=7, date=datetime.now(timezone.utc)),
            get_sender=get_sender, get_chat=get_chat,
        )

    async def test_self_private_summon_is_emitted_with_real_identity_and_target(self):
        await self.bridge.on_message(self.event())
        self.assertEqual(len(self.emitted), 1)
        event = self.emitted[0]
        self.assertEqual(event["sender_id"], "tg:42")
        self.assertEqual(event["chat_id"], "tg:99")
        self.assertEqual(event["reply_target"], "tg:99")
        self.assertEqual(event["direction"], "outgoing")
        self.assertFalse(event["exact_self_chat"])
        self.assertFalse(event["self_conversation"])

    async def test_ordinary_outgoing_and_near_matches_are_not_captured(self):
        for text in ["hello", "ask @webot later", "@webotany help", "【AI】@webot help"]:
            await self.bridge.on_message(self.event(text=text))
        self.assertEqual(self.emitted, [])

    async def test_groups_other_senders_and_disabled_self_listening_are_rejected(self):
        await self.bridge.on_message(self.event(private=False))
        await self.bridge.on_message(self.event(sender=12))
        self.bridge.args.listen_self = False
        await self.bridge.on_message(self.event())
        self.assertEqual(self.emitted, [])

    async def test_bridge_reply_is_not_reingested(self):
        self.bridge.pending_outbound[("99", "@webot help")] = 1
        await self.bridge.on_message(self.event())
        self.assertEqual(self.emitted, [])
        self.assertEqual(self.bridge.pending_outbound, {})

    async def test_saved_messages_and_incoming_private_messages_keep_working(self):
        await self.bridge.on_message(self.event(text="hello", chat=42))
        await self.bridge.on_message(self.event(text="hello", sender=99, out=False))
        self.assertEqual(len(self.emitted), 2)
        self.assertTrue(self.emitted[0]["exact_self_chat"])
        self.assertEqual(self.emitted[1]["direction"], "incoming")

    async def test_custom_prefix_and_reply_context(self):
        event = self.event(text="助手：看看这个")
        async def get_sender():
            return SimpleNamespace(first_name="Peer")
        reply = SimpleNamespace(
            id=6, sender_id=99, raw_text="context", get_sender=get_sender,
        )
        async def get_reply_message():
            return reply
        event.message.reply_to = 6
        event.message.get_reply_message = get_reply_message
        await self.bridge.on_message(event)
        self.assertEqual(self.emitted[0]["reference"]["text"], "context")
        self.assertEqual(self.emitted[0]["reference"]["sender_id"], "tg:99")


if __name__ == "__main__":
    unittest.main()
