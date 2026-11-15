/*
 * fluvy-net-map — a calm network map for Home Assistant, skinned with Fluvy's tokens.
 *
 * Data: the UniFi Network Map integration's enriched payload
 *   GET /api/unifi_network_map/<entry_id>/payload  (HA session auth via hass.callApi)
 * Optional: a sensor whose `result` attribute holds UnPoller's
 *   count by (ap_name, radio) (unpoller_client_uptime_seconds{wired="false"})
 * for exact per-AP band splits, and WAN sensors for the internet node.
 *
 * Infrastructure (gateway, switches, APs) is drawn as nodes; clients are folded into one
 * bubble per AP (wireless) and one per switch/gateway (wired). Tap a node for its clients.
 */

const VERSION = "0.2.0";

const BAND_LABEL = { "6e": "6 GHz", na: "5 GHz", ng: "2.4 GHz" };
const BAND_SHORT = { "6e": "6", na: "5", ng: "2.4" };
const BAND_COLOR = {
  "6e": "var(--fluvy-graph-3, #a78bfa)",
  na: "var(--fluvy-accent, var(--primary-color, #4fb8a4))",
  ng: "var(--fluvy-warning, var(--warning-color, #e0a64a))",
};
const ICON = {
  wan: "mdi:web",
  gateway: "mdi:router-network",
  switch: "mdi:switch",
  ap: "mdi:access-point",
  wireless: "mdi:wifi",
  wired: "mdi:ethernet",
};

function bandFromChannel(ch) {
  const c = Number(ch);
  if (!Number.isFinite(c) || c <= 0) return null;
  if (c <= 14) return "ng";
  const fiveA = c >= 36 && c <= 64 && c % 4 === 0;
  const fiveB = c >= 100 && c <= 144 && c % 4 === 0;
  const fiveC = c >= 149 && c <= 177 && (c - 149) % 4 === 0;
  if (fiveA || fiveB || fiveC) return "na";
  return "6e";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function fmtRate(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "–";
  if (unit === "Mbit/s" || unit === "Mb/s") {
    return n >= 10 ? `${n.toFixed(0)} Mb/s` : n >= 1 ? `${n.toFixed(1)} Mb/s` : `${Math.round(n * 1000)} kb/s`;
  }
  return `${n} ${unit ?? ""}`.trim();
}

class FluvyNetMap extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._payload = null;
    this._error = null;
    this._selected = null;
    this._width = 0;
    this._timer = null;
    this._fetching = false;
  }

  static getStubConfig() {
    return { entry_id: "" };
  }

  setConfig(config) {
    if (!config || !config.entry_id) {
      throw new Error("fluvy-net-map: set `entry_id` (the UniFi Network Map config entry)");
    }
    this._config = {
      title: "Network map",
      refresh: 60,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._fetch();
    else this._renderWanOnly();
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  connectedCallback() {
    this._ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (Math.abs(w - this._width) > 4) {
        this._width = w;
        this._render();
      }
    });
    this._ro.observe(this);
    const every = Math.max(15, Number(this._config?.refresh) || 60) * 1000;
    this._timer = setInterval(() => this._fetch(), every);
    if (this._hass && !this._payload) this._fetch();
  }

  disconnectedCallback() {
    this._ro?.disconnect();
    clearInterval(this._timer);
    this._timer = null;
  }

  async _fetch() {
    if (!this._hass || !this._config || this._fetching) return;
    this._fetching = true;
    try {
      this._payload = await this._hass.callApi(
        "GET",
        `unifi_network_map/${encodeURIComponent(this._config.entry_id)}/payload`,
      );
      this._error = null;
    } catch (err) {
      this._error = err?.body?.message || err?.message || String(err);
    } finally {
      this._fetching = false;
      this._render();
    }
  }

  /* ---------- model ---------- */

  _model() {
    const p = this._payload;
    if (!p || !Array.isArray(p.edges)) return null;
    const types = p.node_types || {};
    const names = p.node_names || {};
    const devDetails = p.device_details || {};
    const cliDetails = p.client_details || {};
    const entities = p.node_entities || p.client_entities || {};
    const status = p.node_status || {};

    // Resolve an edge endpoint to a node id: ids are MACs; tolerate names.
    const nameToId = {};
    for (const [id, n] of Object.entries(names)) nameToId[n] = id;
    const idOf = (x) => (x in types ? x : nameToId[x] ?? x);
    const typeOf = (id) => types[id] || (cliDetails[id] ? "client" : "client");
    const nameOf = (id) => names[id] || devDetails[id]?.name || cliDetails[id]?.name || id;

    const adj = {};
    const edgeInfo = {};
    for (const e of p.edges) {
      const a = idOf(e.left);
      const b = idOf(e.right);
      (adj[a] ||= []).push(b);
      (adj[b] ||= []).push(a);
      edgeInfo[`${a}|${b}`] = e;
      edgeInfo[`${b}|${a}`] = e;
    }

    // Root: first gateway.
    const gatewayIds = Object.keys(types).filter((id) => types[id] === "gateway");
    const rootId = gatewayIds[0] || (p.gateways && idOf(p.gateways[0])) || Object.keys(adj)[0];
    if (!rootId) return null;

    // BFS for parents.
    const parent = { [rootId]: null };
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of adj[cur] || []) {
        if (!(nb in parent)) {
          parent[nb] = cur;
          queue.push(nb);
        }
      }
    }

    const bandsAttr = this._config.bands_entity
      ? this._hass?.states[this._config.bands_entity]?.attributes?.result
      : null;

    const mkInfra = (id) => ({
      id,
      kind: typeOf(id),
      name: nameOf(id),
      sub: devDetails[id]?.ip || devDetails[id]?.model_name || "",
      model: devDetails[id]?.model_name || "",
      children: [],
      clients: [],
      online: status[id] ? status[id] !== "offline" : true,
    });

    const infra = {};
    const order = Object.keys(parent);
    for (const id of order) {
      if (typeOf(id) !== "client") infra[id] = mkInfra(id);
    }
    for (const id of order) {
      const par = parent[id];
      if (par == null) continue;
      if (infra[id]) {
        // infra under nearest infra ancestor
        let a = par;
        while (a != null && !infra[a]) a = parent[a];
        if (a != null) infra[a].children.push(infra[id]);
      } else {
        let a = par;
        while (a != null && !infra[a]) a = parent[a];
        if (a == null) continue;
        const e = edgeInfo[`${par}|${id}`] || {};
        const d = cliDetails[id] || {};
        const wireless = e.wireless === true || d.is_wired === false;
        infra[a].clients.push({
          id,
          name: nameOf(id),
          ip: d.ip || "",
          network: d.network || (d.vlan != null ? `VLAN ${d.vlan}` : ""),
          wireless,
          band: wireless ? bandFromChannel(e.channel) : null,
          port: !wireless ? e.label || "" : "",
          signal: e.connection?.signal_dbm ?? null,
          entity:
            typeof entities[id] === "string"
              ? entities[id]
              : typeof entities[id]?.entity_id === "string"
                ? entities[id].entity_id
                : null,
          online: status[id] ? status[id] !== "offline" : true,
        });
      }
    }

    // Fold clients into group leaves.
    const groups = [];
    const addGroups = (node) => {
      const wl = node.clients.filter((c) => c.wireless);
      const wd = node.clients.filter((c) => !c.wireless);
      if (wl.length) {
        const split = this._bandSplit(node, wl, bandsAttr);
        const g = { id: `${node.id}#wl`, kind: "wireless", name: `${wl.length} clients`, clients: wl, split, children: [] };
        node.children.push(g);
        groups.push(g);
      }
      if (wd.length) {
        const g = { id: `${node.id}#wd`, kind: "wired", name: `${wd.length} wired`, clients: wd, children: [] };
        node.children.push(g);
        groups.push(g);
      }
      for (const ch of node.children) if (ch.kind !== "wireless" && ch.kind !== "wired") addGroups(ch);
    };
    const root = infra[rootId];
    addGroups(root);

    // Sort children: infra first (switch, ap), then groups; stable by name.
    const rank = { switch: 0, ap: 1, gateway: 0, wired: 2, wireless: 3 };
    const sortRec = (n) => {
      n.children.sort((a, b) => (rank[a.kind] ?? 5) - (rank[b.kind] ?? 5) || String(a.name).localeCompare(String(b.name)));
      n.children.forEach(sortRec);
    };
    sortRec(root);

    const wan = this._wanNode();
    if (wan) {
      wan.children = [root];
      return { root: wan, groups };
    }
    return { root, groups };
  }

  _bandSplit(apNode, wl, bandsAttr) {
    const counts = { "6e": 0, na: 0, ng: 0 };
    let exact = false;
    if (Array.isArray(bandsAttr)) {
      for (const r of bandsAttr) {
        if (r?.metric?.ap_name === apNode.name && r.metric.radio in counts) {
          counts[r.metric.radio] += Number(r.value?.[1]) || 0;
          exact = true;
        }
      }
    }
    if (!exact) for (const c of wl) if (c.band) counts[c.band] += 1;
    return counts;
  }

  _wanNode() {
    const c = this._config;
    if (!c.latency_entity && !c.download_entity && !c.upload_entity) return null;
    const st = (e) => (e ? this._hass?.states[e] : null);
    const lat = st(c.latency_entity);
    const dn = st(c.download_entity);
    const up = st(c.upload_entity);
    const parts = [];
    if (lat && !isNaN(parseFloat(lat.state))) parts.push(`${Math.round(parseFloat(lat.state))} ms`);
    if (dn) parts.push(`↓ ${fmtRate(dn.state, dn.attributes.unit_of_measurement)}`);
    if (up) parts.push(`↑ ${fmtRate(up.state, up.attributes.unit_of_measurement)}`);
    return { id: "__wan", kind: "wan", name: c.wan_name || "Internet", sub: parts.join(" · "), children: [], clients: [] };
  }

  /* ---------- layout ---------- */

  _layout(root, width) {
    const horizontal = width >= 600;
    const leaves = [];
    let maxDepth = 0;
    const walk = (n, d) => {
      n.depth = d;
      maxDepth = Math.max(maxDepth, d);
      if (!n.children.length) leaves.push(n);
      n.children.forEach((ch) => walk(ch, d + 1));
    };
    walk(root, 0);

    const pad = 16;
    const nodeW = horizontal ? 132 : Math.max(76, Math.min(120, Math.floor((width - pad * 2) / Math.max(1, leaves.length))));
    const leafGap = horizontal ? 76 : nodeW;
    const levelGap = horizontal
      ? Math.max(nodeW + 24, (width - pad * 2 - nodeW) / Math.max(1, maxDepth))
      : 96;

    leaves.forEach((l, i) => (l.slot = i));
    const place = (n) => {
      if (n.children.length) {
        n.children.forEach(place);
        n.slot = (n.children[0].slot + n.children[n.children.length - 1].slot) / 2;
      }
    };
    place(root);

    const all = [];
    const collect = (n) => {
      all.push(n);
      n.children.forEach(collect);
    };
    collect(root);

    const span = (leaves.length - 1) * leafGap;
    let height;
    let contentW;
    if (horizontal) {
      contentW = Math.max(width, Math.ceil(pad * 2 + nodeW + maxDepth * levelGap));
      height = Math.max(220, span + 120);
      const top = (height - span) / 2;
      for (const n of all) {
        n.x = pad + nodeW / 2 + n.depth * levelGap;
        n.y = top + n.slot * leafGap;
      }
    } else {
      contentW = Math.max(width, Math.ceil(pad * 2 + leaves.length * leafGap));
      height = maxDepth * levelGap + 120;
      const left = (contentW - span) / 2;
      for (const n of all) {
        n.x = left + n.slot * leafGap;
        n.y = 44 + n.depth * levelGap;
      }
    }
    return { all, height, horizontal, nodeW, contentW };
  }

  /* ---------- render ---------- */

  _renderWanOnly() {
    // Cheap refresh of the WAN node text when hass updates.
    const el = this.shadowRoot?.querySelector("[data-wan] .sub");
    const wan = this._payload ? this._wanNode() : null;
    if (el && wan) el.textContent = wan.sub;
  }

  _render() {
    if (!this._config) return;
    // ha-card has 16px padding each side; lay out in the inner width.
    const width = Math.max(240, (this._width || this.clientWidth || 360) - 32);
    const prevScroll = this.shadowRoot.querySelector(".scroll");
    if (prevScroll) this._scrollLeft = prevScroll.scrollLeft;
    const model = this._model();
    let contentWidth = width;
    let body = "";
    let headSub = "";

    if (this._error) {
      body = `<div class="empty">Map unavailable: ${esc(this._error)}</div>`;
    } else if (!model) {
      body = `<div class="empty">${this._payload ? "No topology yet" : "Loading…"}</div>`;
    } else {
      const { all, height, horizontal, nodeW, contentW } = this._layout(model.root, width);
      contentWidth = contentW;
      const nClients = model.groups.reduce((s, g) => s + g.clients.length, 0);
      const nInfra = all.filter((n) => ["gateway", "switch", "ap"].includes(n.kind)).length;
      headSub = `${nInfra} devices · ${nClients} clients`;

      const paths = [];
      for (const n of all) {
        for (const ch of n.children) {
          const wireless = ch.kind === "wireless";
          const d = horizontal
            ? `M${n.x},${n.y} C${(n.x + ch.x) / 2},${n.y} ${(n.x + ch.x) / 2},${ch.y} ${ch.x},${ch.y}`
            : `M${n.x},${n.y} C${n.x},${(n.y + ch.y) / 2} ${ch.x},${(n.y + ch.y) / 2} ${ch.x},${ch.y}`;
          const cls = n.kind === "wan" ? "wan" : wireless ? "wl" : "wd";
          paths.push(`<path class="link ${cls}" d="${d}"/>`);
        }
      }

      const nodes = all.map((n) => this._nodeHtml(n, nodeW)).join("");
      const overflow = contentW > width + 1 ? " overflow" : "";
      body = `
        <div class="scroll${overflow}">
          <div class="map ${horizontal ? "h" : "v"}" style="width:${contentW}px;height:${Math.round(height)}px">
            <svg class="links" width="${contentW}" height="${Math.round(height)}">${paths.join("")}</svg>
            ${nodes}
          </div>
        </div>
        ${this._detailHtml(all)}`;
    }

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="head">
          <div class="circle"><ha-icon icon="mdi:lan"></ha-icon></div>
          <div class="titles">
            <div class="title">${esc(this._config.title)}</div>
            <div class="subtitle">${esc(headSub)}</div>
          </div>
        </div>
        ${body}
      </ha-card>`;

    const sc = this.shadowRoot.querySelector(".scroll");
    if (sc) {
      // First paint: centre the tree; afterwards keep where the user panned to.
      sc.scrollLeft = this._scrollLeft ?? Math.max(0, (contentWidth - width) / 2);
      const fade = () => {
        sc.classList.toggle("at-start", sc.scrollLeft <= 2);
        sc.classList.toggle("at-end", sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 2);
      };
      sc.addEventListener("scroll", () => { this._scrollLeft = sc.scrollLeft; fade(); }, { passive: true });
      fade();
    }

    this.shadowRoot.querySelectorAll("[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        this._selected = this._selected === id ? null : id;
        this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const entityId = el.getAttribute("data-entity");
        if (!entityId) return;
        this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
      });
    });
  }

  _nodeHtml(n, nodeW) {
    const sel = this._selected === n.id ? " sel" : "";
    const style = `left:${n.x}px;top:${n.y}px;width:${nodeW}px`;
    if (n.kind === "wireless" || n.kind === "wired") {
      const split =
        n.kind === "wireless" && n.split
          ? `<div class="split">${["6e", "na", "ng"]
              .filter((b) => n.split[b])
              .map((b) => `<span><i style="background:${BAND_COLOR[b]}"></i>${BAND_SHORT[b]} ${n.split[b]}</span>`)
              .join("")}</div>`
          : "";
      return `
        <button class="node group ${n.kind}${sel}" data-id="${esc(n.id)}" style="${style}">
          <ha-icon icon="${ICON[n.kind]}"></ha-icon>
          <div class="name">${esc(n.name)}</div>
          ${split}
        </button>`;
    }
    const off = n.online === false ? " off" : "";
    const tag = n.kind === "wan" ? "div" : "button";
    return `
      <${tag} class="node infra ${n.kind}${sel}${off}" ${n.kind === "wan" ? 'data-wan="1"' : `data-id="${esc(n.id)}"`} style="${style}">
        <div class="dot"><ha-icon icon="${ICON[n.kind] || "mdi:help-network"}"></ha-icon></div>
        <div class="name">${esc(n.name)}</div>
        <div class="sub">${esc(n.sub || "")}</div>
      </${tag}>`;
  }

  _detailHtml(all) {
    if (!this._selected) return "";
    const n = all.find((x) => x.id === this._selected);
    if (!n) return "";
    let rows = [];
    let heading = n.name;
    if (n.kind === "wireless" || n.kind === "wired") {
      const parentNode = all.find((x) => x.children.includes(n));
      heading = `${parentNode ? parentNode.name + " · " : ""}${n.kind === "wireless" ? "Wi-Fi" : "Wired"}`;
      rows = [...n.clients].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } else {
      rows = [...(n.clients || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    const meta = n.model ? `<div class="dsub">${esc(n.model)}${n.sub && n.sub !== n.model ? " · " + esc(n.sub) : ""}</div>` : "";
    const list = rows.length
      ? rows
          .map((c) => {
            const right = c.wireless
              ? `${c.band ? `<span class="pill" style="--b:${BAND_COLOR[c.band]}">${BAND_LABEL[c.band]}</span>` : ""}${c.signal != null ? `<span class="sig">${esc(c.signal)} dBm</span>` : ""}`
              : c.port
                ? `<span class="pill">${esc(c.port)}</span>`
                : "";
            const second = [c.ip, c.network].filter(Boolean).map(esc).join(" · ");
            return `
              <div class="row${c.online ? "" : " off"}" data-entity="${esc(c.entity || "")}">
                <ha-icon icon="${c.wireless ? "mdi:wifi" : "mdi:ethernet"}"></ha-icon>
                <div class="rtext"><div class="rname">${esc(c.name)}</div><div class="rsub">${second}</div></div>
                <div class="rright">${right}</div>
              </div>`;
          })
          .join("")
      : `<div class="empty small">No clients here</div>`;
    return `
      <div class="detail">
        <div class="dhead"><div class="dtitle">${esc(heading)}</div><div class="dcount">${rows.length}</div></div>
        ${meta}
        <div class="rows">${list}</div>
      </div>`;
  }
}

const STYLE = `
  :host { display: block; }
  ha-card {
    overflow: hidden;
    padding: 16px;
    background: var(--fluvy-card, var(--ha-card-background, var(--card-background-color)));
    border-radius: var(--ha-card-border-radius, 20px);
    color: var(--primary-text-color);
  }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .circle {
    width: 40px; height: 40px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--fluvy-inset, var(--fluvy-page, rgba(127,127,127,.12)));
    color: var(--fluvy-accent, var(--primary-color));
    --mdc-icon-size: 20px;
  }
  .title { font-weight: 600; font-size: 15px; line-height: 20px; }
  .subtitle { font-size: 12px; color: var(--secondary-text-color); line-height: 16px; }
  .empty { padding: 32px 8px; text-align: center; color: var(--secondary-text-color); font-size: 13px; }
  .empty.small { padding: 12px; }

  .scroll {
    overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    touch-action: pan-x pan-y;
    scrollbar-width: none;
  }
  .scroll::-webkit-scrollbar { display: none; }
  .scroll.overflow { -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%); }
  .scroll.overflow.at-start { -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent 100%); mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent 100%); }
  .scroll.overflow.at-end { -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 24px); mask-image: linear-gradient(90deg, transparent 0, #000 24px); }
  .scroll.overflow.at-start.at-end { -webkit-mask-image: none; mask-image: none; }
  .map { position: relative; }
  .links { position: absolute; inset: 0; overflow: visible; }
  .link { fill: none; stroke-width: 2; stroke-linecap: round; }
  .link.wd { stroke: var(--fluvy-accent, var(--primary-color)); opacity: .55; }
  .link.wl { stroke: var(--fluvy-accent, var(--primary-color)); opacity: .45; stroke-dasharray: 5 5; }
  .link.wan { stroke: var(--secondary-text-color); opacity: .45; stroke-dasharray: 2 5; }

  .node {
    position: absolute; transform: translate(-50%, -50%);
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: none; border: 0; padding: 0; margin: 0; cursor: pointer;
    color: inherit; font: inherit; text-align: center;
    -webkit-tap-highlight-color: transparent;
  }
  .node .name {
    font-size: 12px; font-weight: 600; line-height: 15px; max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .node .sub {
    font-size: 10.5px; line-height: 13px; color: var(--secondary-text-color); max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .infra .dot {
    width: 40px; height: 40px; border-radius: 50%;
    display: grid; place-items: center; margin-bottom: 4px;
    background: var(--fluvy-accent, var(--primary-color));
    color: var(--fluvy-on-accent, #fff);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--fluvy-accent, var(--primary-color)) 18%, transparent);
    --mdc-icon-size: 20px;
    transition: transform .15s ease;
  }
  .infra.gateway .dot { width: 48px; height: 48px; --mdc-icon-size: 24px; }
  .infra.ap .dot { width: 34px; height: 34px; --mdc-icon-size: 18px; }
  .infra.wan .dot {
    background: var(--fluvy-inset, var(--fluvy-page, rgba(127,127,127,.15)));
    color: var(--primary-text-color); box-shadow: none; cursor: default;
  }
  .infra.wan { cursor: default; }
  .infra.off .dot { background: var(--error-color, #e5484d); }
  .infra.sel .dot { transform: scale(1.08); box-shadow: 0 0 0 6px color-mix(in srgb, var(--fluvy-accent, var(--primary-color)) 35%, transparent); }

  .group {
    padding: 8px 10px; border-radius: 14px;
    background: var(--fluvy-inset, var(--fluvy-page, rgba(127,127,127,.12)));
    border: 1px solid var(--fluvy-edge, var(--fluvy-border, transparent));
    --mdc-icon-size: 16px;
  }
  .group ha-icon { color: var(--secondary-text-color); }
  .group.sel { border-color: var(--fluvy-accent, var(--primary-color)); }
  .split { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-top: 2px; }
  .split span { font-size: 10.5px; color: var(--secondary-text-color); display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; }
  .split i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }

  .detail {
    margin-top: 12px; padding: 12px; border-radius: 16px;
    background: var(--fluvy-inset, var(--fluvy-page, rgba(127,127,127,.08)));
  }
  .dhead { display: flex; justify-content: space-between; align-items: baseline; }
  .dtitle { font-weight: 600; font-size: 14px; }
  .dcount { font-size: 12px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .dsub { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
  .rows { margin-top: 8px; display: flex; flex-direction: column; }
  .row {
    display: flex; align-items: center; gap: 10px; padding: 8px 2px;
    border-top: 1px solid var(--fluvy-edge, var(--fluvy-border, var(--divider-color)));
    cursor: pointer; --mdc-icon-size: 18px;
  }
  .row:first-child { border-top: 0; }
  .row ha-icon { color: var(--secondary-text-color); flex: none; }
  .row.off { opacity: .5; }
  .rtext { flex: 1; min-width: 0; }
  .rname { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rsub { font-size: 11px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .rright { display: flex; gap: 6px; align-items: center; flex: none; }
  .pill {
    font-size: 10.5px; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
    background: color-mix(in srgb, var(--b, var(--secondary-text-color)) 18%, transparent);
    color: var(--b, var(--secondary-text-color));
  }
  .sig { font-size: 11px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
`;

if (!customElements.get("fluvy-net-map")) {
  customElements.define("fluvy-net-map", FluvyNetMap);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fluvy-net-map",
    name: "Fluvy net map",
    description: "A calm UniFi network map in Fluvy's skin (needs the UniFi Network Map integration).",
    preview: false,
  });
  console.info(`%c fluvy-net-map %c ${VERSION} `, "background:#3e9e88;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
}
