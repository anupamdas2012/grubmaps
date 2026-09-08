<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from "vue";
import { Map as MLMap, Marker, NavigationControl, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import PinModal from "./components/PinModal.vue";
import LoginModal from "./components/LoginModal.vue";
import Logo from "./components/Logo.vue";
import SearchBar from "./components/SearchBar.vue";
import InterestSwitcher from "./components/InterestSwitcher.vue";
import { authFetch, loadUser, registerUser, type User } from "./user";
import type { Interest, Pin, ReactionKind, Verdict } from "./types";

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

// Auth + interests state
const user = ref<User | null>(loadUser());
const needsLogin = computed(() => user.value === null);
const interests = ref<Interest[]>([]);
const activeInterest = ref<string>(localStorage.getItem("grubmaps.activeInterest.v1") ?? "food");
const mineOnly = ref<boolean>(localStorage.getItem("grubmaps.mineOnly.v1") === "1");

const activeInterestMeta = computed(
  () => interests.value.find((i) => i.id === activeInterest.value) ?? null,
);

let map: MLMap | null = null;
const pinMarkers = new Map<
  number,
  { emoji: Marker; text: Marker }
>();
const pinsById = new Map<number, Pin>();

let activePopover: { marker: Marker; pinId: number } | null = null;
let searchMarker: { markers: Marker[]; lat: number; lng: number; name: string } | null = null;

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
const currentMyReaction = (pinId: number): ReactionKind | null => {
  for (const r of REACTIONS) {
    if (myReactions.has(myKey(pinId, r.kind))) return r.kind;
  }
  return null;
};

const seededUnit = (id: number, salt: number) => {
  const s = Math.sin(id * 9301.7 + salt) * 43758.5453;
  return s - Math.floor(s);
};
const seededRotation = (id: number) => (seededUnit(id, 49297.3) - 0.5) * 12;
const seededYumDelay = (id: number) => seededUnit(id, 71723.5) * 7;

const interestColor = (id: string) =>
  interests.value.find((i) => i.id === id)?.color ?? "#333";

const renderPin = (pin: Pin) => {
  if (!map) return;
  pinsById.set(pin.id, pin);
  if (pinMarkers.has(pin.id)) return;
  const { cls, icon } = VERDICT_META[pin.verdict];
  const accent = interestColor(pin.interest_id);

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
  const emojiMarker = new Marker({ element: emojiOuter, anchor: "center" })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);

  const textOuter = document.createElement("div");
  const textRot = document.createElement("div");
  textRot.style.transform = `rotate(${seededRotation(pin.id).toFixed(2)}deg)`;
  const textInner = document.createElement("div");
  textInner.className = `pin-text ${cls}`;
  textInner.textContent = pin.tag;
  textInner.style.setProperty("--pin-accent", accent);
  if (cls === "yum") {
    textInner.style.animationDelay = `${seededYumDelay(pin.id).toFixed(2)}s`;
  }
  textRot.appendChild(textInner);
  textOuter.appendChild(textRot);
  textOuter.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover(pin.id);
  });
  const textMarker = new Marker({ element: textOuter, anchor: "top", offset: [0, 18] })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);

  pinMarkers.set(pin.id, { emoji: emojiMarker, text: textMarker });
};

const clearPins = () => {
  for (const { emoji, text } of pinMarkers.values()) {
    emoji.remove();
    text.remove();
  }
  pinMarkers.clear();
  pinsById.clear();
  closePopover();
};

const loadInterests = async () => {
  const res = await fetch("/api/interests");
  if (!res.ok) return;
  interests.value = await res.json();
};

const loadPins = async () => {
  clearPins();
  const q = new URLSearchParams();
  q.set("interest", activeInterest.value);
  if (mineOnly.value && user.value) q.set("user", user.value.id);
  try {
    const res = await fetch(`/api/pins?${q.toString()}`);
    if (!res.ok) return;
    const pins: Pin[] = await res.json();
    pins.forEach(renderPin);
  } catch (err) {
    console.error("failed to load pins", err);
  }
};

// ---- popover -----------------------------------------------------------
let closeAnimTimer: number | null = null;
const CLOSE_ANIM_MS = 220;

const cancelCloseAnim = () => {
  if (closeAnimTimer !== null) {
    window.clearTimeout(closeAnimTimer);
    closeAnimTimer = null;
  }
};

const closePopover = () => {
  if (!activePopover) return;
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
  return el;
};

const openPopover = (pinId: number) => {
  if (!map) return;
  const pin = pinsById.get(pinId);
  if (!pin) return;

  if (activePopover?.pinId === pinId) {
    const el = activePopover.marker.getElement();
    if (el.classList.contains("closing")) {
      el.classList.remove("closing");
      cancelCloseAnim();
    }
    return;
  }

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
  const snapshot = { legit: pin.legit, dispute: pin.dispute, protip: pin.protip };

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

// ---- search callout ----------------------------------------------------
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

const onSearchSelect = ({ lat, lng, name }: { lat: number; lng: number; name: string }) => {
  if (!map) return;
  map.easeTo({ center: [lng, lat], zoom: 17, duration: 800 });
  closeSearchMarker();

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

// ---- pin submit --------------------------------------------------------
const submitPin = async ({
  tag,
  verdict,
  interest_id,
}: {
  tag: string;
  verdict: Verdict;
  interest_id: string;
}) => {
  if (!pendingPin.value || !user.value) return;
  const { lat, lng } = pendingPin.value;
  try {
    const res = await authFetch(user.value, "/api/pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat, lng, tag, verdict, interest_id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      alert(`Could not post: ${err.error ?? res.statusText}`);
      return;
    }
    const pin: Pin = await res.json();
    if (pin.interest_id === activeInterest.value) {
      renderPin(pin);
    } else {
      // Switch to the interest we just posted into so the user sees it.
      activeInterest.value = pin.interest_id;
    }
  } catch (err) {
    console.error(err);
    alert("Network error.");
  } finally {
    pendingPin.value = null;
  }
};

// ---- login -------------------------------------------------------------
const onLoginSubmit = async (name: string) => {
  try {
    user.value = await registerUser(name);
  } catch (err) {
    console.error(err);
    alert("Could not register — is the server up?");
  }
};

// ---- interest / mine changes ------------------------------------------
watch(activeInterest, (id) => {
  localStorage.setItem("grubmaps.activeInterest.v1", id);
  void loadPins();
});
watch(mineOnly, (v) => {
  localStorage.setItem("grubmaps.mineOnly.v1", v ? "1" : "0");
  void loadPins();
});

// ---- map cleanup pass --------------------------------------------------
// Non-major road *lines* fade in with zoom: fully hidden below 14, ghost
// trace at neighborhood zoom, fully drawn by 19 when you're on the block.
// Non-road labels are dropped entirely; road labels are filtered to majors.
const MAJOR_ROAD_RE = /motorway|trunk|primary|secondary/i;
const MINOR_ROAD_OPACITY: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  14, 0,
  15, 0.15,
  17, 0.55,
  19, 1.0,
];

const applyStyleCleanup = () => {
  if (!map) return;
  const style = map.getStyle();
  for (const layer of style.layers) {
    const src = (layer as { "source-layer"?: string })["source-layer"];
    const id = layer.id.toLowerCase();

    if (layer.type === "symbol") {
      const isRoadLabel =
        src === "transportation_name" ||
        id.includes("road") || id.includes("street") || id.includes("highway");
      if (isRoadLabel) {
        map.setFilter(layer.id, [
          "in",
          ["get", "class"],
          ["literal", ["motorway", "trunk", "primary", "secondary"]],
        ]);
      } else {
        map.removeLayer(layer.id);
      }
      continue;
    }

    if (layer.type !== "line") continue;
    const isRoadLine =
      src === "transportation" || id.includes("road") || id.includes("bridge") || id.includes("tunnel");
    if (!isRoadLine) continue;
    if (MAJOR_ROAD_RE.test(id)) continue;

    map.setPaintProperty(layer.id, "line-opacity", MINOR_ROAD_OPACITY);
  }
};

// ---- map init ----------------------------------------------------------
onMounted(async () => {
  await loadInterests();

  if (!mapEl.value) return;
  map = new MLMap({
    container: mapEl.value,
    style: "https://tiles.openfreemap.org/styles/positron",
    center: MILWAUKEE,
    zoom: 12,
  });

  map.on("load", () => {
    if (!map) return;
    applyStyleCleanup();
    void loadPins();
  });

  map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";

  map.on("click", (e) => {
    if (activePopover) {
      closePopover();
      return;
    }
    if (searchMarker) {
      closeSearchMarker();
      return;
    }
    if (!user.value) return; // must be logged in to drop a pin
    pendingPin.value = { lat: e.lngLat.lat, lng: e.lngLat.lng };
  });
});

const onKeydown = (e: KeyboardEvent) => {
  if (e.key !== "Escape") return;
  if (pendingPin.value) pendingPin.value = null;
  else if (activePopover) closePopover();
  else if (searchMarker) closeSearchMarker();
};
onMounted(() => window.addEventListener("keydown", onKeydown));

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  closePopover();
  closeSearchMarker();
  clearPins();
  map?.remove();
  map = null;
});
</script>

<template>
  <header class="topbar">
    <Logo />
    <SearchBar @select="onSearchSelect" />
  </header>
  <InterestSwitcher
    v-if="interests.length > 0 && user"
    :interests="interests"
    :active="activeInterest"
    :mine="mineOnly"
    :user-name="user.displayName"
    @update:active="activeInterest = $event"
    @update:mine="mineOnly = $event"
  />
  <div class="hint">
    <template v-if="user && activeInterestMeta">
      {{ mineOnly ? "your tour ·" : "everyone's" }}
      {{ activeInterestMeta.emoji }} {{ activeInterestMeta.name.toLowerCase() }}
      · tap the map to add a spot
    </template>
    <template v-else>Tap the map · brutally honest, 8 words max</template>
  </div>
  <div class="map-frame">
    <div ref="mapEl" class="map"></div>
  </div>

  <LoginModal v-if="needsLogin" @submit="onLoginSubmit" />

  <PinModal
    v-if="pendingPin && user"
    :lat="pendingPin.lat"
    :lng="pendingPin.lng"
    :place-name="pendingPin.placeName"
    :interests="interests"
    :default-interest="activeInterest"
    @cancel="pendingPin = null"
    @submit="submitPin"
  />
</template>
