export interface Route {
  path: string;
  handler: string;
}

const ROUTES: Route[] = [
  { path: "/health", handler: "healthCheck" },
  { path: "/metrics", handler: "metricsSnapshot" },
];

export function routeFor(position: number): Route {
  const route = ROUTES[position];
  if (route === undefined) {
    throw new Error('Route not found');
  }
  return route;
}
