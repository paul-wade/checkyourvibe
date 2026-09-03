function load() {
  try {
    return fetchData();
  } catch (e) {
    throw e;
  }
}

function save() {
  try {
    writeData();
  } catch (err) {
    throw err;
  }
}

declare function fetchData(): string;
declare function writeData(): string;
