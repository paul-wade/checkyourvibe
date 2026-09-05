declare function fetchData(): Promise<void>;
declare function getUser(): Promise<string>;

declare function onFulfilled(value: string): void;
declare function onRejected(err: unknown): void;

async function awaited() {
  await fetchData();
  await getUser();
  await Promise.all([fetchData(), getUser()]);
}

function returned(): Promise<string> {
  return getUser();
}

function assigned() {
  const p = fetchData();
  return p;
}

function handled() {
  getUser().catch(onRejected);
  getUser().then(onFulfilled, onRejected);
}

function discarded() {
  void fetchData(); // intentionally fire-and-forget
}

// `void` in front of an already-handled chain. The rejection handler is the
// evidence of intent that a bare `void` lacks, so requiring a comment as well
// would report a promise whose failure path is already written down.
function discardedButHandled() {
  void getUser().catch(onRejected);
  void getUser().then(onFulfilled, onRejected);
}

function passedToConsumer() {
  return Promise.all([fetchData(), getUser()]);
}
