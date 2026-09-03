function fetchData(): unknown {
  throw new Error('unimplemented');
}

function writeData(): void {
  throw new Error('unimplemented');
}

function load() {
  try {
    return fetchData();
  } catch {}
}

function save() {
  try {
    writeData();
  } catch (e) {
    /* ignore */
  }
}

function update() {
  try {
    writeData();
  } catch (error) {
    // silently ignore
  }
}

function loopContinue() {
  for (const x of []) {
    try {
      writeData();
    } catch {
      continue;
    }
  }
}

function loopBreak() {
  for (const x of []) {
    try {
      writeData();
    } catch {
      break;
    }
  }
}

function bareReturn() {
  try {
    writeData();
  } catch {
    return;
  }
}

declare function getUser(): Promise<string>;
declare function onFulfilled(value: string): void;

function promiseHandlers() {
  getUser().catch(() => {});
  getUser().catch(function() {});
  getUser().catch(() => { ; });
  getUser().catch((err) => { err; });
  getUser().then(onFulfilled, () => {});
  getUser().then(onFulfilled, function() {});
  getUser().then(onFulfilled, (err) => { err; });
  getUser().catch(() => { return; });
  getUser().then(onFulfilled, () => { return; });
}
