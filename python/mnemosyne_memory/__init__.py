"""Dependency-free, explicitly scoped HTTP client. No automatic mutation retries."""
import json
import math
import http.client
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class MemoryError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class MemoryClient:
    """A token selects its server-side workspace/agent; callers cannot override it."""
    def __init__(self, base_url, token, *, timeout=15, max_bytes=1_048_576):
        if not isinstance(base_url, str) or any(ord(c) < 32 or ord(c) == 127 for c in base_url):
            raise ValueError("Use an absolute HTTP(S) server origin")
        parsed = urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Use an absolute HTTP(S) server origin")
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError("Remote servers require HTTPS")
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError("Invalid server port")
        if not isinstance(token, str) or not 32 <= len(token) <= 4096 or any(not 33 <= ord(c) <= 126 for c in token):
            raise ValueError("Invalid access token")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 300:
            raise ValueError("Invalid client limits")
        if type(max_bytes) is not int or not 1 <= max_bytes <= 16_777_216:
            raise ValueError("Invalid client limits")
        self.base_url = base_url.rstrip("/")
        self._token, self.timeout, self.max_bytes = token, timeout, max_bytes
        self._opener = build_opener(_NoRedirect)

    def request(self, operation, body=None):
        if operation not in {"capabilities", "recall", "context", "inspect", "store", "correct", "forget", "source", "capture", "model", "skill", "branch-create", "branch-preview", "branch-stage", "branch-merge", "entity-resolve", "traverse"}:
            raise ValueError("Unknown memory operation")
        data = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if data and len(data) > self.max_bytes:
            raise ValueError("Request exceeds client limit")
        request = Request(self.base_url + "/v1/" + operation, data=data,
                          headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json"},
                          method="GET" if body is None else "POST")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(self.max_bytes + 1)
                if len(raw) > self.max_bytes:
                    raise MemoryError("Response exceeds client limit; mutation may have completed")
                try:
                    return json.loads(raw)
                except (ValueError, UnicodeError):
                    raise MemoryError("Invalid JSON response; mutation may have completed") from None
        except HTTPError as error:
            try:
                raw = error.read(self.max_bytes + 1)
                try:
                    message = json.loads(raw).get("error", "Memory request failed") if len(raw) <= self.max_bytes else "Error response exceeds limit"
                except (ValueError, AttributeError):
                    message = "Memory request failed"
            except (TimeoutError, OSError, http.client.HTTPException):
                raise MemoryError("Incomplete error response; inspect state before retrying a mutation", error.code) from None
            finally:
                error.close()
            raise MemoryError(message, error.code) from None
        except (URLError, TimeoutError, OSError, http.client.HTTPException):
            raise MemoryError("Memory connection failed; inspect state before retrying a mutation") from None

    def capabilities(self):
        return self.request("capabilities")

    def recall(self, query, *, limit=10, **filters):
        return self.request("recall", {"query": query, "limit": limit, **filters})

    def context(self, query, *, max_tokens=4096):
        return self.request("context", {"query": query, "maxTokens": max_tokens})

    def inspect(self, *, memory_id=None, limit=20, cursor=None, include_inactive=False):
        return self.request("inspect", {"id": memory_id} if memory_id else {"limit": limit, "includeInactive": include_inactive, **({"cursor": cursor} if cursor else {})})

    def store(self, text, source, *, idempotency_key=None, **options):
        return self.request("store", {"text": text, "source": source, **options, **({"idempotencyKey": idempotency_key} if idempotency_key else {})})

    def correct(self, memory_id, text, source, reason):
        return self.request("correct", {"id": memory_id, "text": text, "source": source, "reason": reason})

    def forget(self, memory_id):
        return self.request("forget", {"id": memory_id})

    def capture(self, session_id, jsonl, *, adapter="generic"):
        return self.request("capture", {"sessionId": session_id, "adapter": adapter, "jsonl": jsonl})
