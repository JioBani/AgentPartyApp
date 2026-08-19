/**
 * Gives long-lived renderer components one action object while dispatching each
 * call to the latest implementation. App actions close over current React
 * state, so freezing the original object would make callbacks stale; passing a
 * newly allocated object on every render defeats memoization instead.
 */
export function createLatestMethodProxy<T extends object>(readLatest: () => T): T {
  const delegates = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy({} as T, {
    get(_target, property) {
      let delegate = delegates.get(property);
      if (!delegate) {
        delegate = (...args: unknown[]) => {
          const current = readLatest();
          const method = Reflect.get(current, property);
          if (typeof method !== "function") {
            throw new TypeError(`Latest action '${String(property)}' is not callable.`);
          }
          return Reflect.apply(method, current, args);
        };
        delegates.set(property, delegate);
      }
      return delegate;
    },
  });
}
