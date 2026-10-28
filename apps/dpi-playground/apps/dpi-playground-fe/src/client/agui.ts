// The read-only canvas feed: one EventSource on the hub's /api/agui while any view needs it.
// STATE_SNAPSHOT replaces the state and STATE_DELTA patches it. A delta that does not fit drops the
// connection for a fresh snapshot; while disconnected the last state stays up, marked stale.
import { ref, shallowRef } from "vue";
import { applyPatch, emptyCanvas, type AguiEvent, type CanvasState } from "@sdk/agui";

export const canvasState = shallowRef<CanvasState>(emptyCanvas());
export const canvasLoaded = ref(false);
export const canvasLive = ref(false);

let source: EventSource | undefined;
let users = 0;
let retry: ReturnType<typeof setTimeout> | undefined;

/** Start the feed (shared); call the returned function to release it. */
export function useCanvasFeed() {
  users++;
  if (!source && !retry) connect();
  return () => {
    if (--users > 0) return;
    clearTimeout(retry);
    retry = undefined;
    source?.close();
    source = undefined;
    canvasLive.value = false;
  };
}

function connect() {
  retry = undefined;
  source = new EventSource("/api/agui");
  source.onmessage = (m) => {
    try {
      const event = JSON.parse(m.data) as AguiEvent;
      if (event.type === "STATE_SNAPSHOT") {
        canvasState.value = event.snapshot;
        canvasLoaded.value = canvasLive.value = true;
      } else if (event.type === "STATE_DELTA" && canvasLive.value) {
        canvasState.value = applyPatch(canvasState.value, event.delta);
      }
    } catch {
      resync();
    }
  };
  // EventSource reconnects by itself, and every new connection starts with a snapshot.
  source.onerror = () => (canvasLive.value = false);
}

function resync() {
  canvasLive.value = false;
  source?.close();
  source = undefined;
  if (users > 0) retry = setTimeout(connect, 500);
}
