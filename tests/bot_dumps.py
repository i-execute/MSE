#!/usr/bin/env python3
from __future__ import annotations
import asyncio, io, json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'Server'))
from bot import main, screens

class Gateway:
    def dump(self, ident):
        assert ident == 'a'*32
        return {'dump': {'type':'report', 'moodleId':'44', 'dump':{'question':'fixture'}}}
    def dumps(self):
        return {'dumps':[{'id':'a'*32,'type':'report','moodleId':'44','deviceId':'mse-device','at':'2026-01-01'}]}

sent=[]
class Resp:
    def __enter__(self): return io.BytesIO(b'{"ok":true}')
    def __exit__(self,*_): pass

def transport(req, timeout):
    assert timeout == 30
    sent.append(req.data)
    return Resp()

async def go():
    main.OWNER_ID=123; main.OWNER_USERNAME='owner'; main.BOT_TOKEN='test-only-token'
    assert main.is_owner(type('E',(),{'from_id':123})())
    assert not main.is_owner(type('E',(),{'from_id':124,'from_user':{'username':'owner'}})())
    b=main.Bot();b.gw=Gateway(); rendered=[];b.sink=lambda msg,html:rendered.append(html)
    await b.show_dumps(123)
    assert 'get dump' in rendered[0] and 'dump:get:'+'a'*32 in rendered[0]
    main.urllib.request.urlopen=transport
    await b.send_dump('a'*32)
    assert len(sent)==1 and b'filename="mse-dump.txt"' in sent[0] and b'fixture' in sent[0]
    assert b'\r\n\r\n123\r\n' in sent[0]
    print('PASS bot: list, owner-only document transport, ID priority')
asyncio.run(go())
