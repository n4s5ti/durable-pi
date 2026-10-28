<script setup lang="ts">
// The network as a live, read-only graph from the hub's AG-UI stream (/api/agui), with the views
// agents published (ui-tools add-on) under it. Clicking a session or agent only opens it here;
// nothing on this view writes to a device.
import { computed, onBeforeUnmount } from "vue";
import { canvasLive, canvasLoaded, canvasState, useCanvasFeed } from "../client/agui";
import { layoutCanvas, NODE_H, NODE_W, type CanvasNode } from "../client/canvas-layout";
import { select, ui } from "../client/store";
import UiRender from "./UiRender.vue";

const release = useCanvasFeed();
onBeforeUnmount(release);

const PAD = 24;
const layout = computed(() => layoutCanvas(canvasState.value));
const byKey = computed(() => new Map(layout.value.nodes.map((n) => [n.key, n])));
const hidden = computed(() => {
  const s = canvasState.value;
  let sessions = 0;
  let agents = 0;
  for (const d of Object.values(s.devices)) {
    sessions += d.moreSessions;
    for (const x of Object.values(d.sessions)) agents += x.moreAgents;
  }
  return { devices: s.moreDevices, sessions, agents };
});

/** Every agent's published views, newest first, with who made them. */
const views = computed(() =>
  Object.values(canvasState.value.devices)
    .flatMap((d) =>
      Object.values(d.sessions).flatMap((s) =>
        Object.values(s.agents).flatMap((a) =>
          Object.values(a.views).map((v) => ({
            ...v,
            key: `${d.id}/${s.id}/${a.id}/${v.id}`,
            owner: `${a.name} · ${s.name}`,
            busy: a.busy,
          })),
        ),
      ),
    )
    .sort((x, y) => y.updatedAt - x.updatedAt),
);

const curve = (fromKey: string, toKey: string) => {
  const a = byKey.value.get(fromKey);
  const b = byKey.value.get(toKey);
  if (!a || !b) return "";
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
};

const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const active = (n: CanvasNode) =>
  n.type === "device"
    ? n.status === "online"
    : n.type === "session" || n.type === "agent"
      ? n.busy
      : false;

function open(n: CanvasNode) {
  if (n.type === "agent")
    select({ deviceId: n.deviceId, sessionId: n.sessionId, agentId: n.agentId });
  else if (n.type === "session" && n.firstAgentId !== undefined)
    select({ deviceId: n.deviceId, sessionId: n.sessionId, agentId: n.firstAgentId });
  else return;
  ui.canvas = false;
}
</script>

<template>
  <section class="canvas-view" aria-label="Network canvas">
    <header class="canvas-head">
      <div>
        <span class="eyebrow">LIVE CANVAS · READ ONLY</span>
        <span v-if="canvasLoaded && !canvasLive" class="canvas-stale" role="status"
          >Stream lost. Showing the last state while the hub reconnects.</span
        >
      </div>
      <span class="canvas-legend"
        ><i class="busy" />busy <i class="online" />online <i />idle or offline</span
      >
    </header>
    <div v-if="!canvasLoaded" class="canvas-empty">Connecting to the hub…</div>
    <div v-else-if="!layout.nodes.length" class="canvas-empty">No devices in dpi-network.yaml.</div>
    <div v-else class="canvas-scroll" :class="{ stale: !canvasLive }">
      <svg
        :width="layout.width + PAD * 2"
        :height="layout.height + PAD * 2"
        :viewBox="`${-PAD} ${-PAD} ${layout.width + PAD * 2} ${layout.height + PAD * 2}`"
        role="img"
        aria-label="Devices, sessions and agents"
      >
        <path
          v-for="e in layout.edges"
          :key="e.key"
          class="canvas-edge"
          :class="{ hot: active(byKey.get(e.to)!) && byKey.get(e.to)!.type !== 'device' }"
          :d="curve(e.from, e.to)"
        />
        <g
          v-for="n in layout.nodes"
          :key="n.key"
          class="canvas-node"
          :class="[
            n.type,
            {
              busy: n.type !== 'device' && active(n),
              online: n.type === 'device' && n.status === 'online',
              clickable: n.type !== 'device',
            },
          ]"
          :transform="`translate(${n.x},${n.y})`"
          :tabindex="n.type === 'device' ? undefined : 0"
          @click="open(n)"
          @keydown.enter="open(n)"
        >
          <title>{{ n.label }} · {{ n.detail }}</title>
          <rect :width="NODE_W" :height="NODE_H" rx="7" />
          <text x="12" y="19" class="label">{{ short(n.label, 22) }}</text>
          <text x="12" y="35" class="detail">{{ short(n.detail, 28) }}</text>
        </g>
      </svg>
    </div>
    <section v-if="views.length" class="canvas-views" aria-label="Agent views">
      <article v-for="v in views" :key="v.key" class="canvas-view-card" :class="{ busy: v.busy }">
        <header>
          <strong>{{ v.title }}</strong>
          <small
            >{{ v.owner }}<template v-if="v.template"> · {{ v.template }}</template></small
          >
        </header>
        <UiRender :node="v.spec" />
      </article>
    </section>
    <footer v-if="hidden.devices || hidden.sessions || hidden.agents" class="canvas-more">
      Not drawn: {{ hidden.devices }} devices, {{ hidden.sessions }} sessions,
      {{ hidden.agents }} agents (canvas limits).
    </footer>
  </section>
</template>
