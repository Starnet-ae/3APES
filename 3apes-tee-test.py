#!/usr/bin/env python3
"""Login to a deployed 3apes API and run one real inference stream.

Uses only Python's standard library. Does not print or persist passwords,
session tokens, or provider API keys. Leaves the new chat saved in SQLite.
Use --register ONLY when SIGNUP_ENABLED=true in your controlled test CVM.
"""
import argparse
import getpass
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_URL = "https://0a8deacc9a680d6fe9e3541fc565e2c6c4d3ba87-8080.dstack-pha-prod9.phala.network"


def api_call(base, method, path, body=None, token=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(base + path, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=timeout) as resp:
            response_bytes = resp.read()
            return json.loads(response_bytes) if response_bytes else None
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"{method} {path} failed (HTTP {exc.code}): {detail}") from None


def inference(base, chat_id, token, prompt, tier):
    path = f"/api/chats/{chat_id}/messages"
    body = json.dumps({"content": prompt, "tier": tier}).encode("utf-8")
    req = Request(base + path, method="POST", data=body, headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    })
    try:
        response = urlopen(req, timeout=180)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Inference request failed (HTTP {exc.code}): {detail}") from None

    event_type = None
    fields = []
    output = []
    done = False
    print("\nModel response: ", end="", flush=True)
    with response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                fields.append(line[5:].strip())
            elif line == "":
                if fields:
                    try:
                        payload = json.loads("\n".join(fields))
                    except json.JSONDecodeError:
                        raise RuntimeError("Malformed inference SSE event") from None
                    if event_type == "token":
                        chunk = payload.get("text", "")
                        output.append(chunk)
                        print(chunk, end="", flush=True)
                    elif event_type == "error":
                        raise RuntimeError(f"Inference stream failed: {payload}")
                    elif event_type == "done":
                        done = True
                event_type, fields = None, []
    print()
    if not done:
        raise RuntimeError("Inference stream ended without a 'done' event")
    return "".join(output)


def main():
    parser = argparse.ArgumentParser(description="Test 3apes TEE login, inference and SQLite persistence without frontend")
    parser.add_argument("--url", default=DEFAULT_URL, help="3apes HTTPS API base URL")
    parser.add_argument("--register", action="store_true", help="Create account before login; requires SIGNUP_ENABLED=true")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    print("3apes TEE API:", base)
    print("Health:", api_call(base, "GET", "/healthz"))
    email = input("Account email: ").strip()
    password = getpass.getpass("Account password (not displayed): ")
    if not email or not password:
        raise RuntimeError("Email and password are required")

    if args.register:
        print("Registering a new test account...")
        result = api_call(base, "POST", "/api/auth/register", {"email": email, "password": password})
        print("Registration:", result)

    session = api_call(base, "POST", "/api/auth/login", {"email": email, "password": password})
    del password
    token = session["token"]
    print("Login: OK (session token kept private)")
    print("Identity:", api_call(base, "GET", "/api/auth/me", token=token))

    models = api_call(base, "GET", "/api/models", token=token)
    available = models.get("models", [])
    print("Available models:", [(m["tier"], m["name"]) for m in available])
    if models.get("attestation") == "not_verified":
        print("Note: 3apes remote TEE attestation verification is not implemented.")
    if not available:
        raise RuntimeError("No model tiers configured in the backend")
    tier = "medium" if any(m["tier"] == "medium" for m in available) else available[0]["tier"]

    prompt = input("Prompt [Say hello in one short sentence.]: ").strip() or "Say hello in one short sentence."
    chat = api_call(base, "POST", "/api/chats", {"title": "TEE CLI inference test"}, token)
    chat_id = chat["id"]
    print("Chat created:", chat_id)
    text = inference(base, chat_id, token, prompt, tier)

    stored = api_call(base, "GET", f"/api/chats/{chat_id}", token=token)
    messages = stored.get("messages", [])
    has_user = any(m.get("role") == "user" and m.get("content") == prompt for m in messages)
    has_assistant = any(m.get("role") == "assistant" and m.get("content") == text for m in messages)
    if not has_user or not has_assistant:
        raise RuntimeError(f"SQLite verification failed: user_saved={has_user}, assistant_saved={has_assistant}")
    print("\nPASS: inference streamed and both messages were saved in SQLite")
    print("Saved chat ID:", chat_id)
    print("Account and chat are retained for persistence testing.")
    api_call(base, "POST", "/api/auth/logout", token=token)
    print("Signed out successfully.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, URLError, KeyError, ValueError, EOFError, KeyboardInterrupt) as exc:
        print("\nFAIL:", exc, file=sys.stderr)
        sys.exit(1)
