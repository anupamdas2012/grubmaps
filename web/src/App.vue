<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { Map as MLMap, Marker, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import PinModal from "./components/PinModal.vue";
import Logo from "./components/Logo.vue";
import SearchBar from "./components/SearchBar.vue";

type Verdict = 1 | 0 | -1;
type ReactionKind = "legit" | "dispute" | "protip";

type Pin = {
  id: number;
  lat: number;
  lng: number;
  tag: string;
  verdict: Verdict;
  created_at: number;
  legit: number;
  dispute: number;
  protip: number;
};

const VERDICT_META: Record<Verdict, { cls: "yum" | "meh" | "yuck"; icon: string }> = {
  1: { cls: "yum", icon: "😋" },
  0: { cls: "meh", icon: "🫤" },
  [-1]: { cls: "yuck", icon: "💩" },
};

const REACTIONS: readonly { kind: ReactionKind; emoji: string; label: string }[] = [
  { kind: "legit", emoji: "🔥", label: "legit" },
  { kind: "dispute", emoji: "🤔", label: "dispute" },
  { kind: "protip", emoji: "🧠", label: "pro tip" },
];

type Pending = { lat: number; lng: number; placeName?: string };

const MILWAUKEE: [number, number] = [-87.9065, 43.0389];

const mapEl = ref<HTMLDivElement | null>(null);
const pendingPin = ref<Pending | null>(null);

let map: MLMap | null = null;
const pinMarkers = new Map<number, { emoji: Marker; text: Marker }>();
const pinsById = new Map<number, Pin>();

let activePopover: { marker: Marker; pinId: number } | null = null;
let searchMarker: { markers: Marker[]; lat: number; lng: number; name: string } | null = null;

// localStorage-backed set of "pinId:kind" strings I've already reacted with,
// used to highlight my reactions across sessions. Not authoritative — the
// server dedups on IP hash — but it makes the UI feel right for the same user.
const MY_KEY = "grubmaps.myReactions.v1";
const loadMine = (): Set<string> => {
  try {
    const raw = localStorage.getItem(MY_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
};
const saveMine = (s: Set<string>) => {
  try { localStorage.setItem(MY_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
};
const myReactions = loadMine();
const myKey = (pinId: number, kind: ReactionKind) => `${pinId}:${kind}`;
const hasReacted = (pinId: number, kind: ReactionKind) => myReactions.has(myKey(pinId, kind));
const currentMyReaction = (pinId: number): ReactionKind | null => {
  for (const r of REACTIONS) {
    if (myReactions.has(myKey(pinId, r.kind))) return r.kind;
  }
  return null;
};

// Deterministic pseudo-random in [0, 1) seeded on pin id + salt.
const seededUnit = (id: number, salt: number) => {
  const s = Math.sin(id * 9301.7 + salt) * 43758.5453;
  return s - Math.floor(s);
};
const seededRotation = (id: number) => (seededUnit(id, 49297.3) - 0.5) * 12; // -6° .. +6°
const seededYumDelay = (id: number) => seededUnit(id, 71723.5) * 7;

const renderPin = (pin: Pin) => {
  if (!map) return;
  pinsById.set(pin.id, pin);
  if (pinMarkers.has(pin.id)) return;
  const { cls, icon } = VERDICT_META[pin.verdict];

  // Emoji at the exact coordinate. Outer div is what MapLibre positions;
  // inner div carries any animation transform.
  const emojiOuter = document.createElement("div");
  const emojiInner = document.createElement("div");
  emojiInner.className = `pin-emoji ${cls}`;
  emojiInner.textContent = icon;
  if (cls === "yum") {
    emojiInner.style.animationDelay = `${seededYumDelay(pin.id).toFixed(2)}s`;
  }
  emojiOuter.appendChild(emojiInner);
  emojiOuter.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover(pin.id);
  });
  if (HAS_HOVER) {
    emojiOuter.addEventListener("mouseenter", () => scheduleOpen(pin.id));
    emojiOuter.addEventListener("mouseleave", scheduleClose);
  }
  const emojiMarker = new Marker({ element: emojiOuter, anchor: "center" })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);

  // Text: outer (MapLibre positions), rotation wrapper (seeded tilt),
  // inner (yum wiggle animation for yums).
  const textOuter = document.createElement("div");
  const textRot = document.createElement("div");
  textRot.style.transform = `rotate(${seededRotation(pin.id).toFixed(2)}deg)`;
  const textInner = document.createElement("div");
  textInner.className = `pin-text ${cls}`;
  textInner.textContent = pin.tag;
  if (cls === "yum") {
    textInner.style.animationDelay = `${seededYumDelay(pin.id).toFixed(2)}s`;
  }
  textRot.appendChild(textInner);
  textOuter.appendChild(textRot);
  textOuter.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover(pin.id);
  });
  if (HAS_HOVER) {
    textOuter.addEventListener("mouseenter", () => scheduleOpen(pin.id));
    textOuter.addEventListener("mouseleave", scheduleClose);
  }
  const textMarker = new Marker({ element: textOuter, anchor: "top", offset: [0, 18] })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);

  pinMarkers.set(pin.id, { emoji: emojiMarker, text: textMarker });
};

const HAS_HOVER = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

let openTimer: number | null = null;
let closeTimer: number | null = null;
let closeAnimTimer: number | null = null;
const CLOSE_ANIM_MS = 220;

const cancelOpen = () => {
  if (openTimer !== null) {
    window.clearTimeout(openTimer);
    openTimer = null;
  }
};
const cancelClose = () => {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
};
const cancelCloseAnim = () => {
  if (closeAnimTimer !== null) {
    window.clearTimeout(closeAnimTimer);
    closeAnimTimer = null;
  }
};

// FB-style timings. Open delay filters accidental fly-bys; close delay
// gives the cursor time to travel from pin to fan buttons. When the fan
// is already up on another pin, hopping to a new one snaps instantly.
const scheduleOpen = (pinId: number) => {
  cancelClose();
  if (activePopover && activePopover.pinId !== pinId) {
    cancelOpen();
    openPopover(pinId);
    return;
  }
  cancelOpen();
  openTimer = window.setTimeout(() => {
    openTimer = null;
    openPopover(pinId);
  }, 450);
};
const scheduleClose = () => {
  cancelOpen();
  cancelClose();
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    closePopover();
  }, 300);
};

const closePopover = () => {
  cancelOpen();
  cancelClose();
  if (!activePopover) return;
  // Play the close animation, then remove the marker. Keep activePopover
  // alive during the animation so a mid-close re-hover can cancel it.
  const marker = activePopover.marker;
  const pinId = activePopover.pinId;
  marker.getElement().classList.add("closing");
  cancelCloseAnim();
  closeAnimTimer = window.setTimeout(() => {
    closeAnimTimer = null;
    marker.remove();
    if (activePopover && activePopover.pinId === pinId) activePopover = null;
  }, CLOSE_ANIM_MS);
};

// Angular position of each button in the fan, measured clockwise from
// straight-up (0deg). Center button straight up, outer two flanking.
const FAN_ANGLES = ["-45deg", "0deg", "45deg"] as const;

const buildPopoverEl = (pin: Pin): HTMLElement => {
  const el = document.createElement("div");
  el.className = "reaction-fan";
  REACTIONS.forEach((r, i) => {
    const btn = document.createElement("button");
    btn.className = "reaction-btn";
    if (currentMyReaction(pin.id) === r.kind) btn.classList.add("reacted");
    btn.title = r.label;
    btn.style.setProperty("--angle", FAN_ANGLES[i]);
    const emojiSpan = document.createElement("span");
    emojiSpan.className = "reaction-emoji";
    emojiSpan.textContent = r.emoji;
    const countSpan = document.createElement("span");
    countSpan.className = "reaction-count";
    countSpan.textContent = String(pin[r.kind]);
    btn.appendChild(emojiSpan);
    btn.appendChild(countSpan);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void reactTo(pin.id, r.kind);
    });
    el.appendChild(btn);
  });
  el.addEventListener("click", (ev) => ev.stopPropagation());
  if (HAS_HOVER) {
    el.addEventListener("mouseenter", cancelClose);
    el.addEventListener("mouseleave", scheduleClose);
  }
  return el;
};

const openPopover = (pinId: number) => {
  if (!map) return;
  const pin = pinsById.get(pinId);
  if (!pin) return;

  // Same pin: if a close animation is running, cancel it and pop back out.
  if (activePopover?.pinId === pinId) {
    const el = activePopover.marker.getElement();
    if (el.classList.contains("closing")) {
      el.classList.remove("closing");
      cancelCloseAnim();
    }
    return;
  }

  // Different pin: if the previous is mid-close, drop it instantly (no
  // point animating something the user is moving away from).
  if (activePopover) {
    cancelCloseAnim();
    activePopover.marker.remove();
    activePopover = null;
  }

  const el = buildPopoverEl(pin);
  const marker = new Marker({ element: el, anchor: "center", offset: [0, 0] })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);
  activePopover = { marker, pinId };
};

const refreshOpenPopover = () => {
  if (!activePopover) return;
  const pin = pinsById.get(activePopover.pinId);
  if (!pin) return;
  const el = activePopover.marker.getElement();
  const current = currentMyReaction(pin.id);
  const buttons = el.querySelectorAll<HTMLButtonElement>(".reaction-btn");
  buttons.forEach((btn, i) => {
    const r = REACTIONS[i];
    if (!r) return;
    btn.classList.toggle("reacted", current === r.kind);
    const countEl = btn.querySelector(".reaction-count");
    if (countEl) countEl.textContent = String(pin[r.kind]);
  });
};

const reactTo = async (pinId: number, kind: ReactionKind) => {
  const pin = pinsById.get(pinId);
  if (!pin) return;

  const prevKind = currentMyReaction(pinId);
  const isToggleOff = prevKind === kind;

  // Optimistic snapshot for potential rollback.
  const snapshot = { legit: pin.legit, dispute: pin.dispute, protip: pin.protip };

  // Apply optimistically: remove prev, add new (unless toggling off).
  if (prevKind) pin[prevKind] = Math.max(0, pin[prevKind] - 1);
  if (!isToggleOff) pin[kind]++;
  if (prevKind) myReactions.delete(myKey(pinId, prevKind));
  if (!isToggleOff) myReactions.add(myKey(pinId, kind));
  saveMine(myReactions);
  refreshOpenPopover();

  try {
    const res = await fetch(`/api/pins/${pinId}/reactions`, {
      method: isToggleOff ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { reactions: { legit: number; dispute: number; protip: number } };
    pin.legit = data.reactions.legit;
    pin.dispute = data.reactions.dispute;
    pin.protip = data.reactions.protip;
    refreshOpenPopover();
  } catch (err) {
    // Roll back counts and localStorage.
    pin.legit = snapshot.legit;
    pin.dispute = snapshot.dispute;
    pin.protip = snapshot.protip;
    if (prevKind) myReactions.add(myKey(pinId, prevKind));
    if (!isToggleOff) myReactions.delete(myKey(pinId, kind));
    saveMine(myReactions);
    refreshOpenPopover();
    console.error("react failed", err);
  }
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
    // Map click cascade: dismiss any transient UI first (popover, search
    // callout). Only fall through to "drop new pin" on a clean click.
    if (activePopover) {
      closePopover();
      return;
    }
    if (searchMarker) {
      closeSearchMarker();
      return;
    }
    pendingPin.value = { lat: e.lngLat.lat, lng: e.lngLat.lng };
  });
});

const closeSearchMarker = () => {
  if (searchMarker) {
    for (const m of searchMarker.markers) m.remove();
    searchMarker = null;
  }
};

const openReviewFromSearch = () => {
  if (!searchMarker) return;
  const { lat, lng, name } = searchMarker;
  pendingPin.value = { lat, lng, placeName: name };
  closeSearchMarker();
};

const onSearchSelect = ({
  lat,
  lng,
  name,
}: {
  lat: number;
  lng: number;
  name: string;
}) => {
  if (!map) return;
  map.easeTo({ center: [lng, lat], zoom: 17, duration: 800 });
  closeSearchMarker();

  // Outer div is what MapLibre positions via transform; inner div carries
  // our own animation transform. Without this split, the animation's
  // `transform: scale(...)` clobbers MapLibre's `translate3d` and the pill
  // ends up glued to the map container's top-left instead of the coord.
  const outer = document.createElement("div");
  outer.addEventListener("click", (e) => e.stopPropagation());

  const inner = document.createElement("div");
  inner.className = "search-target";

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "search-target-cta";
  cta.textContent = "Rate this spot?";
  cta.setAttribute("title", name);
  cta.addEventListener("click", (e) => {
    e.stopPropagation();
    openReviewFromSearch();
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "search-target-close";
  close.setAttribute("aria-label", "Cancel");
  close.textContent = "✕";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSearchMarker();
  });

  inner.appendChild(cta);
  inner.appendChild(close);
  outer.appendChild(inner);
  const wrapMarker = new Marker({ element: outer, anchor: "center" })
    .setLngLat([lng, lat])
    .addTo(map);

  searchMarker = { markers: [wrapMarker], lat, lng, name };
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key !== "Escape") return;
  if (pendingPin.value) pendingPin.value = null;
  else if (activePopover) closePopover();
  else if (searchMarker) closeSearchMarker();
};
watch(pendingPin, (v) => {
  if (v) closePopover();
});
onMounted(() => window.addEventListener("keydown", onKeydown));

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  closePopover();
  closeSearchMarker();
  for (const { emoji, text } of pinMarkers.values()) {
    emoji.remove();
    text.remove();
  }
  pinMarkers.clear();
  pinsById.clear();
  map?.remove();
  map = null;
});
</script>

<template>
  <Logo />
  <SearchBar @select="onSearchSelect" />
  <div class="hint">Tap the map · brutally honest, 8 words max</div>
  <div ref="mapEl" style="width: 100%; height: 100%"></div>
  <PinModal
    v-if="pendingPin"
    :lat="pendingPin.lat"
    :lng="pendingPin.lng"
    :place-name="pendingPin.placeName"
    @cancel="pendingPin = null"
    @submit="submitPin"
  />
</template>
