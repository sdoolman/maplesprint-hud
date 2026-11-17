#!/usr/bin/env python3
"""Fetch official AWS Global Accelerator + us-west-2 prefixes for MapleSprint AllowedIPs."""

import ipaddress
import json
import sys
import urllib.request

DEFAULT_PREFIXES = [
    "158.115.192.0/19",
    "35.160.0.0/13",
    "166.117.0.0/16",
]
AWS_IP_RANGES_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json"


def fetch_allowed_ips() -> str:
    prefixes = set(DEFAULT_PREFIXES)
    try:
        req = urllib.request.Request(
            AWS_IP_RANGES_URL,
            headers={"User-Agent": "maplesprint-hud-ci/1.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        for entry in data.get("prefixes", []):
            cidr = entry.get("ip_prefix", "")
            service = entry.get("service", "")
            if service == "GLOBALACCELERATOR" and cidr:
                net = ipaddress.IPv4Network(cidr, strict=True)
                prefixes.add(str(net))
    except Exception as exc:
        print(f"warning: failed to fetch AWS IP ranges ({exc}); using defaults", file=sys.stderr)

    ordered = sorted(prefixes, key=lambda c: ipaddress.IPv4Network(c))
    return ", ".join(ordered)


if __name__ == "__main__":
    print(fetch_allowed_ips())
