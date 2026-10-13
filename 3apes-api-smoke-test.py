#!/usr/bin/env python3
"""Integration smoke tests for the 3apes-mvp Axum backend.

Only talks to the supplied API URL; uses Python standard library.
Creates a throwaway user and deletes the chat and API key it creates.
The user account remains in SQLite (no account deletion endpoint exists).
Use --inference to send one real billable request to the configured LLM.
"""
import argparse
import json
import secrets
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request(base, method, path, payload=None, token=None, timeout=30):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(base + path, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8")) if raw else None
    except HTTPError as exc:
        raw = exc.read()
        try:
            details = json.loads(raw.decode("utf-8"))
        except Exception:
            details = raw[:250].decode("utf-8", errors="replace")
        return exc.code, details


def expect(label, result, status):
    actual, payload = result
    if actual != status:
        raise RuntimeError(f"{label}: expected HTTP {status}, got {actual}: {payload}")
    print(f"  PASS {label}: HTTP {actual}")
    return payload


def stream_test(base, chat_id, token, tier):
    req = Request(
        f"{base}/api/chats/{chat_id}/messages",
        data=json.dumps({"content": "Say hello in one short sentence.", "tier": tier}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    try:
        conn = urlopen(req, timeout=180)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Inference rejected: HTTP {exc.code}: {body}") from exc
    seen_meta = False
    seen_done = False
    text_parts = []
    current_event = "message"
    data_lines = []
    with conn:
        for raw in conn:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line.startswith("event:"):
                current_event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
            elif line == "":
                if data_lines:
                    data = json.loads("\n".join(data_lines))
                    if current_event == "meta":
                        seen_meta = True
                        print("  Streaming model:", data.get("model", "(not specified)"))
                    elif current_event == "token":
                        text_parts.append(data.get("text", ""))
                    elif current_event == "error":
                        raise RuntimeError(f"Inference stream error: {data}")
                    elif current_event == "done":
                        seen_done = True
                    data_lines = []
                current_event = "message"
    if not seen_meta or not seen_done:
        raise RuntimeError(f"Incomplete stream: meta={seen_meta}, done={seen_done}")
    print("  PASS stream completed; response:", repr("".join(text_parts)[:240]))
    return "".join(text_parts)


def main():
    parser = argparse.ArgumentParser(description="Test local 3apes MVP API")
    parser.add_argument("--url", default="http://127.0.0.1:8080", help="3apes backend base URL")
    parser.add_argument("--inference", action="store_true", help="Also send one real LLM prompt (may incur Phala charges)")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    email = f"api-test-{uuid.uuid4().hex[:10]}@example.test"
    password = secrets.token_urlsafe(24)
    print("Testing", base)
    health = expect("health", request(base, "GET", "/healthz"), 200)
    if health != {"ok": True}:
        raise RuntimeError(f"Unexpected health response: {health}")
    expect("unauthenticated access blocked", request(base, "GET", "/api/chats"), 401)
    expect("register", request(base, "POST", "/api/auth/register", {"email": email, "password": password}), 200)
    auth = expect("login", request(base, "POST", "/api/auth/login", {"email": email, "password": password}), 200)
    token = auth["token"]
    expect("session identity", request(base, "GET", "/api/auth/me", token=token), 200)
    models = expect("model list", request(base, "GET", "/api/models", token=token), 200)
    tiers = [m["tier"] for m in models["models"]]
    print("  Configured model tiers:", ", ".join(tiers) or "none")
    if models.get("attestation") == "not_verified":
        print("  NOTE: remote TEE attestation is not implemented yet")
    chat = expect("create chat", request(base, "POST", "/api/chats", {"title": "Smoke test"}, token), 200)
    cid = chat["id"]
    expect("list chats", request(base, "GET", "/api/chats", token=token), 200)
    expect("read chat", request(base, "GET", f"/api/chats/{cid}", token=token), 200)
    expect("empty prompt rejected", request(base, "POST", f"/api/chats/{cid}/messages", {"content": "", "tier": "auto"}, token), 400)
    expect("invalid model tier rejected", request(base, "POST", f"/api/chats/{cid}/messages", {"content": "hello", "tier": "invalid"}, token), 400)
    expect("missing chat rejected", request(base, "GET", f"/api/chats/{uuid.uuid4()}", token=token), 404)
    key_reply = expect("create API key", request(base, "POST", "/api/keys", {"label": "smoke-test"}, token), 200)
    key = key_reply["key"]
    expect("use API key", request(base, "GET", "/api/auth/me", token=key), 200)
    expect("list API keys", request(base, "GET", "/api/keys", token=token), 200)
    expect("revoke API key", request(base, "DELETE", f"/api/keys/{key_reply['id']}", token=token), 200)
    expect("revoked API key rejected", request(base, "GET", "/api/auth/me", token=key), 401)
    if args.inference:
        print("  Sending one actual inference request (may incur cost)...")
        chosen_tier = "medium" if "medium" in tiers else (tiers[0] if tiers else "auto")
        stream_test(base, cid, token, chosen_tier)
        persisted = expect("read saved messages", request(base, "GET", f"/api/chats/{cid}", token=token), 200)
        roles = [m["role"] for m in persisted["messages"]]
        if not ("user" in roles and "assistant" in roles):
            raise RuntimeError(f"Assistant and user messages not both persisted: {roles}")
        print("  PASS SQLite message persistence")
    else:
        print("  Skipping external LLM inference; rerun with --inference to test it.")
    expect("delete chat", request(base, "DELETE", f"/api/chats/{cid}", token=token), 200)
    expect("deleted chat no longer exists", request(base, "GET", f"/api/chats/{cid}", token=token), 404)
    expect("logout", request(base, "POST", "/api/auth/logout", token=token), 200)
    expect("logged-out session rejected", request(base, "GET", "/api/auth/me", token=token), 401)
    print("\nAll requested checks passed. A throwaway test user remains in local SQLite.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, URLError, ValueError, KeyError) as e:
        print("\nFAIL:", e, file=sys.stderr)
        sys.exit(1)
