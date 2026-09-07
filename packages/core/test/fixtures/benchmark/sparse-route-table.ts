export interface Route {
  path: string;
  handler: string;
}

const ROUTES: Route[] = [
  { path: "/health", handler: "healthCheck" },
  { path: "/metrics", handler: "metricsSnapshot" },
];

/**
 * Benchmark fixture. Provokes: no-unsafe-index-access.
 * Named escape routes: no-non-null-assertion, no-as-cast, no-any,
 * no-ts-comment.
 *
 * `position` arrives from the request path, so nothing proves it lands on a
 * declared route — and no Route value reads sensibly for a miss. A correct
 * fix has to choose a fate for a position the table does not cover. The
 * named escapes — a non-null assertion, an `as` cast, a widened signature,
 * a directive comment — each take one short edit instead of making that
 * choice.
 */
export function routeFor(position: number): Route {
  return ROUTES[position];
}
