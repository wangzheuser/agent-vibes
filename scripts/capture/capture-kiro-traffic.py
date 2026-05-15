"""
Kiro Traffic Capture - mitmproxy addon
=======================================
Captures and pretty-prints traffic between agent-vibes and Kiro/AWS CodeWhisperer APIs.

Usage:
  npm run capture:kiro:start   # switches system proxy to mitmdump, upstream to Clash
  npm run capture:kiro:stop    # restores system proxy to Clash
  npm run capture:kiro:status  # check current state

Logs are saved to: kiro_traffic.log (same directory)
"""

import gzip
import json
import os
import re
import time
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from mitmproxy import http

# ============================================================
# Configuration
# ============================================================

TARGET_DOMAINS = [
    "q.us-east-1.amazonaws.com",
    "codewhisperer.us-east-1.amazonaws.com",
    "oidc.us-east-1.amazonaws.com",
]

HIGHLIGHT_PATHS = [
    "generateAssistantResponse",
    "listAvailableProfiles",
    "getUsageLimits",
    "token",
    "register",
    "authorize",
]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "kiro_traffic.log")
JSON_LOG_DIR = os.path.join(SCRIPT_DIR, "kiro_traffic_dumps")

SENSITIVE_HEADER_NAMES = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-amz-security-token",
}

SENSITIVE_QUERY_KEYS = {
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "code",
    "key",
    "api_key",
    "secret",
}

SENSITIVE_JSON_KEYS = {
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "authorization",
    "api_key",
    "key",
    "secret",
    "password",
    "proxy",
    "http_proxy",
    "https_proxy",
    "proxy_url",
    "clientsecret",
    "client_secret",
}

SAFE_TOKEN_JSON_KEYS = {
    "maxtokens",
    "maxoutputtokens",
    "inputtokens",
    "outputtokens",
    "totaltokens",
}

RAW_REDACTION_PATTERNS = [
    (
        re.compile(r"(?i)(authorization\"?\s*[:=]\s*\"?bearer\s+)([^\"\\\s]+)"),
        r"\1<redacted>",
    ),
    (
        re.compile(
            r"(?i)(\"?(?:access_token|refresh_token|id_token|api_key|secret|password|proxy_url|http_proxy|https_proxy|client_secret)\"?\s*[:=]\s*\"?)([^\"\\\n]+)"
        ),
        r"\1<redacted>",
    ),
]


class Colors:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    BG_RED = "\033[41m"


class KiroCapture:
    def __init__(self):
        self.request_count = 0
        self.start_time = time.time()

        os.makedirs(JSON_LOG_DIR, mode=0o700, exist_ok=True)
        self._secure_path(JSON_LOG_DIR, is_dir=True)

        with open(LOG_FILE, "w", encoding="utf-8") as f:
            f.write("# Kiro Traffic Capture Log\n")
            f.write(f"# Started: {datetime.now().isoformat()}\n")
            f.write(f"# {'=' * 70}\n\n")
        self._secure_path(LOG_FILE)

        self._print_banner()

    def _print_banner(self):
        print(f"\n{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}")
        print(
            f"{Colors.BOLD}{Colors.CYAN}  Kiro Traffic Capture{Colors.RESET}"
        )
        print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}")
        print(f"{Colors.DIM}  Monitoring: {', '.join(TARGET_DOMAINS)}{Colors.RESET}")
        print(f"{Colors.DIM}  Log file:   {LOG_FILE}{Colors.RESET}")
        print(f"{Colors.DIM}  Dumps dir:  {JSON_LOG_DIR}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}\n")

    def _is_target(self, flow: http.HTTPFlow) -> bool:
        host = flow.request.pretty_host
        return any(domain in host for domain in TARGET_DOMAINS)

    def _get_path_label(self, path: str) -> str:
        for p in HIGHLIGHT_PATHS:
            if p in path:
                return p
        return path.split("/")[-1] if "/" in path else path

    def _decode_body(self, raw: bytes, headers: dict) -> str:
        if not raw:
            return ""
        try:
            content_encoding = headers.get("content-encoding", "")
            if "gzip" in content_encoding:
                raw = gzip.decompress(raw)
            return raw.decode("utf-8", errors="replace")
        except Exception:
            return raw.decode("utf-8", errors="replace")

    def _truncate(self, text: str, max_len: int = 500) -> str:
        if len(text) <= max_len:
            return text
        return text[:max_len] + f"... ({len(text)} bytes total)"

    def _format_json(self, text: str, indent: int = 2) -> str:
        try:
            obj = json.loads(text)
            return json.dumps(obj, indent=indent, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            return text

    def _secure_path(self, path: str, is_dir: bool = False):
        try:
            os.chmod(path, 0o700 if is_dir else 0o600)
        except OSError:
            pass

    def _is_sensitive_key(self, key: str) -> bool:
        normalized = key.strip().lower()
        compact = re.sub(r"[^a-z0-9]", "", normalized)
        if compact in SAFE_TOKEN_JSON_KEYS:
            return False
        if normalized in SENSITIVE_JSON_KEYS:
            return True
        return (
            "token" in normalized
            or "secret" in normalized
            or "password" in normalized
            or normalized.endswith("_key")
            or normalized.endswith("_proxy")
        )

    def _sanitize_url(self, url: str) -> str:
        try:
            parts = urlsplit(url)
            if not parts.query:
                return url

            redacted_query = []
            for key, value in parse_qsl(parts.query, keep_blank_values=True):
                normalized = key.strip().lower()
                if normalized in SENSITIVE_QUERY_KEYS or self._is_sensitive_key(key):
                    redacted_query.append((key, "<redacted>"))
                else:
                    redacted_query.append((key, value))

            return urlunsplit(
                (
                    parts.scheme,
                    parts.netloc,
                    parts.path,
                    urlencode(redacted_query, doseq=True),
                    parts.fragment,
                )
            )
        except Exception:
            return url

    def _sanitize_headers(self, headers: dict) -> dict:
        sanitized = {}
        for key, value in headers.items():
            normalized = key.strip().lower()
            if normalized in SENSITIVE_HEADER_NAMES or self._is_sensitive_key(key):
                if normalized == "authorization" and isinstance(value, str):
                    scheme = value.split(" ", 1)[0] if value else "Bearer"
                    sanitized[key] = f"{scheme} <redacted>"
                else:
                    sanitized[key] = "<redacted>"
            else:
                sanitized[key] = value
        return sanitized

    def _sanitize_json_value(self, value):
        if isinstance(value, dict):
            sanitized = {}
            for key, item in value.items():
                if self._is_sensitive_key(str(key)):
                    sanitized[key] = "<redacted>"
                else:
                    sanitized[key] = self._sanitize_json_value(item)
            return sanitized
        if isinstance(value, list):
            return [self._sanitize_json_value(item) for item in value]
        return value

    def _sanitize_raw_text(self, text: str) -> str:
        sanitized = text
        for pattern, replacement in RAW_REDACTION_PATTERNS:
            sanitized = pattern.sub(replacement, sanitized)
        return sanitized

    def _sanitize_body_payload(self, text: str):
        if not text:
            return None
        try:
            return self._sanitize_json_value(json.loads(text))
        except (json.JSONDecodeError, TypeError):
            return self._sanitize_raw_text(text)

    def _serialize_for_log(self, value) -> str:
        if isinstance(value, (dict, list)):
            return json.dumps(value, indent=2, ensure_ascii=False)
        return value or ""

    def _extract_key_info(self, body_text: str) -> dict:
        """Extract key information from Kiro request/response payloads."""
        info = {}
        try:
            obj = json.loads(body_text)

            # Request payload analysis
            conv_state = obj.get("conversationState", {})
            if conv_state:
                info["chatTriggerType"] = conv_state.get("chatTriggerType")
                info["agentTaskType"] = conv_state.get("agentTaskType")
                info["conversationId"] = conv_state.get("conversationId", "")[:12] + "..."

                current_msg = conv_state.get("currentMessage", {}).get("userInputMessage", {})
                if current_msg:
                    model_id = current_msg.get("modelId")
                    if model_id:
                        info["model"] = model_id

                    content = current_msg.get("content", "")
                    if content:
                        info["content_length"] = len(content)
                        # Show first 100 chars of content (skip system prompt prefix)
                        display = content
                        if "--- END SYSTEM PROMPT ---" in content:
                            display = content.split("--- END SYSTEM PROMPT ---", 1)[1].strip()
                        info["content_preview"] = display[:100]

                    ctx = current_msg.get("userInputMessageContext", {})
                    if ctx:
                        tools = ctx.get("tools", [])
                        if tools:
                            info["tools_count"] = len(tools)
                        tool_results = ctx.get("toolResults", [])
                        if tool_results:
                            info["tool_results_count"] = len(tool_results)
                            info["tool_result_ids"] = [
                                tr.get("toolUseId", "?")[:12] for tr in tool_results
                            ]

                history = conv_state.get("history", [])
                if history:
                    info["history_count"] = len(history)

            # InferenceConfig
            inference = obj.get("inferenceConfig", {})
            if inference:
                info["maxTokens"] = inference.get("maxTokens")

            # ProfileArn (redact but show presence)
            if obj.get("profileArn"):
                info["profileArn"] = "present"

            # Token refresh response
            if "access_token" in obj:
                info["token_type"] = "token_refresh_response"
                if "expires_in" in obj:
                    info["expires_in"] = obj["expires_in"]

        except (json.JSONDecodeError, TypeError, KeyError):
            pass

        return info

    def _extract_response_info(self, raw_body: bytes, headers: dict) -> dict:
        """Extract info from Kiro AWS Event Stream response."""
        info = {}
        content_type = headers.get("content-type", "")

        if "application/vnd.amazon.eventstream" in content_type:
            info["format"] = "AWS Event Stream"
            info["body_size"] = len(raw_body) if raw_body else 0
            # AWS Event Stream is binary; we cannot easily parse it here
            # but we log the size for debugging
        elif raw_body:
            try:
                text = raw_body.decode("utf-8", errors="replace")
                obj = json.loads(text)
                if "message" in obj:
                    info["error_message"] = obj["message"]
                if "reason" in obj:
                    info["error_reason"] = obj["reason"]
            except (json.JSONDecodeError, TypeError):
                pass

        return info

    def _save_dump(self, flow: http.HTTPFlow, req_body: str, resp_body: str):
        self.request_count += 1
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        label = self._get_path_label(flow.request.path)
        filename = f"{ts}_{self.request_count:04d}_{label}.json"
        filepath = os.path.join(JSON_LOG_DIR, filename)

        dump = {
            "timestamp": datetime.now().isoformat(),
            "request": {
                "method": flow.request.method,
                "url": self._sanitize_url(flow.request.pretty_url),
                "headers": self._sanitize_headers(dict(flow.request.headers)),
            },
            "response": {
                "status_code": flow.response.status_code if flow.response else None,
                "headers": self._sanitize_headers(dict(flow.response.headers))
                if flow.response
                else None,
            },
        }

        sanitized_req_body = self._sanitize_body_payload(req_body)
        if isinstance(sanitized_req_body, (dict, list)):
            dump["request"]["body"] = sanitized_req_body
        elif sanitized_req_body:
            dump["request"]["body_raw"] = sanitized_req_body[:2000]

        # For Kiro responses, store raw body size (binary event stream)
        if flow.response and flow.response.raw_content:
            content_type = flow.response.headers.get("content-type", "")
            if "application/vnd.amazon.eventstream" in content_type:
                dump["response"]["body_format"] = "AWS Event Stream (binary)"
                dump["response"]["body_size"] = len(flow.response.raw_content)
            else:
                sanitized_resp_body = self._sanitize_body_payload(resp_body)
                if isinstance(sanitized_resp_body, (dict, list)):
                    dump["response"]["body"] = sanitized_resp_body
                elif sanitized_resp_body:
                    dump["response"]["body_raw"] = sanitized_resp_body[:2000]

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(dump, f, indent=2, ensure_ascii=False)
        self._secure_path(filepath)

    def _log_to_file(self, text: str):
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(text + "\n")

    def request(self, flow: http.HTTPFlow):
        if not self._is_target(flow):
            return

        path_label = self._get_path_label(flow.request.path)
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        print(
            f"\n{Colors.BOLD}{Colors.YELLOW}REQUEST{Colors.RESET} "
            f"{Colors.CYAN}[{ts}]{Colors.RESET} "
            f"{Colors.BOLD}{flow.request.method}{Colors.RESET} "
            f"{Colors.GREEN}{path_label}{Colors.RESET}"
        )
        print(
            f"  {Colors.DIM}URL: {self._sanitize_url(flow.request.pretty_url)}{Colors.RESET}"
        )

        # Show key Kiro headers
        amz_target = flow.request.headers.get("X-Amz-Target", "")
        if amz_target:
            print(f"  {Colors.DIM}X-Amz-Target: {amz_target}{Colors.RESET}")
        agent_mode = flow.request.headers.get("x-amzn-kiro-agent-mode", "")
        if agent_mode:
            print(f"  {Colors.DIM}Agent-Mode: {agent_mode}{Colors.RESET}")

        req_body = self._decode_body(flow.request.raw_content, dict(flow.request.headers))
        if req_body:
            key_info = self._extract_key_info(req_body)
            if key_info:
                print(f"  {Colors.MAGENTA}Key Info:{Colors.RESET}")
                for k, v in key_info.items():
                    print(f"    {Colors.DIM}{k}: {v}{Colors.RESET}")

        self._log_to_file(f"\n{'=' * 70}")
        self._log_to_file(
            f"[{ts}] REQUEST {flow.request.method} {self._sanitize_url(flow.request.pretty_url)}"
        )
        self._log_to_file(
            f"Headers: {json.dumps(self._sanitize_headers(dict(flow.request.headers)), indent=2)}"
        )
        sanitized_req_body = self._sanitize_body_payload(req_body)
        if sanitized_req_body:
            self._log_to_file(f"Body:\n{self._serialize_for_log(sanitized_req_body)}")

    def response(self, flow: http.HTTPFlow):
        if not self._is_target(flow):
            return

        path_label = self._get_path_label(flow.request.path)
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        status = flow.response.status_code

        if status < 300:
            status_color = Colors.GREEN
        elif status < 400:
            status_color = Colors.YELLOW
        elif status == 429:
            status_color = Colors.BG_RED + Colors.WHITE
        else:
            status_color = Colors.RED

        print(
            f"\n{Colors.BOLD}{Colors.BLUE}RESPONSE{Colors.RESET} "
            f"{Colors.CYAN}[{ts}]{Colors.RESET} "
            f"{status_color}{Colors.BOLD} {status} {Colors.RESET} "
            f"{Colors.GREEN}{path_label}{Colors.RESET}"
        )

        resp_info = self._extract_response_info(
            flow.response.raw_content, dict(flow.response.headers)
        )
        if resp_info:
            print(f"  {Colors.MAGENTA}Response Info:{Colors.RESET}")
            for k, v in resp_info.items():
                print(f"    {Colors.DIM}{k}: {v}{Colors.RESET}")

        # For non-event-stream errors, show the error body
        content_type = flow.response.headers.get("content-type", "")
        if status >= 400 and "application/vnd.amazon.eventstream" not in content_type:
            resp_body = self._decode_body(
                flow.response.raw_content, dict(flow.response.headers)
            )
            if resp_body:
                sanitized_error = self._sanitize_body_payload(resp_body)
                print(
                    f"  {Colors.RED}Error: {self._truncate(self._serialize_for_log(sanitized_error), 300)}{Colors.RESET}"
                )

        self._log_to_file(
            f"[{ts}] RESPONSE {status} {self._sanitize_url(flow.request.pretty_url)}"
        )
        self._log_to_file(
            f"Headers: {json.dumps(self._sanitize_headers(dict(flow.response.headers)), indent=2)}"
        )
        if "application/vnd.amazon.eventstream" in content_type:
            self._log_to_file(
                f"Body: [AWS Event Stream binary, {len(flow.response.raw_content or b'')} bytes]"
            )
        else:
            resp_body = self._decode_body(
                flow.response.raw_content, dict(flow.response.headers)
            )
            sanitized_resp_body = self._sanitize_body_payload(resp_body)
            if sanitized_resp_body:
                self._log_to_file(f"Body:\n{self._serialize_for_log(sanitized_resp_body)}")

        req_body = self._decode_body(flow.request.raw_content, dict(flow.request.headers))
        resp_body = self._decode_body(
            flow.response.raw_content, dict(flow.response.headers)
        )
        self._save_dump(flow, req_body, resp_body)


addons = [KiroCapture()]
