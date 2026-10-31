"""
Defence-in-depth data protection for everything entering Cognee.

The FraudGuard backend already minimises and pseudonymises records before sending
them. This module enforces the same rules again on the receiving side, so a bug or a
compromised caller cannot push payment credentials or secrets into the memory store:

* ``reject_forbidden_keys`` - structural guard: payloads that *contain* a credential-like
  field are refused outright (HTTP 422), not silently stripped;
* ``redact`` - free text (analyst notes, merchant names, reasons) has emails, phone numbers,
  card-number-like digit runs, IP addresses, JWT/API-key-like tokens and SSN-like numbers
  replaced with placeholders.
"""
from __future__ import annotations

import re
from typing import Any

FORBIDDEN_KEY_RE = re.compile(
    r"(card[_-]?(number|no|num)|\bpan\b|cvv|cvc|cvn|security[_-]?code|pin[_-]?code|\bpin\b|password|passwd|"
    r"secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth(orization)?|bearer|private[_-]?key|"
    r"\bssn\b|social[_-]?security|iban|routing[_-]?number|account[_-]?number|bank[_-]?account|"
    r"ip[_-]?address|device[_-]?fingerprint|\bemail\b|phone|passport|license[_-]?number)",
    re.IGNORECASE,
)

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}")
_KEYISH = re.compile(r"\b(?:sk|pk|rk|key|tok|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}\b", re.IGNORECASE)
_LONG_SECRET = re.compile(r"\b[A-Za-z0-9+/_-]{40,}={0,2}\b")
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6 = re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b")
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_PHONE = re.compile(r"(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])")
_CTRL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")


class ForbiddenFieldError(ValueError):
    """Raised when a payload contains a credential-like or direct-identifier field."""


def reject_forbidden_keys(value: Any, path: str = "$") -> None:
    """Raise if any dict key anywhere in ``value`` looks like a credential or direct identifier."""
    if isinstance(value, dict):
        for key, child in value.items():
            if FORBIDDEN_KEY_RE.search(str(key)):
                raise ForbiddenFieldError(f"Field '{path}.{key}' is not allowed in fraud memory records")
            reject_forbidden_keys(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            reject_forbidden_keys(child, f"{path}[{index}]")


def redact(text: Any, max_len: int = 600) -> str:
    """Return ``text`` with sensitive substrings replaced and length bounded."""
    if text is None:
        return ""
    out = _CTRL.sub(" ", str(text))
    out = _EMAIL.sub("[redacted-email]", out)
    out = _JWT.sub("[redacted-token]", out)
    out = _KEYISH.sub("[redacted-token]", out)
    out = _SSN.sub("[redacted-id]", out)
    out = _IPV6.sub("[redacted-ip]", out)
    out = _IPV4.sub("[redacted-ip]", out)
    out = _CARD.sub(lambda m: "[redacted-number]" if sum(c.isdigit() for c in m.group()) >= 13 else m.group(), out)
    out = _PHONE.sub("[redacted-number]", out)
    out = _LONG_SECRET.sub("[redacted-token]", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out[:max_len]
