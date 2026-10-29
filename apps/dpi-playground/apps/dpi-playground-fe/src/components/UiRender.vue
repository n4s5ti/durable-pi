<script setup lang="ts">
// Renders one agent-made view from the closed catalog in dpi-sdk/src/ui-spec.ts. Bound fields
// ({"@path"}, {"@template"}) read the view's data model live (client/ui-data.ts); each repeats a
// child per item; when hides a component; button runs a named action. Markdown goes through the
// same DOMPurify path as transcripts.
import { computed } from "vue";
import {
  absolutePath,
  resolveValue,
  uiText,
  whenHolds,
  UI_LIMITS,
  UI_TONES,
  type UiNode,
  type UiScope,
  type UiTone,
} from "@sdk/ui-spec";
import { markdown } from "../client/markdown";
import { useUiData } from "../client/ui-data";
import UiInput from "./UiInput.vue";

defineOptions({ name: "UiRender" });
const props = withDefaults(defineProps<{ node: UiNode; scope?: UiScope }>(), { scope: () => ({}) });
const data = useUiData();

const n = computed(() => props.node as Record<string, unknown>);
const val = (key: string) => resolveValue(n.value[key], props.scope, data.read);
const txt = (key: string) => uiText(val(key));
const tone = computed(() => {
  const t = val("tone");
  return UI_TONES.includes(t as UiTone) ? (t as string) : undefined;
});
const strings = (key: string, max: number) => {
  const v = val(key);
  return Array.isArray(v) ? v.slice(0, max).map(uiText) : [];
};
const rows = computed(() => {
  const v = val("rows");
  return Array.isArray(v) ? v.slice(0, UI_LIMITS.items).map((r) => (Array.isArray(r) ? r.map(uiText) : [uiText(r)])) : [];
});
const ratio = computed(() => {
  const v = Number(val("value"));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
});
const visible = computed(() => whenHolds(props.node.when, props.scope, data.read));

/** each: the item scopes to repeat the child over. */
const items = computed<UiScope[]>(() => {
  if (props.node.type !== "each") return [];
  const base = absolutePath(props.node.path, props.scope);
  const list = data.read(base);
  return Array.isArray(list) ? list.slice(0, UI_LIMITS.items).map((_, i) => ({ base: `${base}/${i}`, index: i })) : [];
});
const inputPath = computed(() => (props.node.type === "input" ? absolutePath(props.node.path, props.scope) : ""));
const click = () => props.node.type === "button" && void data.run(props.node.action, props.scope);
</script>

<template>
  <template v-if="visible">
    <section v-if="node.type === 'card'" class="ui-card">
      <h4 v-if="node.title">{{ txt("title") }}</h4>
      <UiRender v-for="(child, i) in node.children" :key="i" :node="child" :scope="scope" />
    </section>
    <div v-else-if="node.type === 'row'" class="ui-row">
      <UiRender v-for="(child, i) in node.children" :key="i" :node="child" :scope="scope" />
    </div>
    <div v-else-if="node.type === 'column'" class="ui-column">
      <UiRender v-for="(child, i) in node.children" :key="i" :node="child" :scope="scope" />
    </div>
    <template v-else-if="node.type === 'each'">
      <UiRender v-for="s in items" :key="s.base" :node="node.child" :scope="s" />
      <p v-if="!items.length && node.empty" class="ui-text muted">{{ txt("empty") }}</p>
    </template>
    <p v-else-if="node.type === 'text'" class="ui-text" :class="tone">{{ txt("text") }}</p>
    <div v-else-if="node.type === 'markdown'" class="ui-markdown" v-html="markdown(txt('text'))" />
    <div v-else-if="node.type === 'metric'" class="ui-metric">
      <strong
        >{{ txt("value") }}<small v-if="node.unit"> {{ txt("unit") }}</small></strong
      >
      <span>{{ txt("label") }}</span>
    </div>
    <span v-else-if="node.type === 'badge'" class="ui-badge" :class="tone">{{ txt("text") }}</span>
    <div v-else-if="node.type === 'progress'" class="ui-progress">
      <span v-if="node.label">{{ txt("label") }}</span>
      <div class="bar" role="progressbar" :aria-valuenow="Math.round(ratio * 100)" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: `${ratio * 100}%` }" />
      </div>
      <small>{{ Math.round(ratio * 100) }}%</small>
    </div>
    <ul v-else-if="node.type === 'list'" class="ui-list">
      <li v-for="(item, i) in strings('items', UI_LIMITS.items)" :key="i">{{ item }}</li>
    </ul>
    <UiInput
      v-else-if="node.type === 'input'"
      :label="txt('label')"
      :path="inputPath"
      :placeholder="node.placeholder ? txt('placeholder') : undefined"
      :multiline="node.multiline"
    />
    <button
      v-else-if="node.type === 'button'"
      class="ui-button"
      :class="tone"
      :disabled="!!data.busy"
      @click="click"
    >
      {{ txt("label") }}
    </button>
    <table v-else-if="node.type === 'table'" class="ui-table">
      <thead>
        <tr>
          <th v-for="(c, i) in strings('columns', UI_LIMITS.columns)" :key="i">{{ c }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, r) in rows" :key="r">
          <td v-for="(cell, i) in row" :key="i">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
  </template>
</template>
