function fetchData(): unknown {
  throw new Error('unimplemented');
}

function writeData(): void {
  throw new Error('unimplemented');
}

function logError(message: string, error: unknown): void {
  throw new Error('unimplemented');
}

function doSomething(): void {
  throw new Error('unimplemented');
}

function handleError(error: unknown): void {
  throw new Error('unimplemented');
}

function onFulfilled(value: string): void {
  throw new Error('unimplemented');
}

function load() {
  try {
    return fetchData();
  } catch (e) {
    throw new Error('failed to load', { cause: e });
  }
}

function save() {
  try {
    writeData();
  } catch (e) {
    logError('save failed', e);
    return { ok: false };
  }
}

function attempt() {
  try {
    return writeData();
  } catch (e) {
    // log and keep going is still handling
    logError('attempt failed', e);
  }
}

function loopAndContinue() {
  for (const x of []) {
    try {
      writeData();
    } catch (e) {
      logError('loop item failed', e);
      continue;
    }
  }
}

function loopAndBreak() {
  for (const x of []) {
    try {
      writeData();
    } catch (e) {
      logError('loop failed', e);
      break;
    }
  }
}

function returnFallback(): { ok: boolean } {
  try {
    return { ok: true };
  } catch (e) {
    logError('failed', e);
    return { ok: false };
  }
}

declare function getUser(): Promise<string>;
declare const notPromise: {
  catch: (handler: () => void) => void;
  then: (onFulfilled: (value: string) => void, onRejected: () => void) => void;
};

let state: { hasError: boolean } = { hasError: false };

function handledPromises() {
  getUser().catch((err) => console.error(err));
  getUser().catch((err) => {
    throw err;
  });
  getUser().catch(() => {
    return 'fallback';
  });
  getUser().catch(() => {
    doSomething();
  });
  getUser().catch(() => {
    state.hasError = true;
  });
  getUser().catch(handleError);
  getUser().then(onFulfilled, (err) => {
    return err;
  });
  notPromise.catch(() => {});
  notPromise.then(onFulfilled, () => {});
}
