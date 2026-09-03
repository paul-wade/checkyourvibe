console.log('message');
console.error(new Error('fail'));
console.warn('caution');
console.debug('details');
console.info('note');
console.trace('here');
console.table([{ a: 1 }]);
console.dir({ x: 1 });
console.group('section');
console.time('timer');
const { log, warn, error: err } = console;
log('destructured');
warn('destructured warn');
err('destructured error');

const c = console;
c.log('aliased object');
const emit = console.log;
emit('aliased method');
