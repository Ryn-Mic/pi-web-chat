/* Older workers cached all navigations, including authenticated API responses.
 * Remove only that legacy cache on activation; app precache stays available
 * offline, and unrelated same-origin caches are not touched. */
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.delete("pi-web-html"));
});
