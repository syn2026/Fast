
const MAX_DELAY_MINUTES = 60;
const MAX_DELAY_MS = MAX_DELAY_MINUTES * 60 * 1000;

/* INPUTS */
const ideInput = document.getElementById("ideInput");
const dataFirstInput = document.getElementById("dataFirstInput");
const poiInput = document.getElementById("poiInput");
const processBtn = document.getElementById("processBtn");

/* GLOBAL STORAGE */
let POIS = [];
let ALGERIA_WILAYAS = [];

/* =========================================
   POINT IN POLYGON (FOR POI)
========================================= */
function isPointInPolygon(lat, lon, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];

    const xj = polygon[j][0];
    const yj = polygon[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 0.0000001) + xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

/* =========================================
   LOAD ALGERIA WILAYA GEOJSON
========================================= */
async function loadAlgeriaGeo() {
  try {
    const response = await fetch("./DATA/Willaya.geojson");
    

    if (!response.ok) {
      throw new Error("Cannot load data/willaya.geojson");
    }

    const geojson = await response.json();

    ALGERIA_WILAYAS = geojson.features || [];

    if (!ALGERIA_WILAYAS.length) {
      throw new Error("No Wilaya features found in GeoJSON");
    }

    console.log(
      "Algeria Wilayas loaded:",
      ALGERIA_WILAYAS.length
    );

    console.log(
      "Example Wilaya properties:",
      ALGERIA_WILAYAS[0]?.properties
    );

  } catch (error) {
    console.error("Algeria GeoJSON loading error:", error);
    throw error;
  }
}

/* =========================================
   POINT IN GEOJSON RING
   GEOJSON COORDINATES = [LONGITUDE, LATITUDE]
========================================= */
function isPointInGeoJSONRing(lat, lon, ring) {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; // Longitude
    const yi = ring[i][1]; // Latitude

    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 0.0000001) + xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

/* =========================================
   POINT IN GEOJSON POLYGON
   SUPPORTS POLYGON HOLES
========================================= */
function isPointInGeoJSONPolygon(lat, lon, polygon) {
  if (!polygon || !polygon.length) return false;

  // Check outer boundary
  if (!isPointInGeoJSONRing(lat, lon, polygon[0])) {
    return false;
  }

  // Exclude holes
  for (let i = 1; i < polygon.length; i++) {
    if (isPointInGeoJSONRing(lat, lon, polygon[i])) {
      return false;
    }
  }

  return true;
}

/* =========================================
   GET WILAYA FROM GEOJSON
========================================= */
function reverseGeocode(lat, lon) {
  const matched = ALGERIA_WILAYAS.find(feature => {
    const geometry = feature.geometry;

    if (!geometry) return false;

    let polygons = [];

    if (geometry.type === "Polygon") {
      polygons = [geometry.coordinates];
    } else if (geometry.type === "MultiPolygon") {
      polygons = geometry.coordinates;
    }

    return polygons.some(polygon =>
      isPointInGeoJSONPolygon(lat, lon, polygon)
    );
  });

  if (!matched) {
    return null;
  }

  const p = matched.properties || {};

  // Try common Wilaya property names
  const wilayaName =
    p.wilaya_name_fr ||
    p.WILAYA_NAME_FR ||
    p.name_fr ||
    p.NAME_FR ||
    p.NAME_1 ||
    p.name ||
    p.NAME ||
    p.wilaya ||
    p.WILAYA ||
    p.wilaya_name ||
    p.WILAYA_NAME ||
    p.nom ||
    p.NOM ||
    p.name_1;

  return wilayaName || null;
}

/* =========================================
   SAFE DATE PARSER
========================================= */
function parseDate(dateRaw) {
  if (typeof dateRaw !== "string") {
    return null;
  }

  const clean = dateRaw.trim();

  if (!clean) {
    return null;
  }

  const date = new Date(clean.replace(" ", "T"));

  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

/* =========================================
   PROCESS VEHICLE
========================================= */
async function processVehicle(f) {
  const longitude = Number(f.position?.LON ?? f.longitude);
  const latitude = Number(f.position?.LAT ?? f.latitude);

  const matricule =
    f.gps_alias ??
    f.matricule ??
    f.thing_matricule ??
    "N/A";

  const agence =
    f.car_group ??
    f.groupe_vehicule?.[0]?.thing_group_designation ??
    f.groupes?.map(g => g.groupe_designation).join(", ") ??
    "N/A";

  const dateRaw = f.position?.date ?? f.date_dernier_signal;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      Matricule: matricule,
      Agence: agence,
      Longitude: longitude,
      Latitude: latitude,
      Dernier_Date: dateRaw ?? null,
      Location: null,
      GPS_Status: "Coordonnées GPS invalides",
    };
  }

  const parsedDate = parseDate(dateRaw);

  let gpsStatus = "GPS actif";
  let location = null;

  if (parsedDate) {
    const diffMs = Date.now() - parsedDate.getTime();

    if (diffMs > MAX_DELAY_MS) {
      return {
        Matricule: matricule,
        Agence: agence,
        Longitude: longitude,
        Latitude: latitude,
        Dernier_Date: dateRaw,
        Location: null,
        GPS_Status: `GPS non actualisé depuis ${dateRaw}`,
      };
    }
  }

  /* CHECK POI */
  const matchedPOI = POIS.find((poi) =>
    Array.isArray(poi.points) &&
    isPointInPolygon(latitude, longitude, poi.points)
  );

  if (matchedPOI) {
    gpsStatus = "GPS actif (dans POI)";

    location = [
      matchedPOI.name,
      matchedPOI.commune,
      matchedPOI.wilaya,
    ]
      .filter(Boolean)
      .join(", ");

  } else {
    gpsStatus = "GPS actif (hors POI)";

    // LOCAL WILAYA LOOKUP - NO API REQUEST
    const wilaya = reverseGeocode(latitude, longitude);

    location = wilaya;
  }

  return {
    Matricule: matricule,
    Agence: agence,
    Longitude: longitude,
    Latitude: latitude,
    Dernier_Date: dateRaw ?? null,
    Location: location,
    GPS_Status: gpsStatus,
  };
}

/* =========================================
   MAIN PROCESS
========================================= */
processBtn.addEventListener("click", async () => {
  try {
    const ideFile = ideInput.files?.[0];
    const dataFirstFile = dataFirstInput.files?.[0];
    const poiFile = poiInput.files?.[0];

    if (!ideFile || !dataFirstFile || !poiFile) {
      alert("Please select all required files.");
      return;
    }

    processBtn.disabled = true;
    processBtn.textContent = "Processing...";

    /* LOAD INPUT FILES */
    const ideData = JSON.parse(await ideFile.text());
    const dataFirstData = JSON.parse(await dataFirstFile.text());

    POIS = JSON.parse(await poiFile.text());

    /* LOAD ALGERIA GEOJSON */
    await loadAlgeriaGeo();

    /* COMBINE FLEET DATA */
    const fleet = [
      ...(ideData?.fleet || []),
      ...(dataFirstData?.data || []),
    ];

    if (!fleet.length) {
      alert("No fleet data found.");
      return;
    }

    /* PROCESS VEHICLES */
    const fleetGPS = [];

    for (const f of fleet) {
      try {
        const result = await processVehicle(f);
        fleetGPS.push(result);
      } catch (err) {
        console.error("Error processing vehicle:", err);
      }
    }

    /* EXPORT EXCEL */
    const worksheet = XLSX.utils.json_to_sheet(fleetGPS);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      "FleetGPS"
    );

    XLSX.writeFile(workbook, "fleetGPS.xlsx");

    console.log("FINAL RESULT:", fleetGPS);

    alert("Excel exported successfully.");

  } catch (error) {
    console.error(error);
    alert("An error occurred while processing files.");
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = "Process";
  }
});
