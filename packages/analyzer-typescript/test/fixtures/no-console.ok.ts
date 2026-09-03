function run() {
  const console = { log(s: string) {}, warn(s: string) {} };
  console.log('shadowed');
  console.warn('also shadowed');
}

function log(s: string) {
  return s;
}

log('unrelated');
console.warn('allowed');
