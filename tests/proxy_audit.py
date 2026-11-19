"""Audit test verifying that AI proxy is excised from MSE server settings and TUI."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETUP_PY = ROOT / "Server" / "stack" / "mse_setup.py"

def test_no_ai_proxy_in_setup():
    content = SETUP_PY.read_text(encoding="utf-8")
    # Verify AI_PROXY is not in fields of ask_settings
    assert 'Field("AI_PROXY"' not in content, "AI_PROXY field should not be in ask_settings"
    # Verify AI_PROXY is not in self.settings dictionary initialization
    match = re.search(r'self\.settings\s*=\s*\{([^}]+)\}', content)
    assert match, "self.settings definition not found"
    assert '"AI_PROXY"' not in match.group(1), "AI_PROXY found in self.settings dictionary"

if __name__ == "__main__":
    test_no_ai_proxy_in_setup()
    print("PASS: proxy_audit passed")
