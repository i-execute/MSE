"""TUI applies the chosen model through the running router; no live server required."""
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch, MagicMock
from contextlib import nullcontext

path = Path(__file__).resolve().parents[1] / 'Server/stack/mse_setup.py'
spec = importlib.util.spec_from_file_location('mse_setup', path)
m = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = m
spec.loader.exec_module(m)
seen = []

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'models': ['live-one', 'live-two']}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        seen.append((self.path, body, self.headers.get('x-admin-token')))
        self.send_response(400 if body.get('model') == 'unoffered' else 200)
        self.end_headers()
        self.wfile.write(b'{}')
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    setup = m.Setup(env={'MSE_PORT': str(server.server_port), 'MSE_ADMIN_TOKEN': 'test-token'})
    captured = []
    def capture(editor):
        captured.extend(editor.fields)
        return False
    with patch.object(m.FieldEditor, 'ask', capture):
        assert setup.ask_settings() is False
    model_field = captured[0]
    assert model_field.choices == ['live-one', 'live-two'], model_field.choices
    editor = m.FieldEditor('model', [model_field])
    box = MagicMock()
    with patch.object(m, 'tty_stream', return_value=sys.stdin), patch.object(m, 'has_tty', return_value=True), \
         patch.object(m, 'fd_is_tty', return_value=True), patch.object(m, 'CbreakSession', return_value=nullcontext()), \
         patch.object(m, 'LiveBox', return_value=box), patch.object(m, 'hide_cursor'), \
         patch.object(m, 'next_interactive_key', side_effect=['space', 'tab', 'tab', 'enter', 'enter']):
        assert editor.ask()
    assert model_field.value == 'live-two', model_field.value
    setup.settings.update({'MODEL': 'live-model', 'QUOTA': '12'})
    with patch.object(m.subprocess, 'run'):
        ok, message = setup.push_settings()
    assert ok, message
    assert seen == [('/admin/quota', {'quota': 12}, 'test-token'), ('/admin/dump-quota', {'dumpQuota': 0}, 'test-token'), ('/admin/model', {'model': 'live-model'}, 'test-token')], seen
    setup.settings['MODEL'] = 'unoffered'
    with patch.object(m.subprocess, 'run'):
        ok, message = setup.push_settings()
    assert not ok and 'model not accepted' in message, message
    print('PASS: TUI loads live model choices, cycles them, applies and reports rejection')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
