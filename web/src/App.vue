<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { Map as MLMap, Marker, NavigationControl, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Supercluster from "supercluster";
import type { AnyProps, ClusterFeature, PointFeature } from "supercluster";
import PinModal from "./components/PinModal.vue";
import CuisineLegend from "./components/CuisineLegend.vue";
import { CUISINES, categoryToCuisine, cuisineMeta, type Cuisine } from "./cuisine";

type Pin = {
  id: number;
  lat: number;
  lng: number;
  tag: string;
  rating: number;
  created_at: number;
  place_id?: string | null;
};

type Place = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  address: string | null;
};

type Pending = {
  lat: number;
  lng: number;
  placeId?: string;
  placeName?: string;
  placeCategory?: string;
  placeAddress?: string;
};

type PlaceProps = {
  id: string;
  name: string;
  category: string;
  address: string;
  cuisine: Cuisine;
};

const MILWAUKEE: [number, number] = [-87.9065, 43.0389];
// Also the seed script bbox — load all Milwaukee places once.
const MILWAUKEE_BBOX = { minLng: -88.1, minLat: 42.9, maxLng: -87.85, maxLat: 43.2 };

const mapEl = ref<HTMLDivElement | null>(null);
const pendingPin = ref<Pending | null>(null);
const activeCuisines = ref<Set<Cuisine>>(new Set(CUISINES.map((c) => c.cuisine)));

let map: MLMap | null = null;
const pinMarkers = new Map<number, Marker>();
const placeMarkers = new Map<string, Marker>();

// One supercluster per cuisine, so places of different types never merge.
const clusters = new Map<Cuisine, Supercluster<PlaceProps, AnyProps>>();

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const renderPin = (pin: Pin) => {
  if (!map || pinMarkers.has(pin.id)) return;
  const stars = "★".repeat(pin.rating) + "☆".repeat(5 - pin.rating);
  const html = `
    <div class="popup-tag">${escapeHtml(pin.tag)}</div>
    <div class="popup-rating">${stars}</div>
  `;
  const popup = new Popup({ offset: 24, closeButton: false }).setHTML(html);
  const marker = new Marker({ color: "#e63946" })
    .setLngLat([pin.lng, pin.lat])
    .setPopup(popup)
    .addTo(map);
  pinMarkers.set(pin.id, marker);
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

const loadPlacesOnce = async () => {
  const q = new URLSearchParams({
    minLng: String(MILWAUKEE_BBOX.minLng),
    minLat: String(MILWAUKEE_BBOX.minLat),
    maxLng: String(MILWAUKEE_BBOX.maxLng),
    maxLat: String(MILWAUKEE_BBOX.maxLat),
  });
  const res = await fetch(`/api/places?${q}`);
  if (!res.ok) return;
  const places: Place[] = await res.json();

  const byCuisine = new Map<Cuisine, PointFeature<PlaceProps>[]>();
  for (const p of places) {
    const cuisine = categoryToCuisine(p.category);
    if (!cuisine) continue;
    let bucket = byCuisine.get(cuisine);
    if (!bucket) {
      bucket = [];
      byCuisine.set(cuisine, bucket);
    }
    bucket.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        category: p.category ?? "",
        address: p.address ?? "",
        cuisine,
      },
    });
  }

  clusters.clear();
  for (const [cuisine, features] of byCuisine) {
    const sc = new Supercluster<PlaceProps, AnyProps>({
      radius: 100,
      maxZoom: 16,
      minPoints: 2,
    });
    sc.load(features);
    clusters.set(cuisine, sc);
  }

  renderClusters();
};

const renderClusters = () => {
  if (!map) return;
  const b = map.getBounds();
  const bbox: [number, number, number, number] = [
    b.getWest(),
    b.getSouth(),
    b.getEast(),
    b.getNorth(),
  ];
  const zoom = Math.round(map.getZoom());
  const SINGLES_MIN_ZOOM = 14;

  const desired = new Set<string>();
  const nextFeatures: {
    key: string;
    cuisine: Cuisine;
    lng: number;
    lat: number;
    count: number | null;
    clusterId: number | null;
    place: PlaceProps | null;
  }[] = [];

  for (const [cuisine, sc] of clusters) {
    if (!activeCuisines.value.has(cuisine)) continue;
    const results = sc.getClusters(bbox, zoom);
    for (const f of results) {
      const [lng, lat] = f.geometry.coordinates;
      const isCluster = "cluster" in f.properties && f.properties.cluster === true;
      if (isCluster) {
        const cf = f as ClusterFeature<AnyProps>;
        const key = `c-${cuisine}-${cf.properties.cluster_id}`;
        desired.add(key);
        nextFeatures.push({
          key,
          cuisine,
          lng,
          lat,
          count: cf.properties.point_count as number,
          clusterId: cf.properties.cluster_id as number,
          place: null,
        });
      } else {
        if (zoom < SINGLES_MIN_ZOOM) continue;
        const pf = f as PointFeature<PlaceProps>;
        const key = `p-${pf.properties.id}`;
        desired.add(key);
        nextFeatures.push({
          key,
          cuisine,
          lng,
          lat,
          count: null,
          clusterId: null,
          place: pf.properties,
        });
      }
    }
  }

  // Remove markers no longer visible.
  for (const [key, marker] of placeMarkers) {
    if (!desired.has(key)) {
      marker.remove();
      placeMarkers.delete(key);
    }
  }

  // Add markers that appeared.
  for (const item of nextFeatures) {
    if (placeMarkers.has(item.key)) continue;
    const meta = cuisineMeta(item.cuisine);
    const el = document.createElement("div");
    el.className = item.count ? "cuisine-marker cluster" : "cuisine-marker single";
    el.style.setProperty("--cuisine-color", meta.color);
    if (item.count) {
      el.innerHTML =
        `<span class="marker-emoji">${meta.emoji}</span>` +
        `<span class="marker-count">${item.count}</span>`;
      el.setAttribute("aria-label", `${item.count} ${meta.label} places`);
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!map || item.clusterId == null) return;
        const sc = clusters.get(item.cuisine);
        if (!sc) return;
        const targetZoom = Math.min(sc.getClusterExpansionZoom(item.clusterId), 18);
        map.easeTo({ center: [item.lng, item.lat], zoom: targetZoom, duration: 400 });
      });
    } else if (item.place) {
      el.innerHTML = `<span class="marker-emoji">${meta.emoji}</span>`;
      el.setAttribute("aria-label", `${item.place.name} (${meta.label})`);
      el.title = item.place.name;
      const place = item.place;
      const lng = item.lng;
      const lat = item.lat;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pendingPin.value = {
          lat,
          lng,
          placeId: place.id,
          placeName: place.name,
          placeCategory: place.category,
          placeAddress: place.address,
        };
      });
    }
    const marker = new Marker({ element: el }).setLngLat([item.lng, item.lat]).addTo(map);
    placeMarkers.set(item.key, marker);
  }
};

const debounce = <F extends (...a: never[]) => void>(fn: F, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const submitPin = async ({ tag, rating }: { tag: string; rating: number }) => {
  if (!pendingPin.value) return;
  const { lat, lng, placeId } = pendingPin.value;
  try {
    const res = await fetch("/api/pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat, lng, tag, rating, placeId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      alert(`Could not save: ${err.error ?? res.statusText}`);
      return;
    }
    const pin: Pin = await res.json();
    renderPin(pin);
  } catch (err) {
    console.error(err);
    alert("Network error saving pin.");
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
    loadPlacesOnce();
  });

  map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";

  const debouncedRender = debounce(renderClusters, 80);
  map.on("moveend", debouncedRender);
  map.on("zoomend", debouncedRender);

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

watch(activeCuisines, () => renderClusters());

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  for (const m of placeMarkers.values()) m.remove();
  placeMarkers.clear();
  clusters.clear();
  map?.remove();
  map = null;
  pinMarkers.clear();
});
</script>

<template>
  <div class="header">grubmaps · milwaukee</div>
  <div class="hint">Tap an emoji to rate that spot · tap the map to add anywhere</div>
  <CuisineLegend v-model:active="activeCuisines" />
  <div ref="mapEl" style="width: 100%; height: 100%"></div>
  <PinModal
    v-if="pendingPin"
    :lat="pendingPin.lat"
    :lng="pendingPin.lng"
    :place-name="pendingPin.placeName"
    :place-category="pendingPin.placeCategory"
    :place-address="pendingPin.placeAddress"
    @cancel="pendingPin = null"
    @submit="submitPin"
  />
</template>
