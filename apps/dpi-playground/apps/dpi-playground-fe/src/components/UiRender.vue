<script setup lang="ts">
// Renders one agent-made view from the closed catalog in dpi-sdk/src/ui-spec.ts. Read-only: no
// component has an action. Markdown goes through the same DOMPurify path as transcripts.
import type { UiNode } from "@sdk/ui-spec";
import { markdown } from "../client/markdown";

defineOptions({ name: "UiRender" });
defineProps<{ node: UiNode }>();
</script>

<template>
  <section v-if="node.type === 'card'" class="ui-card">
    <h4 v-if="node.title">{{ node.title }}</h4>
    <UiRender v-for="(child, i) in node.children" :key="i" :node="child" />
  </section>
  <div v-else-if="node.type === 'row'" class="ui-row">
    <UiRender v-for="(child, i) in node.children" :key="i" :node="child" />
  </div>
  <div v-else-if="node.type === 'column'" class="ui-column">
    <UiRender v-for="(child, i) in node.children" :key="i" :node="child" />
  </div>
  <p v-else-if="node.type === 'text'" class="ui-text" :class="node.tone">{{ node.text }}</p>
  <div v-else-if="node.type === 'markdown'" class="ui-markdown" v-html="markdown(node.text)" />
  <div v-else-if="node.type === 'metric'" class="ui-metric">
    <strong
      >{{ node.value }}<small v-if="node.unit"> {{ node.unit }}</small></strong
    >
    <span>{{ node.label }}</span>
  </div>
  <span v-else-if="node.type === 'badge'" class="ui-badge" :class="node.tone">{{ node.text }}</span>
  <div v-else-if="node.type === 'progress'" class="ui-progress">
    <span v-if="node.label">{{ node.label }}</span>
    <div
      class="bar"
      role="progressbar"
      :aria-valuenow="Math.round(node.value * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <i :style="{ width: `${node.value * 100}%` }" />
    </div>
    <small>{{ Math.round(node.value * 100) }}%</small>
  </div>
  <ul v-else-if="node.type === 'list'" class="ui-list">
    <li v-for="(item, i) in node.items" :key="i">{{ item }}</li>
  </ul>
  <table v-else-if="node.type === 'table'" class="ui-table">
    <thead>
      <tr>
        <th v-for="(c, i) in node.columns" :key="i">{{ c }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, r) in node.rows" :key="r">
        <td v-for="(cell, i) in row" :key="i">{{ cell }}</td>
      </tr>
    </tbody>
  </table>
</template>
