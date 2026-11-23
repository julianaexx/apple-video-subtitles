"""Optional command adapter for a user-configured LibreTranslate endpoint."""

import json
import os
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


def main():
    endpoint = os.environ.get("SUBTITLE_TRANSLATE_URL", "")
    parts = urlsplit(endpoint)
    if ((parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in {"127.0.0.1", "localhost"}))
            or not parts.hostname or parts.username or parts.password):
        raise ValueError("set SUBTITLE_TRANSLATE_URL to your HTTPS /translate endpoint")
    texts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if not isinstance(texts, list) or any(not isinstance(value, str) for value in texts):
        raise ValueError("expected JSON string array")
    if not texts:
        print("[]")
        return
    data = {"q": texts, "source": "en", "target": "zh", "format": "text"}
    key = os.environ.get("SUBTITLE_TRANSLATE_API_KEY")
    if key:
        data["api_key"] = key

    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None

    request = Request(endpoint, data=json.dumps(data).encode("utf-8"), headers={"Content-Type": "application/json"})
    with build_opener(NoRedirect()).open(request, timeout=4) as response:
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("translation response too large")
    translated = json.loads(body.decode("utf-8"))["translatedText"]
    if not isinstance(translated, list) or len(translated) != len(texts) or any(not isinstance(value, str) or not value.strip() for value in translated):
        raise ValueError("translation endpoint must return one translatedText string per input")
    sys.stdout.buffer.write(json.dumps(translated, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid printing response content, URLs with API keys, or source text.
        sys.exit("Translation failed: " + type(error).__name__)
