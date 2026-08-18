<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { Map as MLMap, Marker, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import PinModal from "./components/PinModal.vue";

type Verdict = 1 | 0 | -1;

type Pin = {
  id: number;
  lat: number;
  lng: number;
  tag: string;
  verdict: Verdict;
  created_at: number;
};

const VERDICT_META: Record<Verdict, { cls: "yum" | "meh" | "yuck"; icon: string }> = {
  1: { cls: "yum", icon: "😋" },
  0: { cls: "meh", icon: "😐" },
  [-1]: { cls: "yuck", icon: "🤢" },
};

type Pending = { lat: number; lng: number };

const MILWAUKEE: [number, number] = [-87.9065, 43.0389];

const mapEl = ref<HTMLDivElement | null>(null);
const pendingPin = ref<Pending | null>(null);

let map: MLMap | null = null;
const pinMarkers = new Map<number, { emoji: Marker; text: Marker }>();

// Deterministic rotation from pin id so labels don't jiggle on refresh.
const seededRotation = (id: number) => {
  const s = Math.sin(id * 9301.7 + 49297.3) * 43758.5453;
  const r = s - Math.floor(s); // 0..1
  return (r - 0.5) * 12; // -6° .. +6°
};

const renderPin = (pin: Pin) => {
  if (!map || pinMarkers.has(pin.id)) return;
  const { cls, icon } = VERDICT_META[pin.verdict];

  // 1) Small circular emoji badge sits at the exact coordinate.
  const emojiEl = document.createElement("div");
  emojiEl.className = `pin-emoji ${cls}`;
  emojiEl.textContent = icon;
  emojiEl.addEventListener("click", (e) => e.stopPropagation());
  const emojiMarker = new Marker({ element: emojiEl, anchor: "center" })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);

  // 2) Text lives beside it — bigger, rotated, no background.
  // Outer div is what MapLibre positions; inner div carries the rotation
  // so MapLibre's own transform doesn't clobber ours.
  const textOuter = document.createElement("div");
  const textInner = document.createElement("div");
  textInner.className = `pin-text ${cls}`;
  textInner.style.transform = `rotate(${seededRotation(pin.id).toFixed(2)}deg)`;
  textInner.textContent = pin.tag;
  textOuter.appendChild(textInner);
  textOuter.addEventListener("click", (e) => e.stopPropagation());
  const textMarker = new Marker({ element: textOuter, anchor: "top", offset: [0, 18] })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);

  pinMarkers.set(pin.id, { emoji: emojiMarker, text: textMarker });
};

const loadPins = async () => {
  try {
    const res = await fetch("/api/pins");
    if (!res.ok) return;
    const pins: Pin[] = await res.json();
    pins.forEach(renderPin);
  } catch (err) {
    console.error("failed to load pins", err);
  }
};

const submitPin = async ({ tag, verdict }: { tag: string; verdict: Verdict }) => {
  if (!pendingPin.value) return;
  const { lat, lng } = pendingPin.value;
  try {
    const res = await fetch("/api/pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat, lng, tag, verdict }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      alert(`Could not post: ${err.error ?? res.statusText}`);
      return;
    }
    const pin: Pin = await res.json();
    renderPin(pin);
  } catch (err) {
    console.error(err);
    alert("Network error.");
  } finally {
    pendingPin.value = null;
  }
};

onMounted(() => {
  if (!mapEl.value) return;
  map = new MLMap({
    container: mapEl.value,
    style: "https://tiles.openfreemap.org/styles/positron",
    center: MILWAUKEE,
    zoom: 12,
  });

  map.on("load", () => {
    if (!map) return;
    const style = map.getStyle();
    for (const layer of style.layers) {
      if (layer.type !== "symbol") continue;
      const src = (layer as { "source-layer"?: string })["source-layer"];
      const id = layer.id.toLowerCase();
      const isRoadLabel =
        src === "transportation_name" ||
        id.includes("road") ||
        id.includes("street") ||
        id.includes("highway");
      if (isRoadLabel) {
        map.setFilter(layer.id, [
          "in",
          ["get", "class"],
          ["literal", ["motorway", "trunk", "primary", "secondary"]],
        ]);
      } else {
        map.removeLayer(layer.id);
      }
    }

    loadPins();
  });

  map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";

  map.on("click", (e) => {
    pendingPin.value = { lat: e.lngLat.lat, lng: e.lngLat.lng };
  });
});

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape" && pendingPin.value) {
    pendingPin.value = null;
  }
};
watch(pendingPin, (v) => {
  if (v) window.addEventListener("keydown", onKeydown);
  else window.removeEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  for (const { emoji, text } of pinMarkers.values()) {
    emoji.remove();
    text.remove();
  }
  pinMarkers.clear();
  map?.remove();
  map = null;
});
</script>

<template>
  <div class="header">grubmaps · milwaukee</div>
  <div class="hint">Tap the map · brutally honest, 8 words max</div>
  <div ref="mapEl" style="width: 100%; height: 100%"></div>
  <PinModal
    v-if="pendingPin"
    :lat="pendingPin.lat"
    :lng="pendingPin.lng"
    @cancel="pendingPin = null"
    @submit="submitPin"
  />
</template>
