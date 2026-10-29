<script setup lang="ts">
// A canvas text box bound to one data path (the ui-spec `input` component). A /state path is the
// device's App State: the agent's update_state lands here as it happens, and what the user types is
// saved half a second after they pause, or on blur. Any other path is local to the view, for values
// a button reads back (a job's inputs, say). App State of another device than the selected agent's
// is shown read only.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { uiText } from "@sdk/ui-spec";
import { message } from "../client/hub";
import { useUiData } from "../client/ui-data";

const props = defineProps<{ label: string; path: string; placeholder?: string; multiline?: boolean }>();
const data = useUiData();

const stored = computed(() => data.read(props.path));
const writable = computed(() => data.writable(props.path));
const shared = computed(() => props.path.startsWith("/state/"));

const draft = ref(uiText(stored.value));
const focused = ref(false);
const saving = ref(false);
const error = ref("");
watch(stored, (v) => {
  if (!focused.value) draft.value = uiText(v);
});

let timer: ReturnType<typeof setTimeout> | undefined;
async function save() {
  clearTimeout(timer);
  timer = undefined;
  const value = draft.value;
  if (!writable.value || value === uiText(stored.value)) return;
  saving.value = shared.value;
  error.value = "";
  try {
    await data.write(props.path, value);
  } catch (e) {
    error.value = message(e);
  } finally {
    saving.value = false;
  }
}
function typed() {
  clearTimeout(timer);
  // Local values have no round trip, so they apply at once; App State waits for a pause.
  if (!shared.value) void save();
  else timer = setTimeout(() => void save(), 500);
}
function blur() {
  focused.value = false;
  void save();
}
onBeforeUnmount(() => timer && void save());
</script>

<template>
  <label class="ui-input" :class="{ saving, readonly: !writable }">
    <span class="ui-input-label"
      >{{ label }}<small>{{ saving ? "saving…" : error ? error : writable ? "" : "read only" }}</small></span
    >
    <textarea
      v-if="multiline"
      v-model="draft"
      rows="3"
      :placeholder="placeholder"
      :readonly="!writable"
      @focus="focused = true"
      @blur="blur"
      @input="typed"
    />
    <input
      v-else
      v-model="draft"
      type="text"
      :placeholder="placeholder"
      :readonly="!writable"
      @focus="focused = true"
      @blur="blur"
      @input="typed"
      @keydown.enter="save"
    />
  </label>
</template>
