#!/usr/bin/env python3
"""Assemble workflow/update-netbox.json from Code snippets."""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
CODE = HERE / "code"


def load_env() -> dict[str, str]:
    """Values from .env (falls back to .env.example); real environment wins.

    n8n blocks $env inside Code nodes, so values are baked in at build time.
    """
    root = HERE.parent
    path = root / ".env"
    if not path.exists():
        path = root / ".env.example"
        print(f"warning: .env not found, building with placeholders from {path.name}")
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    env.update({k: v for k, v in os.environ.items() if k in env})
    return env


ENV = load_env()


def env_value(name: str) -> str:
    if name not in ENV:
        raise SystemExit(f"missing {name} in .env / .env.example")
    return ENV[name]


def env_bool(name: str) -> bool:
    return env_value(name).lower() in ("1", "true", "yes")


def render(text: str) -> str:
    """Replace {{ENV:NAME}} (JS string) and {{ENVBOOL:NAME}} (JS boolean)."""

    def string(m: re.Match) -> str:
        return env_value(m.group(1)).replace("\\", "\\\\").replace("'", "\\'")

    def boolean(m: re.Match) -> str:
        return "true" if env_bool(m.group(1)) else "false"

    text = re.sub(r"\{\{ENV:([A-Z0-9_]+)\}\}", string, text)
    return re.sub(r"\{\{ENVBOOL:([A-Z0-9_]+)\}\}", boolean, text)


def read(name: str) -> str:
    return render((CODE / name).read_text())


def js(*parts: str) -> str:
    chunks = [read("lib.js")]
    chunks.extend(read(name) for name in parts)
    return "\n".join(chunks)


def nid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"netbox-update-netbox/{name}"))


def code_node(name: str, x: int, y: int, source: str, each: bool = False) -> dict:
    return {
        "parameters": {
            "mode": "runOnceForEachItem" if each else "runOnceForAllItems",
            "language": "javaScript",
            "jsCode": source,
        },
        "id": nid(name),
        "name": name,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [x, y],
    }


def http_node(name: str, x: int, y: int, method: str, url: str, headers: list[tuple[str, str]], extra: dict | None = None) -> dict:
    node = {
        "parameters": {
            "method": method,
            "url": url,
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [{"name": k, "value": v} for k, v in headers],
            },
            "options": {
                "allowUnauthorizedCerts": env_bool("SKIP_TLS_VERIFY"),
                "timeout": 60000,
            },
        },
        "id": nid(name),
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [x, y],
    }
    extra = dict(extra or {})
    on_error = extra.pop("onError", None)
    response_format = extra.pop("responseFormat", None)
    node["parameters"].update(extra)
    if response_format:
        node["parameters"].setdefault("options", {})
        node["parameters"]["options"]["response"] = {
            "response": {"responseFormat": response_format}
        }
    if on_error:
        node["onError"] = on_error
    return node


def discord_node(name: str, x: int, y: int, content_expr: str) -> dict:
    node = {
        "parameters": {
            "method": "POST",
            "url": env_value("DISCORD_WEBHOOK"),
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [{"name": "Content-Type", "value": "application/json"}],
            },
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": content_expr,
            "options": {"timeout": 15000},
        },
        "id": nid(name),
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [x, y],
        "onError": "continueRegularOutput",
    }
    return node


def if_node(name: str, x: int, y: int, left: str, right, op_type: str, operation: str) -> dict:
    cond_id = nid(f"{name}-cond")
    operator = {"type": op_type, "operation": operation}
    if op_type == "boolean" and operation == "true":
        operator = {"type": "boolean", "operation": "true", "singleValue": True}
    return {
        "parameters": {
            "conditions": {
                "options": {
                    "caseSensitive": True,
                    "leftValue": "",
                    "typeValidation": "loose",
                    "version": 2,
                },
                "conditions": [
                    {
                        "id": cond_id,
                        "leftValue": left,
                        "rightValue": right,
                        "operator": operator,
                    }
                ],
                "combinator": "and",
            }
        },
        "id": nid(name),
        "name": name,
        "type": "n8n-nodes-base.if",
        "typeVersion": 2.2,
        "position": [x, y],
    }


def link(src: str, dst: str, src_index: int = 0, dst_index: int = 0) -> tuple:
    return src, dst, src_index, dst_index


def main() -> None:
    nodes = []
    webhook_id = "pfsense-config-netbox-sync"

    nodes.append({
        "parameters": {
            "httpMethod": "POST",
            "path": "pfsense-config",
            "responseMode": "responseNode",
            "options": {"rawBody": True},
        },
        "id": nid("Webhook receive pfSense XML"),
        "name": "Webhook receive pfSense XML",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1,
        "position": [0, 0],
        "webhookId": webhook_id,
    })
    nodes.append(code_node("Validate pfSense XML", 280, 0, js("validate_xml.js")))
    nodes.append(if_node("XML looks valid?", 560, 0, "={{ $json.ok }}", True, "boolean", "true"))
    nodes.append(code_node("Store pfSense XML", 840, 0, js("store_xml.js")))
    nodes.append({
        "parameters": {
            "operation": "write",
            "fileName": "/home/node/.n8n/pfsense-latest.xml",
            "dataPropertyName": "data",
            "options": {},
        },
        "id": nid("Write pfsense-latest.xml"),
        "name": "Write pfsense-latest.xml",
        "type": "n8n-nodes-base.readWriteFile",
        "typeVersion": 1.1,
        "position": [1120, 0],
        "onError": "continueRegularOutput",
    })
    nodes.append(discord_node(
        "Discord: pfSense received",
        1400, 0,
        "={{ JSON.stringify({ username: 'Update Netbox', content: ':inbox_tray: pfSense redacted config received and stored (' + ($json.bytes || 0) + ' bytes) at ' + ($json.receivedAt || 'now') }) }}",
    ))
    nodes.append({
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ { ok: true, bytes: $('Store pfSense XML').item.json.bytes, receivedAt: $('Store pfSense XML').item.json.receivedAt, fileName: $('Store pfSense XML').item.json.fileName } }}",
            "options": {"responseCode": 200},
        },
        "id": nid("Respond webhook OK"),
        "name": "Respond webhook OK",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.4,
        "position": [1680, 0],
    })
    nodes.append({
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ { ok: false, error: $json.error } }}",
            "options": {"responseCode": 400},
        },
        "id": nid("Respond invalid XML"),
        "name": "Respond invalid XML",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.4,
        "position": [840, 220],
    })

    nodes.append({
        "parameters": {
            "rule": {
                "interval": [{"field": "cronExpression", "expression": "0 3 * * *"}]
            }
        },
        "id": nid("Schedule daily 03:00"),
        "name": "Schedule daily 03:00",
        "type": "n8n-nodes-base.scheduleTrigger",
        "typeVersion": 1.2,
        "position": [0, 480],
    })
    nodes.append({
        "parameters": {},
        "id": nid("Run sync now"),
        "name": "Run sync now",
        "type": "n8n-nodes-base.manualTrigger",
        "typeVersion": 1,
        "position": [0, 680],
    })
    nodes.append({
        "parameters": {
            "httpMethod": "POST",
            "path": "netbox-sync-now",
            "responseMode": "responseNode",
            "options": {},
        },
        "id": nid("Webhook run sync"),
        "name": "Webhook run sync",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1,
        "position": [0, 880],
        "webhookId": "netbox-sync-now",
    })
    sync_token = env_value("SYNC_WEBHOOK_TOKEN")
    if not sync_token:
        raise SystemExit("SYNC_WEBHOOK_TOKEN must not be empty")
    nodes.append(if_node(
        "Sync token ok?", 160, 880,
        "={{ $json.headers['x-sync-token'] }}", sync_token, "string", "equals",
    ))
    nodes.append({
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ { ok: true, started: true, message: 'NetBox sync started' } }}",
            "options": {"responseCode": 200},
        },
        "id": nid("Respond sync started"),
        "name": "Respond sync started",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.4,
        "position": [320, 880],
    })
    nodes.append({
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ { ok: false, error: 'unauthorized' } }}",
            "options": {"responseCode": 401},
        },
        "id": nid("Respond sync unauthorized"),
        "name": "Respond sync unauthorized",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.4,
        "position": [320, 1040],
    })
    nodes.append(code_node("Load sync config", 280, 560, js("load_config.js")))
    nodes.append(code_node("Load stored pfSense XML", 560, 560, js("load_xml.js")))
    nodes.append(if_node("Stored XML present?", 840, 560, "={{ $json.ok }}", True, "boolean", "true"))
    nodes.append({
        "parameters": {
            "errorMessage": "={{ $json.error || 'No stored pfSense XML. POST a redacted config to /webhook/pfsense-config first.' }}",
        },
        "id": nid("Stop missing pfSense XML"),
        "name": "Stop missing pfSense XML",
        "type": "n8n-nodes-base.stopAndError",
        "typeVersion": 1,
        "position": [1120, 780],
    })
    nodes.append(code_node("Parse pfSense config", 1120, 560, js("parse_pfsense.js")))
    nodes.append(http_node(
        "HTTP ntopng host page 1",
        1400, 560,
        "GET",
        "={{ $json.ntopngUrl }}/lua/rest/v2/get/host/active.lua?ifid={{ $json.ntopngIfid }}&currentPage=1&perPage=100",
        [("Authorization", "=Token {{ $json.ntopngToken }}")],
    ))
    nodes.append(code_node("Normalize ntopng hosts", 1680, 560, js("normalize_ntopng.js")))
    nodes.append(code_node("vCenter login", 1960, 560, js("vcenter_login.js")))
    nodes.append(if_node("vCenter session ok?", 2240, 560, "={{ $json.vcenterLoginOk }}", True, "boolean", "true"))
    nodes.append({
        "parameters": {
            "errorMessage": "={{ $json.error || 'vCenter login failed' }}",
        },
        "id": nid("Stop vCenter login failed"),
        "name": "Stop vCenter login failed",
        "type": "n8n-nodes-base.stopAndError",
        "typeVersion": 1,
        "position": [2520, 780],
    })
    nodes.append(code_node("Fetch vCenter NIC MACs", 2520, 560, js("fetch_vcenter_nics.js")))
    nodes.append(code_node("Join inventory", 2800, 560, js("join_inventory.js")))
    nodes.append(code_node("Fetch ntopng host details", 3640, 560, js("fetch_ntop_details.js")))
    nodes.append(http_node(
        "HTTP NetBox site check",
        3920, 560,
        "GET",
        "={{ $('Fetch ntopng host details').item.json.netboxUrl }}/api/dcim/sites/?slug=home",
        [("Authorization", "=Bearer {{ $('Fetch ntopng host details').item.json.netboxToken }}")],
    ))
    nodes.append(code_node(
        "Ensure NetBox foundation",
        4200, 560,
        js("netbox_client.js", "ensure_foundation.js"),
    ))
    nodes.append(code_node(
        "Sync all assets into NetBox",
        4480, 560,
        js("netbox_client.js", "sync_helpers.js", "sync_all_assets.js"),
    ))
    nodes.append(if_node("Sync succeeded?", 4760, 560, "={{ $json.ok }}", True, "boolean", "true"))
    nodes.append(discord_node(
        "Discord: sync finished",
        5040, 560,
        "={{ JSON.stringify({ username: 'Update Netbox', content: ':white_check_mark: NetBox sync finished. inventory=' + $json.inventoryCount + ' processed=' + $json.processed + ' vms_new=' + $json.newVms + ' physical_new=' + $json.newPhysical + ' api_updated=' + $json.apiUpdated + ' errors=' + $json.errors + ($json.dryRun ? ' (dry-run)' : '') }) }}",
    ))

    edges = [
        link("Webhook receive pfSense XML", "Validate pfSense XML"),
        link("Validate pfSense XML", "XML looks valid?"),
        link("XML looks valid?", "Store pfSense XML", 0),
        link("XML looks valid?", "Respond invalid XML", 1),
        link("Store pfSense XML", "Write pfsense-latest.xml"),
        link("Write pfsense-latest.xml", "Discord: pfSense received"),
        link("Discord: pfSense received", "Respond webhook OK"),
        link("Schedule daily 03:00", "Load sync config"),
        link("Run sync now", "Load sync config"),
        link("Webhook run sync", "Sync token ok?"),
        link("Sync token ok?", "Respond sync started", 0),
        link("Sync token ok?", "Respond sync unauthorized", 1),
        link("Respond sync started", "Load sync config"),
        link("Load sync config", "Load stored pfSense XML"),
        link("Load stored pfSense XML", "Stored XML present?"),
        link("Stored XML present?", "Parse pfSense config", 0),
        link("Stored XML present?", "Stop missing pfSense XML", 1),
        link("Parse pfSense config", "HTTP ntopng host page 1"),
        link("HTTP ntopng host page 1", "Normalize ntopng hosts"),
        link("Normalize ntopng hosts", "vCenter login"),
        link("vCenter login", "vCenter session ok?"),
        link("vCenter session ok?", "Fetch vCenter NIC MACs", 0),
        link("vCenter session ok?", "Stop vCenter login failed", 1),
        link("Fetch vCenter NIC MACs", "Join inventory"),
        link("Join inventory", "Fetch ntopng host details"),
        link("Fetch ntopng host details", "HTTP NetBox site check"),
        link("HTTP NetBox site check", "Ensure NetBox foundation"),
        link("Ensure NetBox foundation", "Sync all assets into NetBox"),
        link("Sync all assets into NetBox", "Sync succeeded?"),
        link("Sync succeeded?", "Discord: sync finished", 0),
    ]

    connections: dict = {}
    for src, dst, idx, dst_index in edges:
        connections.setdefault(src, {}).setdefault("main", [])
        mains = connections[src]["main"]
        while len(mains) <= idx:
            mains.append([])
        mains[idx].append({"node": dst, "type": "main", "index": dst_index})

    workflow = {
        "name": "Update Netbox",
        "nodes": nodes,
        "connections": connections,
        "settings": {
            "executionOrder": "v1",
            "binaryMode": "separate",
            "timezone": "Asia/Riyadh",
        },
        "staticData": None,
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": True},
    }
    out = HERE / "update-netbox.json"
    out.write_text(json.dumps(workflow, indent=2) + "\n")
    print(f"Wrote {out} ({len(nodes)} nodes)")


if __name__ == "__main__":
    main()
