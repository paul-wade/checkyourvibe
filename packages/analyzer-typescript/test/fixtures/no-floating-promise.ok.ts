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

function passedToConsumer() {
  return Promise.all([fetchData(), getUser()]);
}
