"""Interactively store UniPlan secrets in the macOS Keychain (alternative to filling in ../.env).

    cd ~/Desktop/Projects/uniplan/spikes && uv run setup_secrets.py

Input is hidden. Press Enter to keep an existing value or skip one you don't have yet.
Keychain values are used whenever the matching .env line is blank.
"""
import getpass

import keyring

from common import SECRETS, SERVICE

for name, prompt in SECRETS.items():
    existing = keyring.get_password(SERVICE, name)
    mark = " [set - Enter to keep]" if existing else ""
    val = getpass.getpass(f"{prompt}{mark}: ").strip()
    if val:
        keyring.set_password(SERVICE, name, val)
        print(f"  saved {name}")

print("\nIn Keychain:", [n for n in SECRETS if keyring.get_password(SERVICE, n)])
