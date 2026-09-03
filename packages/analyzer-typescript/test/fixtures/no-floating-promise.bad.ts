declare function fetchData(): Promise<void>;
declare function getUser(): Promise<string>;

declare function onFulfilled(value: string): void;
declare function onRejected(err: unknown): void;

fetchData();
getUser().then(onFulfilled);
getUser().finally(() => {});
Promise.all([fetchData()]);
void fetchData();
