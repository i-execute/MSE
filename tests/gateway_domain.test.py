"""Tests for MSE Gateway Domain and Cloudflared/Tailscale tunnel logic."""
import subprocess
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TUNNEL_SCRIPT = ROOT / "Server" / "stack" / "mse-tunnel.sh"

def test_tunnel_status_json():
    env = dict(os.environ, MSE_STATE_DIR="/tmp/mse-test-state")
    proc = subprocess.run(["bash", str(TUNNEL_SCRIPT), "status", "--json"], capture_output=True, text=True, env=env)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert "installed" in data
    assert "running" in data
    assert "backend" in data

def test_tunnel_cloudflared_help_and_commands():
    # Verify tunnel script responds to status and unknown commands
    proc = subprocess.run(["bash", str(TUNNEL_SCRIPT), "invalidcmd"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "cloudflared" in proc.stderr

if __name__ == "__main__":
    test_tunnel_status_json()
    test_tunnel_cloudflared_help_and_commands()
    print("PASS: Gateway domain tunnel tests passed")
