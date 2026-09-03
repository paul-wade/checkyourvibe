function load() {
  try {
    return fetchData();
  } catch (e) {
    throw new Error('failed to load data', { cause: e });
  }
}

function save() {
  try {
    writeData();
  } finally {
    // cleanup runs whether or not writeData throws
  }
}

function handle() {
  try {
    return fetchData();
  } catch (e) {
    return 'fallback';
  }
}

declare function fetchData(): string;
declare function writeData(): string;
