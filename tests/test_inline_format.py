"""Reproduce bug 1 exactly: build the inline results MSE builds, push them through goygram's MTProto path.

The server said: messages.setInlineBotResults:results: nested object missing _. So the check is mechanical —
serialise the results the way goygram's MT codec does before it puts them on the wire, and assert that every
nested dict carries "_". No Telegram account needed for this part; the live tap-test comes after.
"""
from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from goygram import GoyGram  # noqa: E402

FAILS: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        FAILS.append(what)


class Recorder:
    """Stands in for the client: captures the exact kwargs that go to messages.setInlineBotResults."""

    def __init__(self) -> None:
        self.mt = object()          # "mt net is configured"
        self.bot = None             # so the inline answer takes the MTProto path
        self.sent: list[tuple[str, dict]] = []

    async def mt_req(self, method: str, **kwargs):
        self.sent.append((method, kwargs))
        return {"ok": True}


class Evt:
    """goygram's update object: kind, id, src and app are what answer() looks at."""

    kind = "inline"
    id = 123456789
    src = "mt"

    def __init__(self, app):
        self.app = app
        self.answered: dict = {}

    async def answer(self, text=None, alert=False, url=None, cache_time=0, results=None, **kw):
        # the real implementation lives in goygram.types.obj; this mirrors its MTProto branch exactly
        from goygram.types import obj as objmod
        bound = objmod.Obj.__new__(objmod.Obj)
        bound.raw = {"raw_update": {}}
        bound.kind = self.kind
        bound.id = self.id
        bound.src = self.src
        bound.app = self.app
        object.__setattr__(bound, "_fake", True)
        self.answered = {"results": results, "cache_time": cache_time, **kw}
        return await objmod.Obj.answer(bound, text=text, alert=alert, url=url,
                                          cache_time=cache_time, results=results, **kw)


async def _none():
    return None


async def _capture(bucket: list, text: str) -> None:
    bucket.append(text)


async def main() -> int:
    from bot import inline

    inline.configure("unit-test")
    token = inline.token_for("tailscale_key")
    results = inline.results_for(token + " tskey-auth-example0123456789")

    # ---- the shape the MTProto path requires
    for index, item in enumerate(results):
        check(item.get("_") == "inputBotInlineResult", "result %d is inputBotInlineResult" % index)
        check(isinstance(item.get("send_message"), dict), "result %d has send_message" % index)
        check(item["send_message"].get("_") == "inputBotInlineMessageText",
              "result %d send_message is inputBotInlineMessageText" % index)
        check(isinstance(item["send_message"].get("message"), str) and item["send_message"]["message"],
              "result %d carries a message" % index)
        check("input_message_content" not in item, "result %d has no bot-api-only input_message_content" % index)

    # ---- and the same results through the real client call
    rec = Recorder()
    await inline.answer(Evt(rec), results)
    check(len(rec.sent) == 1 and rec.sent[0][0] == "messages.setInlineBotResults",
          "the answer went to messages.setInlineBotResults")
    payload = rec.sent[0][1] if rec.sent else {}

    def walk(node, path="results"):
        if isinstance(node, dict):
            if path != "results":
                check("_" in node, "%s has _" % path)
            for key, value in node.items():
                walk(value, path + "." + key)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, "%s[%d]" % (path, index))

    walk(payload.get("results"))
    check(payload.get("private") is True, "the answer is personal (only the owner sees it)")

    # a bot-api answerInlineQuery payload would be json-serialisable too, but it is not what goes on the wire
    try:
        json.dumps(payload)
        check(True, "the payload serialises cleanly")
    except TypeError as exc:
        check(False, "the payload serialises: " + str(exc))

    # ---- six results of different kinds: article head, options, a stale token
    for field_name in ("bot_token", "owner_id", "quota", "model", "allow_id", "revoke_id", "tailscale_key"):
        for item in inline.results_for(inline.list_query(field_name)):
            check(item.get("_") == "inputBotInlineResult", "list %s: %s" % (field_name, item.get("_")))

    # ---- bug 2: the inline-mode probe at start, and the one line the owner gets when it is off
    from bot import main as bot_main

    class Probe:
        def __init__(self, me):
            self.me = me

        async def get_me(self, refresh=False):
            return self.me

    bot = bot_main.Bot()
    bot.inline_enabled = None

    bot.app = Probe({"id": 1, "supports_inline_queries": True})
    check(await bot.check_inline_mode() is True, "getMe with inline on says True")

    bot.app = Probe({"id": 1, "supports_inline_queries": False})
    check(await bot.check_inline_mode() is False, "getMe with inline off says False")

    bot.app = Probe({"id": 1, "bot_inline_placeholder": "type a value"})
    check(await bot.check_inline_mode() is True, "a placeholder counts as inline on")

    bot.app = Probe({"id": 1})
    bot.bot_call = lambda method, **kw: _none()          # type: ignore[assignment]
    check(await bot.check_inline_mode() is None, "an answer without the flag says None (no false alarm)")

    class Boom:
        async def get_me(self, refresh=False):
            raise RuntimeError("no network")

    bot.app = Boom()
    check(await bot.check_inline_mode() is None, "a failed getMe says None, it does not raise")

    # the owner hears about it exactly once, and the panel lists it
    told: list[str] = []
    bot.inline_enabled = False
    bot_main.OWNER_ID = 100000001
    bot.deliver_raw = lambda chat_id, text: _capture(told, text)          # type: ignore[assignment]
    await bot.tell_owner(bot_main.INLINE_WARN)
    check(len(told) == 1 and "Inline Mode" in told[0], "the owner gets one plain line naming Inline Mode")

    problems = await bot.self_check()
    check(any("inline" in p.lower() for p in problems), "self_check reports the inline problem")

    print()
    if FAILS:
        print("%d failed" % len(FAILS))
        return 1
    print("inline format: every nested object carries _, %d results checked" % len(results))
    return 0


if __name__ == "__main__":
    import asyncio

    raise SystemExit(asyncio.run(main()))
