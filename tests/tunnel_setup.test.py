"""Test for Gateway Domain options: Cloudflared latest release with pinned fallback and Tailscale on demand."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TUNNEL_SCRIPT = ROOT / "Server" / "stack" / "mse-tunnel.sh"
SETUP_PY = ROOT / "Server" / "stack" / "mse_setup.py"

def test_tunnel_script_capabilities():
    script_content = TUNNEL_SCRIPT.read_text(encoding="utf-8")
    assert "cmd_cf_install" in script_content
    assert "cmd_cf_run" in script_content
    assert "cmd_cf_off" in script_content
    assert "cmd_notify_bot" in script_content
    assert "releases/download" in script_content  # pinned fallback
    assert "cloudflared" in script_content

def test_tui_domain_integration():
    setup_content = SETUP_PY.read_text(encoding="utf-8")
    assert "def ask_domain(self)" in setup_content
    assert "cloudflared-install" in setup_content
    assert "RadioOption(\"cf\"" in setup_content
    assert "RadioOption(\"ts\"" in setup_content

if __name__ == "__main__":
    test_tunnel_script_capabilities()
    test_tui_domain_integration()
    print("PASS: tunnel_setup passed")
