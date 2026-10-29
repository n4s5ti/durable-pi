<script setup lang="ts">
// One view: owns its data model (client/ui-data.ts) for the device the view came from.
import type { UiNode } from "@sdk/ui-spec";
import { provideUiData } from "../client/ui-data";
import UiRender from "./UiRender.vue";

const props = defineProps<{ node: UiNode; deviceId?: string }>();
provideUiData(() => props.deviceId);
</script>

<template>
  <UiRender :node="node" />
</template>
