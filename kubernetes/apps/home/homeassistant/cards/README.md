# Home Assistant: Network dashboard

Source of truth for the **Network** dashboard (`/dashboard-network`) and its custom map card.
Nothing in this folder is applied by Flux: the `homeassistant` Kustomization only builds `../app`.
Everything here is installed into Home Assistant by hand (or through ha-mcp), and the live copies
sit on the HA config volume (`home-assistant-config`, backed up by Volsync).

## Data path

```
UniFi UDM SE ──▶ UnPoller (monitoring/unpoller) ──▶ VictoriaMetrics ──▶ HA rest: sensors ──▶ Fluvy cards
UniFi UDM SE ──▶ UniFi Network Map integration (HACS) ──▶ /api/unifi_network_map/<entry>/payload ──▶ fluvy-net-map
```

## Files

| File | What it is | Live copy |
|------|------------|-----------|
| `fluvy-net-map.js` | Custom card `custom:fluvy-net-map`: WAN → gateway → switches → APs, clients folded per AP / switch, tap for the client list. Skinned with Fluvy's `--fluvy-*` tokens. | Dashboard resource (module, inline `data:` URI), id `d72b5bc19dbe4c42a02b2f779e359faf`, in `/config/.storage/lovelace_resources` |
| `network-rest-sensors.yaml` | The four `rest:` entries querying VictoriaMetrics (client counts, internet, busiest clients, access points). | Appended to the `rest:` list in `/config/configuration.yaml`, after the Klimerko entries |
| `network-dashboard.json` | Raw config of the `dashboard-network` storage dashboard. | `/config/.storage/lovelace.dashboard_network` |

Not in YAML, created as UI helpers: `sensor.internet_downloaded_today` / `sensor.internet_uploaded_today`
(utility meter, daily, sources `sensor.internet_*_total`) and `sensor.network_devices_offline`
(template sensor: count of `device_tracker`s with `source_type: router` not `home`).

## Requirements

- UnPoller running and scraped (`kubernetes/apps/monitoring/unpoller`).
- HACS: **Fluvy** (theme + cards) and **UniFi Network Map** (`merlijntishauser/unifi-network-maps-ha`).
  The map integration's own card is not used; it is only the data source. Options: `client_scope: all`.
- The card's `entry_id` is that integration's config entry (`01M7E85N372HKBTRDQQKNNZN8C` today);
  re-adding the integration changes it.

## Updating the card

1. Edit `fluvy-net-map.js` here and bump `VERSION`.
2. Re-register it: Settings → Dashboards → ⋮ → Resources → the `data:` module → replace it, or with
   ha-mcp `ha_config_set_dashboard_resource(resource_id="d72b5bc19dbe4c42a02b2f779e359faf", content=<file>)`.
   The inline URI changes with the content, so clients pick it up on reload (Companion app: Settings →
   Companion app → Troubleshooting → Reset frontend cache if it sticks).
3. Commit.

## Restoring from scratch

1. Install Fluvy and UniFi Network Map from HACS, add the map integration (local UniFi user), set `client_scope: all`.
2. Append `network-rest-sensors.yaml`'s entries to `rest:` in `configuration.yaml`, check config, reload RESTful.
3. Recreate the three UI helpers above.
4. Add `fluvy-net-map.js` as a JavaScript module resource.
5. Create a dashboard `dashboard-network`, open the raw config editor, paste `network-dashboard.json`,
   and fix `entry_id` if the integration was re-added.

## Known caveats

- Per-client Wi-Fi band in the map's client list is derived from the channel number; a few 6 GHz channels
  (149–177) read as 5 GHz. Per-AP band totals come from UnPoller and are exact.
- In "Busy right now", UnPoller's client `rx` is shown as download and `tx` as upload. Not yet confirmed
  against a known stream; swap them in the `items_template` if it reads backwards.
