"""Real loopback transport checks; never connects to a paid provider."""
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mnemosyne_memory import MemoryClient, MemoryError


TOKEN = "local-test-token-" + "x" * 32


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        self.server.requests.append((self.command, self.path, self.headers.get("Authorization"), body))
        mode = self.server.mode
        try:
            if mode == "redirect":
                self.send_response(302)
                self.send_header("Location", self.server.origin + "/credential-target")
                self.end_headers()
                return
            if mode == "timeout":
                time.sleep(0.12)
            if mode == "error-timeout":
                self.send_response(503)
                self.send_header("Content-Length", "1000")
                self.end_headers()
                self.wfile.write(b'{"error":')
                self.wfile.flush()
                time.sleep(0.12)
                return
            status, value = {
                "ok": (200, json.dumps({"live": True}).encode()),
                "timeout": (200, b"{}"),
                "large": (200, b"x" * 200),
                "invalid": (200, b"not-json"),
                "invalid-utf8": (200, b"\xff"),
                "error": (403, b'{"error":"Read-only principal"}'),
                "large-error": (503, b"x" * 200),
            }[mode]
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(value)))
            self.end_headers()
            self.wfile.write(value)
        except (BrokenPipeError, ConnectionResetError):
            pass


class MemoryClientTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.mode = "ok"
        self.server.requests = []
        self.server.origin = "http://127.0.0.1:" + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.client = MemoryClient(self.server.origin, TOKEN)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def test_scope_credentials_and_utf8_payload_are_transmitted_exactly(self):
        self.assertEqual(self.client.capabilities(), {"live": True})
        self.client.store("café observation", {"uri": "test:python"}, idempotency_key="retry-1")
        get, post = self.server.requests
        self.assertEqual(get[:3], ("GET", "/v1/capabilities", "Bearer " + TOKEN))
        self.assertEqual(post[:3], ("POST", "/v1/store", "Bearer " + TOKEN))
        self.assertEqual(json.loads(post[3]), {"text": "café observation", "source": {"uri": "test:python"}, "idempotencyKey": "retry-1"})

    def test_context_forwards_temporal_clocks_and_lexical_mode_without_inventing_defaults(self):
        as_of = "2026-09-03T00:00:00.000Z"
        known_at = "2026-09-10T00:00:00.000Z"
        cases = (
            ({}, {}),
            ({"as_of": as_of}, {"asOf": as_of}),
            ({"known_at": known_at}, {"knownAt": known_at}),
            ({"lexical_scoring": "overlap"}, {"lexicalScoring": "overlap"}),
            ({"as_of": as_of, "known_at": known_at, "lexical_scoring": "bm25"},
             {"asOf": as_of, "knownAt": known_at, "lexicalScoring": "bm25"}),
        )
        for options, expected in cases:
            with self.subTest(options=options):
                before = len(self.server.requests)
                self.assertEqual(self.client.context("café release", max_tokens=2048, **options), {"live": True})
                self.assertEqual(len(self.server.requests), before + 1)
                request = self.server.requests[-1]
                self.assertEqual(request[:3], ("POST", "/v1/context", "Bearer " + TOKEN))
                self.assertEqual(json.loads(request[3]), {"query": "café release", "maxTokens": 2048, **expected})


    def test_redirect_is_rejected_without_followup_or_mutation_retry(self):
        self.server.mode = "redirect"
        with self.assertRaises(MemoryError) as error:
            self.client.store("test", {"uri": "test:python"})
        self.assertEqual(error.exception.status, 302)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0][1], "/v1/store")

    def test_timeout_is_bounded_and_does_not_retry_a_mutation(self):
        self.server.mode = "timeout"
        client = MemoryClient(self.server.origin, TOKEN, timeout=0.025)
        started = time.monotonic()
        with self.assertRaisesRegex(MemoryError, "inspect state before retrying"):
            client.store("test", {"uri": "test:python"})
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(len(self.server.requests), 1)

    def test_timeout_while_reading_an_error_preserves_status_and_closes_response(self):
        self.server.mode = "error-timeout"
        with self.assertRaises(MemoryError) as error:
            MemoryClient(self.server.origin, TOKEN, timeout=0.025).capabilities()
        self.assertEqual(error.exception.status, 503)
        self.assertIn("Incomplete error response", str(error.exception))

    def test_bounds_request_and_response_bytes(self):
        client = MemoryClient(self.server.origin, TOKEN, max_bytes=64)
        with self.assertRaisesRegex(ValueError, "Request exceeds"):
            client.store("é" * 50, {"uri": "test:python"})
        self.assertEqual(self.server.requests, [])
        self.server.mode = "large"
        with self.assertRaisesRegex(MemoryError, "Response exceeds"):
            client.capabilities()
        self.server.mode = "large-error"
        with self.assertRaisesRegex(MemoryError, "Error response exceeds") as error:
            client.capabilities()
        self.assertEqual(error.exception.status, 503)

    def test_invalid_json_and_server_rejections_use_client_error_contract(self):
        for mode in ("invalid", "invalid-utf8"):
            self.server.mode = mode
            with self.assertRaisesRegex(MemoryError, "Invalid JSON response"):
                self.client.capabilities()
        self.server.mode = "error"
        with self.assertRaisesRegex(MemoryError, "Read-only principal") as error:
            self.client.capabilities()
        self.assertEqual(error.exception.status, 403)

    def test_rejects_invalid_urls_tokens_and_limits_before_network(self):
        for origin in ("http://remote.example", "file:///tmp/memory", "https://user:secret@example.test", "https://example.test/v1", "https://example.test?key=secret", "https://example.test#fragment", "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://127.0.0.1\n"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                MemoryClient(origin, TOKEN)
        for token in ("short", "x" * 4097, "x" * 32 + "\n", "x" * 32 + "\0", "é" * 32):
            with self.subTest(token=repr(token[:5])), self.assertRaises(ValueError):
                MemoryClient(self.server.origin, token)
        for options in ({"timeout": True}, {"timeout": float("nan")}, {"timeout": 0}, {"max_bytes": 1.5}, {"max_bytes": True}, {"max_bytes": 0}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                MemoryClient(self.server.origin, TOKEN, **options)
        self.assertEqual(self.server.requests, [])

    def test_rejects_unknown_operations_and_non_json_values_locally(self):
        with self.assertRaises(ValueError):
            self.client.request("../escape", {})
        with self.assertRaises(ValueError):
            self.client.request("store", {"text": float("nan")})
        self.assertEqual(self.server.requests, [])


if __name__ == "__main__":
    unittest.main()
