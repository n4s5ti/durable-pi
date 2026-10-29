<script setup lang="ts">
// dpi's own views of each device (prefabs) and the agents' published views (ui-tools add-on) from the
// hub's AG-UI stream (/api/agui). Blank until there is a view; views stack centered in the panel.
// Nothing here writes to a device.
import { computed, onBeforeUnmount } from "vue";
import { canvasLive, canvasLoaded, canvasState, useCanvasFeed } from "../client/agui";
import UiView from "./UiView.vue";

const release = useCanvasFeed();
onBeforeUnmount(release);

/** dpi's own views of each device (prefabs) first, in their fixed order; then agents' views, newest first. */
const views = computed(() => {
  const devices = Object.values(canvasState.value.devices);
  const own = devices.flatMap((d) =>
    Object.values(d.views ?? {}).map((v) => ({
      ...v,
      key: `${d.id}/${v.id}`,
      deviceId: d.id,
      owner: `${d.name} · dpi`,
      template: null,
      busy: false,
    })),
  );
  const agents = devices
    .flatMap((d) =>
      Object.values(d.sessions).flatMap((s) =>
        Object.values(s.agents).flatMap((a) =>
          Object.values(a.views).map((v) => ({
            ...v,
            key: `${d.id}/${s.id}/${a.id}/${v.id}`,
            deviceId: d.id,
            owner: `${a.name} · ${s.name}`,
            busy: a.busy,
          })),
        ),
      ),
    )
    .sort((x, y) => y.updatedAt - x.updatedAt);
  return [...own, ...agents];
});
</script>

<template>
  <section class="canvas-view" :class="{ blank: !views.length }" aria-label="Canvas">
    <p v-if="canvasLoaded && !canvasLive && views.length" class="canvas-stale" role="status">
      Stream lost. Showing the last state while the hub reconnects.
    </p>
    <section v-if="views.length" class="canvas-views" aria-label="Agent views">
      <article v-for="v in views" :key="v.key" class="canvas-view-card" :class="{ busy: v.busy }">
        <header>
          <strong>{{ v.title }}</strong>
          <small
            >{{ v.owner }}<template v-if="v.template"> · {{ v.template }}</template></small
          >
        </header>
        <UiView :node="v.spec" :device-id="v.deviceId" />
      </article>
    </section>
  </section>
</template>
