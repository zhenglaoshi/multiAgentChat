export * from './types.js';
export * from './controller.js';
// registry 只导出生产需要的三个；resetHostForTests 走 './testing.js' 子路径，别加回来。
export { getHost, hasHost, setHost } from './registry.js';
export * from './facade.js';
