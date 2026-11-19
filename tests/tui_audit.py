"""Audit test for TUI mse command: no duplicate functions and clean menu structure."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETUP_PY = ROOT / "Server" / "stack" / "mse_setup.py"

def test_tui_audit():
    content = SETUP_PY.read_text(encoding="utf-8")
    # 1. detect_pythons must only be defined once
    matches = re.findall(r'def\s+detect_pythons\s*\(', content)
    assert len(matches) == 1, f"detect_pythons defined {len(matches)} times (expected exactly 1)"

    # 2. Main menu options must be distinct and contain Gateway Domain
    menu_match = re.search(r'def ask_action\(self\).*?RadioOption\("([a-z]+)".*?\]', content, re.DOTALL)
    assert menu_match, "ask_action Menu not found"
    options = re.findall(r'RadioOption\("([a-z_]+)"', menu_match.group(0))
    assert len(options) == len(set(options)), f"Duplicate options found in ask_action: {options}"
    assert "domain" in options, "Gateway Domain option missing from main menu"
    assert "health" in options, "Health option missing from main menu"
    assert len(options) <= 6, f"Expected clean streamlined menu (at most 6 items), got {len(options)}"

if __name__ == "__main__":
    test_tui_audit()
    print("PASS: tui_audit passed")
