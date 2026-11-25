/*
 * Canonical plan metadata (.ppm/<plan>/metadata.json), shared by the Node CLI and the browser panel.
 * Canonical timestamps (created-at, updated-at, change-log keys): "DD-MM-YYYY HH:MM", UTC implied.
 * Browser: window.PpmMetadata. Node: module.exports.
 */
(function () {
  "use strict";

  var CANONICAL = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;
  // Legacy ISO 8601 or date-only (same shape the dashboard accepted). Time without zone is UTC.
  var LEGACY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

  // Real Gregorian check: rejects 30 Feb, 29 Feb in non-leap years, hour 24, minute 60.
  // setUTCFullYear keeps years 0001-0099 literal (Date.UTC would map them to 1900+).
  function epochOf(year, month, day, hour, minute, second, offset) {
    if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
    var date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.getTime() - offset * 60000;
  }

  function parseCanonical(value) {
    var match = typeof value === "string" ? CANONICAL.exec(value) : null;
    return match ? epochOf(+match[3], +match[2], +match[1], +match[4], +match[5], 0, 0) : null;
  }

  function offsetMinutes(zone) {
    if (!zone || zone === "Z") return 0;
    var match = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return null;
    return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  }

  function parseLegacy(text) {
    var match = LEGACY.exec(text);
    var offset = match ? offsetMinutes(match[7]) : null;
    if (offset === null) return null;
    return epochOf(+match[1], +match[2], +match[3], +(match[4] || 0), +(match[5] || 0), +(match[6] || 0), offset);
  }

  // UTC epoch milliseconds for a canonical or legacy ISO/date string; null otherwise.
  function metadataTimestamp(value) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    var canonical = parseCanonical(text);
    return canonical !== null ? canonical : parseLegacy(text);
  }

  // Canonical "DD-MM-YYYY HH:MM" for a string (canonical or legacy) or an epoch ms number; minute precision.
  function formatMetadataTimestamp(value) {
    var epoch = typeof value === "number" ? value : metadataTimestamp(value);
    if (epoch === null || !Number.isFinite(epoch)) return null;
    var date = new Date(Math.floor(epoch / 60000) * 60000);
    var year = date.getUTCFullYear();
    if (isNaN(date.getTime()) || year < 1 || year > 9999) return null;
    var iso = date.toISOString();
    return iso.slice(8, 10) + "-" + iso.slice(5, 7) + "-" + iso.slice(0, 4) + " " + iso.slice(11, 16);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function filled(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  // Strict: throws one error listing every problem, prefixed "metadata.json". Unknown fields pass through untouched.
  function validateMetadata(metadata) {
    if (!isObject(metadata)) throw new Error("metadata.json: root must be a JSON object");
    var problems = [];
    if (!filled(metadata.title)) problems.push("title must be a non-empty string");
    ["created-at", "updated-at"].forEach(function (key) {
      if (parseCanonical(metadata[key]) === null) problems.push(key + " must be a DD-MM-YYYY HH:MM timestamp");
    });
    if ("base-commit" in metadata && !filled(metadata["base-commit"])) problems.push("base-commit must be a non-empty string when present");
    if (!isObject(metadata.files)) problems.push("files must be an object");
    else Object.keys(metadata.files).forEach(function (key) {
      // Paths are informational only: no filesystem access, no shape check beyond non-empty.
      if (!key.trim() || !filled(metadata.files[key])) problems.push("files." + key + " must map a non-empty key to a non-empty string path");
    });
    if (!isObject(metadata["change-log"])) problems.push("change-log must be an object");
    else Object.keys(metadata["change-log"]).forEach(function (key) {
      if (parseCanonical(key) === null) problems.push("change-log key must be DD-MM-YYYY HH:MM: " + key);
      if (!filled(metadata["change-log"][key])) problems.push("change-log." + key + " must be a non-empty string");
    });
    if (problems.length) throw new Error("metadata.json: " + problems.join("; "));
    return metadata;
  }

  var api = { validateMetadata: validateMetadata, metadataTimestamp: metadataTimestamp, formatMetadataTimestamp: formatMetadataTimestamp };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PpmMetadata = api;
})();
