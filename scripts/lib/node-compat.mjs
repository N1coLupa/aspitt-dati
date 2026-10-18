import module from 'node:module';

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof process.getBuiltinModule !== 'function') {
  const require = module.createRequire(import.meta.url);
  process.getBuiltinModule = (id) => require(id.startsWith('node:') ? id : `node:${id}`);
}
